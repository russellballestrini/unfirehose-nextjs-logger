/**
 * The scrobble payload: lifetime stats, streaks, badges, activity shapes.
 *
 * Lives in core rather than the route because the worker precomputes it.
 * Built from two scans of `messages` — it used to be eight, for 11.6s per
 * cache miss — and even two is seconds against 1.6M rows, so a visitor
 * should never be the one paying for them.
 */

import type Database from 'better-sqlite3';
import { getDb } from './db/schema';
import { getSetting } from './db/ingest';
import { costForUsage } from './pricing';
import { ensurePricingHydrated } from './pricing-sync';
import { storePayload, readPayload } from './precomputed';

/* eslint-disable @typescript-eslint/no-explicit-any */

/** SQLite's strftime('%Y-W%W'): week 00 starts at the first Sunday of the year. */
function isoWeekKey(ts: string): string {
  const d = new Date(ts);
  const year = d.getUTCFullYear();
  const jan1 = Date.UTC(year, 0, 1);
  const firstSunday = jan1 + ((7 - new Date(jan1).getUTCDay()) % 7) * 86400000;
  const t = Date.UTC(year, d.getUTCMonth(), d.getUTCDate());
  const week = t < firstSunday ? 0 : Math.floor((t - firstSunday) / (7 * 86400000)) + 1;
  return `${year}-W${String(week).padStart(2, '0')}`;
}

export const SCROBBLE_CACHE_KEY = 'scrobble_payload';

/** Build the payload. Seconds of work; call it from the worker. */
export function buildScrobblePayload(db: Database.Database = getDb()): any {
  ensurePricingHydrated(db);
  const t = { mark: (_: string) => {} };

    const handle = getSetting('unfirehose_handle') ?? 'anonymous';
    const displayName = getSetting('unfirehose_display_name') ?? handle;

    const ninetyDaysAgo = new Date(Date.now() - 90 * 86400000).toISOString();
    const twelveWeeksAgo = new Date(Date.now() - 84 * 86400000).toISOString();

    // One scan of `messages`, four grouping columns.
    //
    // This route used to run five separate full scans of a 1.6M-row table —
    // models, lifetime, streaks, heatmap, daily — for 6.8s of an 11.6s
    // response. Every one of them is derivable from the same grouped rows:
    // (model, day, weekday, hour) collapses 1.6M messages to ~30k rows, and
    // the aggregates below are folded from those in memory.
    const grain = db.prepare(`
      -- substr, not strftime: our timestamps are ISO-8601 text, so the day
      -- and hour are already in the string. strftime reparses every one of
      -- 1.6M rows and cost 2.5s of this scan. The weekday still needs date
      -- arithmetic, so it is computed once per DAY in the fold below.
      SELECT model,
             substr(timestamp, 1, 10)               AS date,
             CAST(substr(timestamp, 12, 2) AS INTEGER) AS hour,
             COUNT(*)                     AS messages,
             SUM(input_tokens)            AS inp,
             SUM(output_tokens)           AS out,
             SUM(cache_read_tokens)       AS cr,
             SUM(cache_creation_tokens)   AS cw,
             MIN(timestamp)               AS first_ts,
             MAX(timestamp)               AS last_ts
        FROM messages
       WHERE timestamp IS NOT NULL
       GROUP BY model, date, hour
    `).all() as any[];
    t.mark('grain');

    // Per session, one row: harness, span and volume. Replaces three more
    // scans (harnesses, weekly velocity, average session length) and is the
    // only place a session-level DISTINCT is needed.
    const sessionRows = db.prepare(`
      SELECT s.id                          AS id,
             COALESCE(s.harness, 'claude-code') AS harness,
             COUNT(m.id)                    AS messages,
             MIN(m.timestamp)               AS first_ts,
             MAX(m.timestamp)               AS last_ts
        FROM sessions s
        JOIN messages m ON m.session_id = s.id
       GROUP BY s.id
    `).all() as any[];
    t.mark('sessions');

    let totalInput = 0, totalOutput = 0, totalCacheRead = 0, totalCacheWrite = 0, totalCost = 0;
    let totalMessages = 0;
    let firstActivity: string | null = null;
    let lastActivity: string | null = null;
    const costSplit = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
    const modelAgg = new Map<string, { model: string; messages: number; inputTokens: number; outputTokens: number }>();
    const activeDaySet = new Set<string>();
    const hourMap = new Map<number, number>();
    const dowMap = new Map<number, number>();
    const heatKey = new Map<string, { dow: number; hour: number; count: number }>();
    // Cost books at the price in force on the day the tokens were spent, so
    // the (model, day) pair is the unit — the finer hour grouping folds into
    // it first, otherwise a day's price would be applied 24 times.
    const modelDay = new Map<string, { model: string; date: string; inp: number; out: number; cr: number; cw: number; messages: number }>();

    // UTC weekday per calendar day, memoised — one Date construction per day
    // instead of per row.
    const dowCache = new Map<string, number>();
    const dowOf = (date: string) => {
      let d = dowCache.get(date);
      if (d === undefined) { d = new Date(`${date}T00:00:00Z`).getUTCDay(); dowCache.set(date, d); }
      return d;
    };

    for (const g of grain) {
      g.dow = dowOf(g.date);
      totalMessages += g.messages ?? 0;
      if (g.date) activeDaySet.add(g.date);
      if (g.first_ts && (!firstActivity || g.first_ts < firstActivity)) firstActivity = g.first_ts;
      if (g.last_ts && (!lastActivity || g.last_ts > lastActivity)) lastActivity = g.last_ts;

      hourMap.set(g.hour, (hourMap.get(g.hour) ?? 0) + g.messages);
      dowMap.set(g.dow, (dowMap.get(g.dow) ?? 0) + g.messages);
      const hk = `${g.dow}:${g.hour}`;
      const cell = heatKey.get(hk) ?? { dow: g.dow, hour: g.hour, count: 0 };
      cell.count += g.messages;
      heatKey.set(hk, cell);

      if (!g.model || g.model === '<synthetic>') continue;
      totalInput += g.inp ?? 0;
      totalOutput += g.out ?? 0;
      totalCacheRead += g.cr ?? 0;
      totalCacheWrite += g.cw ?? 0;
      const key = `${g.model}\u0000${g.date}`;
      const md = modelDay.get(key) ?? { model: g.model, date: g.date, inp: 0, out: 0, cr: 0, cw: 0, messages: 0 };
      md.inp += g.inp ?? 0; md.out += g.out ?? 0; md.cr += g.cr ?? 0; md.cw += g.cw ?? 0;
      md.messages += g.messages ?? 0;
      modelDay.set(key, md);
    }

    const dailyAgg: Record<string, { cost: number; count: number }> = {};
    for (const m of modelDay.values()) {
      const c = costForUsage({ model: m.model, input: m.inp, output: m.out, cacheRead: m.cr, cacheWrite: m.cw, at: m.date });
      totalCost += c.total;
      costSplit.input += c.input;
      costSplit.output += c.output;
      costSplit.cacheRead += c.cacheRead;
      costSplit.cacheWrite += c.cacheWrite;
      const prev = modelAgg.get(m.model) ?? { model: m.model, messages: 0, inputTokens: 0, outputTokens: 0 };
      prev.messages += m.messages;
      prev.inputTokens += m.inp;
      prev.outputTokens += m.out;
      modelAgg.set(m.model, prev);
      if (m.date >= ninetyDaysAgo.slice(0, 10)) {
        if (!dailyAgg[m.date]) dailyAgg[m.date] = { cost: 0, count: 0 };
        dailyAgg[m.date].cost += c.total;
        dailyAgg[m.date].count += m.messages;
      }
    }
    const models = [...modelAgg.values()].sort((a, b) => b.messages - a.messages);
    const heatmapRows = [...heatKey.values()];

    const lifetime = {
      total_sessions: sessionRows.length,
      total_messages: totalMessages,
      active_days: activeDaySet.size,
      first_activity: firstActivity,
      last_activity: lastActivity,
    };

    const { currentStreak, longestStreak } = calcStreaks([...activeDaySet].sort().reverse());

    const hourActivity = [...hourMap.entries()].sort((a, b) => a[0] - b[0]).map(([hour, count]) => ({ hour, count }));
    const dowActivity = [...dowMap.entries()].sort((a, b) => a[0] - b[0]).map(([dow, count]) => ({
      day: ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][dow],
      count,
    }));

    const dailyCostSeries = Object.entries(dailyAgg)
      .map(([date, d]) => ({ date, costUSD: Math.round(d.cost * 100) / 100 }))
      .sort((a, b) => a.date.localeCompare(b.date));
    const dailyMessages = Object.entries(dailyAgg)
      .map(([date, d]) => ({ date, count: d.count }))
      .sort((a, b) => a.date.localeCompare(b.date));

    const harnessAgg = new Map<string, { harness: string; sessions: number; messages: number }>();
    // A session belongs to the week it last ran in. The old query counted a
    // session once per week it touched; on a 12-week window that double-counts
    // long-lived sessions, and the chart reads as velocity either way.
    const weekAgg = new Map<string, { week: string; sessions: number; messages: number }>();
    let durationSum = 0, durationCount = 0;
    for (const s0 of sessionRows) {
      const h = harnessAgg.get(s0.harness) ?? { harness: s0.harness, sessions: 0, messages: 0 };
      h.sessions += 1;
      h.messages += s0.messages ?? 0;
      harnessAgg.set(s0.harness, h);

      if (s0.messages > 1 && s0.first_ts && s0.last_ts) {
        durationSum += new Date(s0.last_ts).getTime() - new Date(s0.first_ts).getTime();
        durationCount += 1;
      }
      if (s0.last_ts && s0.last_ts >= twelveWeeksAgo) {
        const wk = isoWeekKey(s0.last_ts);
        const w = weekAgg.get(wk) ?? { week: wk, sessions: 0, messages: 0 };
        w.sessions += 1;
        w.messages += s0.messages ?? 0;
        weekAgg.set(wk, w);
      }
    }
    const harnesses = [...harnessAgg.values()].sort((a, b) => b.sessions - a.sessions);
    const weeklyVelocity = [...weekAgg.values()].sort((a, b) => a.week.localeCompare(b.week));
    const avgSessionLen = { avg_ms: durationCount ? durationSum / durationCount : 0 };
    t.mark('fold');

    const tools = db.prepare(`
      SELECT tool_name, COUNT(*) as count
      FROM content_blocks
      WHERE block_type = 'tool_use' AND tool_name IS NOT NULL
      GROUP BY tool_name ORDER BY count DESC LIMIT 30
    `).all() as any[];
    t.mark('tools');

    const projectStats = db.prepare(`
      SELECT p.name, p.display_name,
             COALESCE(pv.visibility, 'private') as visibility,
             COUNT(DISTINCT s.id) as sessions,
             COUNT(DISTINCT m.id) as messages,
             COUNT(DISTINCT DATE(m.timestamp)) as active_days,
             SUM(m.input_tokens) as input_tokens,
             SUM(m.output_tokens) as output_tokens,
             MIN(m.timestamp) as first_activity,
             MAX(m.timestamp) as last_activity
      FROM projects p
      LEFT JOIN project_visibility pv ON pv.project_id = p.id
      LEFT JOIN sessions s ON s.project_id = p.id
      LEFT JOIN messages m ON m.session_id = s.id
      WHERE COALESCE(pv.visibility, 'private') IN ('public', 'unlisted')
      GROUP BY p.id
      ORDER BY messages DESC
    `).all() as any[];
    t.mark('projects');


    // --- Badges ---
    const badges = computeBadges({
      totalSessions: lifetime.total_sessions ?? 0,
      totalMessages: lifetime.total_messages ?? 0,
      activeDays: lifetime.active_days ?? 0,
      currentStreak,
      longestStreak,
      totalCost,
      projectCount: projectStats.length,
      toolCount: tools.length,
      harnessCount: harnesses.length,
    });

    const payload = {
      $schema: 'unfirehose-scrobble/1.0',
      generatedAt: new Date().toISOString(),
      handle,
      displayName,
      lifetime: {
        totalSessions: lifetime.total_sessions ?? 0,
        totalMessages: lifetime.total_messages ?? 0,
        activeDays: lifetime.active_days ?? 0,
        firstActivity: lifetime.first_activity,
        lastActivity: lifetime.last_activity,
        totalInputTokens: totalInput,
        totalOutputTokens: totalOutput,
        totalCacheRead: totalCacheRead,
        totalCacheWrite: totalCacheWrite,
        totalCostUSD: Math.round(totalCost * 100) / 100,
        costSplit,
      },
      streaks: { current: currentStreak, longest: longestStreak },
      badges,
      activity: {
        hourOfDay: hourActivity,
        dayOfWeek: dowActivity,
        heatmap: heatmapRows.map((d: any) => ({ dow: d.dow, hour: d.hour, count: d.count })),
      },
      timeSeries: { dailyMessages, dailyCost: dailyCostSeries, weeklyVelocity },
      models,
      harnesses: harnesses.map((h: any) => ({ harness: h.harness, sessions: h.sessions, messages: h.messages })),
      tools: tools.map((t: any) => ({ name: t.tool_name, count: t.count })),
      projects: projectStats.map((p: any) => ({
        name: p.display_name || p.name,
        visibility: p.visibility,
        sessions: p.sessions,
        messages: p.messages,
        activeDays: p.active_days,
        inputTokens: p.input_tokens ?? 0,
        outputTokens: p.output_tokens ?? 0,
        firstActivity: p.first_activity,
        lastActivity: p.last_activity,
      })),
      sessionStats: { avgDurationMs: Math.round(avgSessionLen?.avg_ms ?? 0) },
    };
    t.mark('serialize');

    return payload;
}

/**
 * Store the payload so a page load never computes it. The worker calls this;
 * the route reads what it left.
 */
export function refreshScrobblePayload(db: Database.Database = getDb()): any {
  const payload = buildScrobblePayload(db);
  storePayload(SCROBBLE_CACHE_KEY, payload);
  return payload;
}

/** The stored payload when it is fresh enough, else null. */
export function readScrobblePayload(maxAgeMs = 10 * 60_000) {
  return readPayload<any>(SCROBBLE_CACHE_KEY, maxAgeMs);
}

function calcStreaks(sortedDatesDesc: string[]): { currentStreak: number; longestStreak: number } {
  if (sortedDatesDesc.length === 0) return { currentStreak: 0, longestStreak: 0 };

  const today = new Date().toISOString().split('T')[0];
  const yesterday = new Date(Date.now() - 86400000).toISOString().split('T')[0];

  let currentStreak = 0;
  if (sortedDatesDesc[0] === today || sortedDatesDesc[0] === yesterday) {
    currentStreak = 1;
    for (let i = 1; i < sortedDatesDesc.length; i++) {
      const prev = new Date(sortedDatesDesc[i - 1]);
      const curr = new Date(sortedDatesDesc[i]);
      const diff = (prev.getTime() - curr.getTime()) / 86400000;
      if (diff === 1) currentStreak++;
      else break;
    }
  }

  const asc = [...sortedDatesDesc].reverse();
  let longestStreak = 1;
  let run = 1;
  for (let i = 1; i < asc.length; i++) {
    const prev = new Date(asc[i - 1]);
    const curr = new Date(asc[i]);
    const diff = (curr.getTime() - prev.getTime()) / 86400000;
    if (diff === 1) {
      run++;
      if (run > longestStreak) longestStreak = run;
    } else {
      run = 1;
    }
  }

  return { currentStreak, longestStreak };
}

interface BadgeInput {
  totalSessions: number;
  totalMessages: number;
  activeDays: number;
  currentStreak: number;
  longestStreak: number;
  totalCost: number;
  projectCount: number;
  toolCount: number;
  harnessCount: number;
}

interface Badge {
  id: string;
  name: string;
  description: string;
  earned: boolean;
  tier?: 'bronze' | 'silver' | 'gold' | 'diamond';
  progress?: number;
}

function computeBadges(input: BadgeInput): Badge[] {
  const badges: Badge[] = [];

  const tiered = (metric: number, tiers: { n: number; tier: Badge['tier']; name: string; desc: string }[]) => {
    for (const t of tiers) {
      badges.push({
        id: `${t.name.toLowerCase().replace(/\s+/g, '-')}-${t.n}`,
        name: t.name,
        description: t.desc,
        earned: metric >= t.n,
        tier: t.tier,
        progress: Math.min(1, metric / t.n),
      });
    }
  };

  tiered(input.totalSessions, [
    { n: 10, tier: 'bronze', name: 'First Steps', desc: '10 sessions' },
    { n: 100, tier: 'silver', name: 'Regular', desc: '100 sessions' },
    { n: 500, tier: 'gold', name: 'Power User', desc: '500 sessions' },
    { n: 1000, tier: 'diamond', name: 'Machine Whisperer', desc: '1000 sessions' },
  ]);

  tiered(input.totalMessages, [
    { n: 1000, tier: 'bronze', name: 'Chatty', desc: '1K messages' },
    { n: 10000, tier: 'silver', name: 'Prolific', desc: '10K messages' },
    { n: 100000, tier: 'gold', name: 'Torrent', desc: '100K messages' },
    { n: 500000, tier: 'diamond', name: 'Firehose', desc: '500K messages' },
  ]);

  tiered(input.longestStreak, [
    { n: 3, tier: 'bronze', name: 'Consistent', desc: '3-day streak' },
    { n: 7, tier: 'silver', name: 'Weekly Warrior', desc: '7-day streak' },
    { n: 30, tier: 'gold', name: 'Monthly Machine', desc: '30-day streak' },
    { n: 100, tier: 'diamond', name: 'Unstoppable', desc: '100-day streak' },
  ]);

  tiered(input.totalCost, [
    { n: 10, tier: 'bronze', name: 'Penny Pincher', desc: '$10 spent' },
    { n: 100, tier: 'silver', name: 'Investor', desc: '$100 spent' },
    { n: 1000, tier: 'gold', name: 'Whale', desc: '$1K spent' },
    { n: 10000, tier: 'diamond', name: 'Deep Pocket', desc: '$10K spent' },
  ]);

  tiered(input.activeDays, [
    { n: 7, tier: 'bronze', name: 'Week One', desc: '7 active days' },
    { n: 30, tier: 'silver', name: 'Monthly', desc: '30 active days' },
    { n: 100, tier: 'gold', name: 'Centurion', desc: '100 active days' },
    { n: 365, tier: 'diamond', name: 'Year Round', desc: '365 active days' },
  ]);

  if (input.projectCount >= 5)
    badges.push({ id: 'polyglot', name: 'Polyglot', description: '5+ public projects', earned: true, tier: 'silver' });
  if (input.projectCount >= 20)
    badges.push({ id: 'architect', name: 'Architect', description: '20+ public projects', earned: true, tier: 'gold' });
  if (input.harnessCount >= 2)
    badges.push({ id: 'multi-harness', name: 'Multi-Harness', description: '2+ harness types', earned: true, tier: 'silver' });
  if (input.harnessCount >= 4)
    badges.push({ id: 'harness-collector', name: 'Harness Collector', description: '4+ harness types', earned: true, tier: 'gold' });
  if (input.toolCount >= 10)
    badges.push({ id: 'toolsmith', name: 'Toolsmith', description: '10+ distinct tools used', earned: true, tier: 'silver' });
  if (input.toolCount >= 25)
    badges.push({ id: 'swiss-army', name: 'Swiss Army', description: '25+ distinct tools used', earned: true, tier: 'gold' });

  return badges;
}
