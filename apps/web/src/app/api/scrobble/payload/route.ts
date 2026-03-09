import { NextResponse } from 'next/server';
import { getDb } from '@unturf/unfirehose/db/schema';
import { getSetting } from '@unturf/unfirehose/db/ingest';

/* eslint-disable @typescript-eslint/no-explicit-any */

// Anthropic API pricing per million tokens (2026 rates)
const PRICING: Record<string, { input: number; output: number; cacheRead: number; cacheWrite: number }> = {
  'claude-opus-4-6':            { input: 5,  output: 25, cacheRead: 0.50, cacheWrite: 6.25 },
  'claude-opus-4-5-20251101':   { input: 5,  output: 25, cacheRead: 0.50, cacheWrite: 6.25 },
  'claude-sonnet-4-5-20250929': { input: 3,  output: 15, cacheRead: 0.30, cacheWrite: 3.75 },
  'claude-sonnet-4-6':          { input: 3,  output: 15, cacheRead: 0.30, cacheWrite: 3.75 },
  'claude-haiku-4-5-20251001':  { input: 1,   output: 5,  cacheRead: 0.10, cacheWrite: 1.25 },
};

function calcCost(model: string, input: number, output: number, cacheRead: number, cacheWrite: number): number {
  const p = PRICING[model];
  if (!p) return 0;
  return (
    (input / 1_000_000) * p.input +
    (output / 1_000_000) * p.output +
    (cacheRead / 1_000_000) * p.cacheRead +
    (cacheWrite / 1_000_000) * p.cacheWrite
  );
}

export async function GET() {
  try {
    const db = getDb();
    const handle = getSetting('unfirehose_handle') ?? 'anonymous';
    const displayName = getSetting('unfirehose_display_name') ?? handle;

    const ninetyDaysAgo = new Date(Date.now() - 90 * 86400000).toISOString();
    const twelveWeeksAgo = new Date(Date.now() - 84 * 86400000).toISOString();

    // --- Combined lifetime + model breakdown in one query ---
    const modelRows = db.prepare(`
      SELECT model,
             COUNT(*) as messages,
             SUM(input_tokens) as inp, SUM(output_tokens) as out,
             SUM(cache_read_tokens) as cr, SUM(cache_creation_tokens) as cw
      FROM messages
      WHERE model IS NOT NULL AND model != '<synthetic>'
      GROUP BY model ORDER BY messages DESC
    `).all() as any[];

    // Derive lifetime totals from model rows
    let totalInput = 0, totalOutput = 0, totalCacheRead = 0, totalCacheWrite = 0, totalCost = 0;
    const models = modelRows.map((m: any) => {
      totalInput += m.inp ?? 0;
      totalOutput += m.out ?? 0;
      totalCacheRead += m.cr ?? 0;
      totalCacheWrite += m.cw ?? 0;
      const cost = calcCost(m.model, m.inp, m.out, m.cr, m.cw);
      totalCost += cost;
      return { model: m.model, messages: m.messages, inputTokens: m.inp, outputTokens: m.out };
    });

    // --- Lifetime counts (sessions, active days, date range) ---
    const lifetime = db.prepare(`
      SELECT COUNT(DISTINCT s.id) as total_sessions,
             COUNT(DISTINCT m.id) as total_messages,
             COUNT(DISTINCT DATE(m.timestamp)) as active_days,
             MIN(m.timestamp) as first_activity,
             MAX(m.timestamp) as last_activity
      FROM messages m
      JOIN sessions s ON m.session_id = s.id
    `).get() as any;

    // --- Combined activity: streaks + hour + dow + heatmap ---
    // Streaks need distinct dates
    const activeDates = db.prepare(`
      SELECT DISTINCT DATE(timestamp) as d FROM messages
      WHERE timestamp IS NOT NULL ORDER BY d DESC
    `).all() as { d: string }[];

    const { currentStreak, longestStreak } = calcStreaks(activeDates.map(r => r.d));

    // Combined hour×dow heatmap (derive hour-of-day and day-of-week from it)
    const heatmapRows = db.prepare(`
      SELECT CAST(strftime('%w', timestamp) AS INTEGER) as dow,
             CAST(strftime('%H', timestamp) AS INTEGER) as hour,
             COUNT(*) as count
      FROM messages WHERE timestamp IS NOT NULL
      GROUP BY dow, hour
    `).all() as any[];

    // Derive hour-of-day and day-of-week aggregates from heatmap
    const hourMap = new Map<number, number>();
    const dowMap = new Map<number, number>();
    for (const r of heatmapRows) {
      hourMap.set(r.hour, (hourMap.get(r.hour) ?? 0) + r.count);
      dowMap.set(r.dow, (dowMap.get(r.dow) ?? 0) + r.count);
    }
    const hourActivity = [...hourMap.entries()].sort((a, b) => a[0] - b[0]).map(([hour, count]) => ({ hour, count }));
    const dowActivity = [...dowMap.entries()].sort((a, b) => a[0] - b[0]).map(([dow, count]) => ({
      day: ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][dow],
      count,
    }));

    // --- Combined time series: daily cost + messages (90 days) ---
    const dailyRows = db.prepare(`
      SELECT DATE(timestamp) as date, model,
             COUNT(*) as msg_count,
             SUM(input_tokens) as inp, SUM(output_tokens) as out,
             SUM(cache_read_tokens) as cr, SUM(cache_creation_tokens) as cw
      FROM messages
      WHERE timestamp >= ? AND model IS NOT NULL AND model != '<synthetic>'
      GROUP BY date, model ORDER BY date
    `).all(ninetyDaysAgo) as any[];

    const dailyAgg: Record<string, { cost: number; count: number }> = {};
    for (const r of dailyRows) {
      if (!dailyAgg[r.date]) dailyAgg[r.date] = { cost: 0, count: 0 };
      dailyAgg[r.date].cost += calcCost(r.model, r.inp, r.out, r.cr, r.cw);
      dailyAgg[r.date].count += r.msg_count;
    }
    const dailyCostSeries = Object.entries(dailyAgg)
      .map(([date, d]) => ({ date, costUSD: Math.round(d.cost * 100) / 100 }))
      .sort((a, b) => a.date.localeCompare(b.date));
    const dailyMessages = Object.entries(dailyAgg)
      .map(([date, d]) => ({ date, count: d.count }))
      .sort((a, b) => a.date.localeCompare(b.date));

    // --- Harness + weekly velocity + tools + project stats + session duration ---
    // Run remaining lightweight queries
    const harnesses = db.prepare(`
      SELECT COALESCE(s.harness, 'claude-code') as harness,
             COUNT(DISTINCT s.id) as sessions, COUNT(m.id) as messages
      FROM sessions s
      JOIN messages m ON m.session_id = s.id
      GROUP BY harness ORDER BY sessions DESC
    `).all() as any[];

    const weeklyVelocity = db.prepare(`
      SELECT strftime('%Y-W%W', m.timestamp) as week,
             COUNT(DISTINCT s.id) as sessions,
             COUNT(m.id) as messages
      FROM messages m
      JOIN sessions s ON m.session_id = s.id
      WHERE m.timestamp >= ?
      GROUP BY week ORDER BY week
    `).all(twelveWeeksAgo) as any[];

    const tools = db.prepare(`
      SELECT tool_name, COUNT(*) as count
      FROM content_blocks
      WHERE block_type = 'tool_use' AND tool_name IS NOT NULL
      GROUP BY tool_name ORDER BY count DESC LIMIT 30
    `).all() as any[];

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

    const avgSessionLen = db.prepare(`
      SELECT AVG(duration_ms) as avg_ms
      FROM (
        SELECT s.id, (julianday(MAX(m.timestamp)) - julianday(MIN(m.timestamp))) * 86400000 as duration_ms
        FROM sessions s
        JOIN messages m ON m.session_id = s.id
        GROUP BY s.id
        HAVING COUNT(m.id) > 1
      )
    `).get() as any;

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

    return NextResponse.json({
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
    });
  } catch (err: any) {
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
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
