/**
 * The Tokens page payload, built away from the request that shows it.
 *
 * Measured 2026-10-14 on a 6.8 GB database, served from the route itself:
 * 13 s for lifetime, 6 to 7 s for the 7-day view the page opens on. Two
 * things did that. The tool-call rollup joined content_blocks to messages by
 * driving from the 704k tool blocks and probing messages by primary key for
 * each, whatever the date filter said — 4.6 s for a week whose answer is 204
 * rows. And every build ran on the web server's one thread, so the Tokens
 * page charged its cost to every other request while it loaded.
 *
 * Now a date-bounded build drives from the messages window index and asks
 * content_blocks for each message's tool blocks (0.2 s for a week, 8 ms for
 * a day), and the ranges the page offers are built here, by the worker, and
 * stored. The route serves what was stored. Lifetime still costs 11 s to
 * build; it costs the worker that, once, when a message has landed.
 */

import type Database from 'better-sqlite3';
import { getDb } from './db/schema';
import { costForUsage } from './pricing';
import { ensurePricingHydrated } from './pricing-sync';
import { storePayload, readPayload, payloadCurrent, messagesWatermark } from './precomputed';
import { TOOL_CALL_SQL } from './block-types';
import { DASHBOARD_RANGES } from './dashboard';

/* eslint-disable @typescript-eslint/no-explicit-any */

/**
 * Minutes per range value — the same table the shared range selector and the
 * dashboard use, so a `from` the Tokens page sends snaps back onto a range
 * the worker warmed.
 */
export const TOKENS_RANGES: Record<string, number> = DASHBOARD_RANGES;

export interface TokensBuildOptions {
  /** ISO lower bound on message timestamp, inclusive. */
  from?: string | null;
  /** ISO upper bound on message timestamp, exclusive. */
  to?: string | null;
  /** Project name (the encoded path) to scope every figure to. */
  project?: string | null;
}

type Booked = { input: number; output: number; cacheRead: number; cacheWrite: number; total: number };
const zeroBooked = (): Booked => ({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 });
const book = (into: Booked, c: Booked) => {
  into.input += c.input; into.output += c.output;
  into.cacheRead += c.cacheRead; into.cacheWrite += c.cacheWrite; into.total += c.total;
};

// A project scopes a query to its sessions. Pushed into SQL rather than
// filtered in JS afterwards: the JS filter still paid for the full scan it
// then threw most of away, 10 s for a project whose answer was 100 rows.
const PROJECT_SCOPE_SQL = `
  AND m.session_id IN (
    SELECT s.id FROM sessions s JOIN projects p ON s.project_id = p.id WHERE p.name = ?
  )`;

// Above this many distinct sessions, one scan of the sessions table beats
// one indexed lookup per session.
const SESSION_LOOKUP_MAX = 5000;

// Up to this wide, a window is answered fastest by walking its messages and
// asking for each one's blocks: 8 ms for a day, 0.2 s for a week, 3.7 s for
// 28 days. Past it the per-message probes outnumber the 704k tool blocks
// and the order flips — 17 s for 90 days, 27 s for a year — against 13 s
// for walking every tool block once, which is what lifetime does. Measured
// 2026-10-14 on 2.1M messages; 45 days sits in the gap between the 28d and
// 90d ranges the page offers.
const SHORT_WINDOW_MS = 45 * 86400_000;

/**
 * Build the Tokens payload for a window and an optional project. Pure
 * function of the database; the stats-cache file the page also shows is the
 * route's business, since it is a per-host file and costs 2 ms.
 */
export function buildTokensPayload(db: Database.Database = getDb(), opts: TokensBuildOptions = {}): any {
  // Cost math reads an in-memory price catalog; make sure it reflects what
  // the worker last synced from our oracles.
  ensurePricingHydrated(db);

  const { from, to, project } = opts;
  let dateFilter = '';
  const dateParams: string[] = [];
  if (from) { dateFilter += ' AND m.timestamp >= ?'; dateParams.push(from); }
  if (to) { dateFilter += ' AND m.timestamp < ?'; dateParams.push(to); }

  const scopeSql = project ? PROJECT_SCOPE_SQL : '';
  const scopeParams = project ? [project] : [];

  const fromMs = from ? Date.parse(from) : NaN;
  const toMs = to ? Date.parse(to) : Date.now();
  const shortWindow = Number.isFinite(fromMs) && Number.isFinite(toMs) && toMs - fromMs <= SHORT_WINDOW_MS;
  // Drive from messages when the set of messages in play is small: a short
  // window, or one project's sessions. Lifetime and the long ranges walk
  // the tool blocks instead.
  const messagesFirst = shortWindow || Boolean(project);

  // Per (session_id, model) aggregate. Lifetime walks the covering
  // (session_id, model, timestamp, tokens...) index in GROUP BY order. A
  // date-bounded build without a project would too — the planner prefers
  // the index that spares it a sort — and read all 2.1M rows to find a
  // week's worth. The window index starts at `from` and stops at `to`:
  // 73 ms against 416 for the same week. A project scope already lands on
  // the session index, and a long window is most of the table either way,
  // so both are left to the planner.
  const psmIndex = shortWindow && !project ? 'INDEXED BY idx_messages_window_usage' : '';
  const perSessionModel = db.prepare(`
    SELECT m.session_id, m.model,
           SUM(m.input_tokens) as input_tokens,
           SUM(m.output_tokens) as output_tokens,
           SUM(m.cache_read_tokens) as cache_read_tokens,
           SUM(m.cache_creation_tokens) as cache_creation_tokens,
           COUNT(*) as messages,
           MAX(m.timestamp) as last_ts
    FROM messages m ${psmIndex}
    WHERE m.model IS NOT NULL AND m.model != '<synthetic>'${dateFilter}${scopeSql}
    GROUP BY m.session_id, m.model
  `).raw().all(...dateParams, ...scopeParams) as Array<[number, string, number, number, number, number, number, string | null]>;

  // Tool calls by (tool, model, session). Lifetime and the long windows walk
  // the tool blocks and probe messages by rowid — the only order that works
  // for 704k blocks against most of 2.1M messages. A short window or a
  // project does the reverse: CROSS JOIN pins messages as the outer loop,
  // the window or session index yields the few messages in play, and the
  // (message_id, block_type) index answers each one's tool blocks.
  const toolRows = (messagesFirst
    ? db.prepare(`
        SELECT cb.tool_name, m.model, m.session_id, COUNT(*) as count
        FROM messages m
        CROSS JOIN content_blocks cb ON cb.message_id = m.id
        WHERE 1=1${dateFilter}${scopeSql}
          AND cb.block_type ${TOOL_CALL_SQL} AND cb.tool_name IS NOT NULL
        GROUP BY cb.tool_name, m.model, m.session_id
      `).all(...dateParams, ...scopeParams)
    : db.prepare(`
        SELECT cb.tool_name, m.model, m.session_id, COUNT(*) as count
        FROM content_blocks cb
        JOIN messages m ON m.id = cb.message_id
        WHERE cb.block_type ${TOOL_CALL_SQL} AND cb.tool_name IS NOT NULL${dateFilter}
        GROUP BY cb.tool_name, m.model, m.session_id
      `).all(...dateParams)) as Array<{ tool_name: string; model: string; session_id: number; count: number }>;

  // Sessions -> harness. Lifetime touches most of the 77k sessions and one
  // scan is the cheap way to learn them all; a week touches a few dozen and
  // one scan would be most of the request.
  const sessionIds = new Set<number>();
  for (const r of perSessionModel) sessionIds.add(r[0]);
  for (const r of toolRows) sessionIds.add(r.session_id);
  const harnessById = new Map<number, string>();
  if (sessionIds.size > SESSION_LOOKUP_MAX) {
    const rows = db.prepare('SELECT id, harness FROM sessions').raw().all() as Array<[number, string | null]>;
    for (const [id, harness] of rows) harnessById.set(id, harness ?? 'unknown');
  } else {
    const one = db.prepare('SELECT harness FROM sessions WHERE id = ?');
    for (const id of sessionIds) {
      const row = one.get(id) as { harness: string | null } | undefined;
      harnessById.set(id, row?.harness ?? 'unknown');
    }
  }

  // Roll up per-session-model rows into our breakdowns in JS.
  // Cost is booked per session-model row at that row's last_ts, then summed
  // — not summed first and priced at today's rate. A price change on the
  // oracles moves today's number, not last month's. 99% of sessions are
  // single-day so pinning tokens to the final day is accurate; multi-day
  // sessions land on their last day, close enough for the chart.
  const modelMap = new Map<string, { input: number; output: number; cacheRead: number; cacheWrite: number; cost: Booked }>();
  const harnessModelKeyed = new Map<string, {
    harness: string; model: string;
    input_tokens: number; output_tokens: number;
    cache_read_tokens: number; cache_creation_tokens: number;
    sessions: Set<number>;
    cost: Booked;
  }>();
  const harnessMap = new Map<string, {
    input: number; output: number; cacheRead: number; cacheWrite: number;
    sessions: Set<number>;
  }>();
  // dailyByHarness from per-session last_ts; the chart shows 30 days.
  const cutoffDate = new Date(Date.now() - 30 * 86400_000).toISOString().slice(0, 10);
  const dailyKeyed = new Map<string, { date: string; harness: string; tokens: number; messages: number }>();

  for (const r of perSessionModel) {
    const [session_id, model, input_tokens, output_tokens, cache_read_tokens, cache_creation_tokens, messages, last_ts] = r;
    const harness = harnessById.get(session_id) ?? 'unknown';

    const rowCost = costForUsage({
      model, input: input_tokens, output: output_tokens,
      cacheRead: cache_read_tokens, cacheWrite: cache_creation_tokens,
      at: last_ts,
    });

    const mm = modelMap.get(model) ?? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: zeroBooked() };
    mm.input += input_tokens;
    mm.output += output_tokens;
    mm.cacheRead += cache_read_tokens;
    mm.cacheWrite += cache_creation_tokens;
    book(mm.cost, rowCost);
    modelMap.set(model, mm);

    const hmKey = harness + '\x00' + model;
    let hm = harnessModelKeyed.get(hmKey);
    if (!hm) {
      hm = {
        harness, model,
        input_tokens: 0, output_tokens: 0,
        cache_read_tokens: 0, cache_creation_tokens: 0,
        sessions: new Set(),
        cost: zeroBooked(),
      };
      harnessModelKeyed.set(hmKey, hm);
    }
    hm.input_tokens += input_tokens;
    hm.output_tokens += output_tokens;
    hm.cache_read_tokens += cache_read_tokens;
    hm.cache_creation_tokens += cache_creation_tokens;
    hm.sessions.add(session_id);
    book(hm.cost, rowCost);

    let hMap = harnessMap.get(harness);
    if (!hMap) {
      hMap = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, sessions: new Set() };
      harnessMap.set(harness, hMap);
    }
    hMap.input += input_tokens;
    hMap.output += output_tokens;
    hMap.cacheRead += cache_read_tokens;
    hMap.cacheWrite += cache_creation_tokens;
    hMap.sessions.add(session_id);

    if (last_ts && last_ts.length >= 10) {
      const date = last_ts.slice(0, 10);
      if (date >= cutoffDate) {
        const dKey = date + '\x00' + harness;
        const sessionTokens = input_tokens + output_tokens + cache_read_tokens + cache_creation_tokens;
        let dEntry = dailyKeyed.get(dKey);
        if (!dEntry) {
          dEntry = { date, harness, tokens: 0, messages: 0 };
          dailyKeyed.set(dKey, dEntry);
        }
        dEntry.tokens += sessionTokens;
        dEntry.messages += messages;
      }
    }
  }

  const modelBreakdown = [...modelMap.entries()].map(([model, t]) => {
    const c = t.cost;
    return {
      model,
      inputTokens: t.input,
      outputTokens: t.output,
      cacheReadTokens: t.cacheRead,
      cacheCreationTokens: t.cacheWrite,
      totalTokens: t.input + t.output + t.cacheRead + t.cacheWrite,
      inputCostUSD: c.input,
      outputCostUSD: c.output,
      cacheReadCostUSD: c.cacheRead,
      cacheWriteCostUSD: c.cacheWrite,
      costUSD: c.total,
    };
  });

  const sum = (pick: (m: typeof modelBreakdown[number]) => number) => modelBreakdown.reduce((s, m) => s + pick(m), 0);
  const totalTokens = sum((m) => m.totalTokens);
  const totalCost = sum((m) => m.costUSD);
  const totalInputCost = sum((m) => m.inputCostUSD);
  const totalOutputCost = sum((m) => m.outputCostUSD);
  const totalCacheReadCost = sum((m) => m.cacheReadCostUSD);
  const totalCacheWriteCost = sum((m) => m.cacheWriteCostUSD);
  const totalInput = sum((m) => m.inputTokens);
  const totalOutput = sum((m) => m.outputTokens);
  const totalCacheRead = sum((m) => m.cacheReadTokens);
  const totalCacheWrite = sum((m) => m.cacheCreationTokens);

  const harnessModelBreakdown = [...harnessModelKeyed.values()].map(hm => ({
    harness: hm.harness,
    model: hm.model,
    input_tokens: hm.input_tokens,
    output_tokens: hm.output_tokens,
    cache_read_tokens: hm.cache_read_tokens,
    cache_creation_tokens: hm.cache_creation_tokens,
    sessions: hm.sessions.size,
    costUSD: hm.cost.total,
  }));

  const harnessCostMap = new Map<string, Booked>();
  for (const hm of harnessModelKeyed.values()) {
    const prev = harnessCostMap.get(hm.harness) ?? zeroBooked();
    book(prev, hm.cost);
    harnessCostMap.set(hm.harness, prev);
  }

  const harnessData = [...harnessMap.entries()].map(([harness, t]) => {
    const c = harnessCostMap.get(harness) ?? zeroBooked();
    return {
      harness,
      inputTokens: t.input,
      outputTokens: t.output,
      cacheReadTokens: t.cacheRead,
      cacheCreationTokens: t.cacheWrite,
      totalTokens: t.input + t.output + t.cacheRead + t.cacheWrite,
      inputCostUSD: c.input,
      outputCostUSD: c.output,
      cacheReadCostUSD: c.cacheRead,
      cacheWriteCostUSD: c.cacheWrite,
      costUSD: c.total,
      cacheEfficiency: t.input > 0 ? t.cacheRead / t.input : 0,
    };
  });

  const harnessSessions = [...harnessMap.entries()].map(([harness, t]) => ({
    harness,
    sessions: t.sessions.size,
  }));

  // toolCalls (by tool_name), toolsByModel, toolsByHarness from one pass.
  const toolCountMap = new Map<string, number>();
  const toolModelMap = new Map<string, number>();
  const toolHarnessMap = new Map<string, Map<string, number>>();
  for (const r of toolRows) {
    toolCountMap.set(r.tool_name, (toolCountMap.get(r.tool_name) ?? 0) + r.count);
    toolModelMap.set(r.model, (toolModelMap.get(r.model) ?? 0) + r.count);
    const harness = harnessById.get(r.session_id) ?? 'unknown';
    if (!toolHarnessMap.has(harness)) toolHarnessMap.set(harness, new Map());
    const hm = toolHarnessMap.get(harness)!;
    hm.set(r.tool_name, (hm.get(r.tool_name) ?? 0) + r.count);
  }

  const toolCalls = [...toolCountMap.entries()]
    .map(([tool_name, count]) => ({ tool_name, count }))
    .sort((a, b) => b.count - a.count);

  const toolsByModel = [...toolModelMap.entries()]
    .map(([model, count]) => ({ model, count }))
    .sort((a, b) => b.count - a.count);

  const toolsByHarness: Array<{ harness: string; tool_name: string; count: number }> = [];
  for (const [harness, tools] of toolHarnessMap) {
    for (const [tool_name, count] of tools) {
      toolsByHarness.push({ harness, tool_name, count });
    }
  }
  toolsByHarness.sort((a, b) => a.harness.localeCompare(b.harness) || b.count - a.count);

  const dailyByHarness = [...dailyKeyed.values()].sort((a, b) => a.date.localeCompare(b.date));

  // Content block type breakdown. Date-bounded only, as it always was: a
  // project filter narrows the token and tool figures, not this one. Same
  // join-order rule as the tool query: a short window walks its messages
  // (62 ms for a week); a long one walks every block once and probes
  // messages by rowid (3.8 s for a year, against 7.5 s left to the planner).
  const blockTypes = dateFilter
    ? db.prepare(shortWindow
        ? `
        SELECT cb.block_type, COUNT(*) as count
        FROM messages m
        CROSS JOIN content_blocks cb ON cb.message_id = m.id
        WHERE 1=1${dateFilter}
        GROUP BY cb.block_type
        ORDER BY count DESC
      ` : `
        SELECT cb.block_type, COUNT(*) as count
        FROM content_blocks cb
        CROSS JOIN messages m ON m.id = cb.message_id
        WHERE 1=1${dateFilter}
        GROUP BY cb.block_type
        ORDER BY count DESC
      `).all(...dateParams) as Array<{ block_type: string; count: number }>
    : db.prepare(`
        SELECT block_type, COUNT(*) as count
        FROM content_blocks
        GROUP BY block_type
        ORDER BY count DESC
      `).all() as Array<{ block_type: string; count: number }>;

  return {
    modelBreakdown,
    totalTokens,
    totalCost,
    totalInputCost,
    totalOutputCost,
    totalCacheReadCost,
    totalCacheWriteCost,
    totalInput,
    totalOutput,
    totalCacheRead,
    totalCacheWrite,
    toolCalls,
    toolsByModel,
    blockTypes,
    harnessData,
    harnessModelBreakdown,
    harnessSessions,
    toolsByHarness,
    dailyByHarness,
  };
}

// ---------------------------------------------------------------------------
// Stored payloads, one per range
// ---------------------------------------------------------------------------

const KEY_PREFIX = 'tokens_';
const key = (range: string) => `${KEY_PREFIX}${range}`;

/**
 * How far a requested window may sit from a warmed range and still be
 * answered by it. The page computes `from` once on mount and keeps it for
 * the life of the tab, so a 7-day view left open through an afternoon asks
 * for seven days and three hours. It means seven days. Adjacent ranges are
 * at least 2x apart, so a quarter either way never lands on the wrong one.
 */
export const SNAP_TOLERANCE = 1.25;

/**
 * The range a request's window stands for, or null when no stored payload
 * can honestly answer it: an explicit `to`, a window that sits between
 * ranges, an unparseable `from`.
 */
export function snapRange(
  from: string | null | undefined,
  to: string | null | undefined,
  now: number = Date.now(),
): string | null {
  if (to) return null;
  if (!from) return 'all';
  const ms = now - Date.parse(from);
  if (!Number.isFinite(ms) || ms <= 0) return null;
  const minutes = ms / 60_000;
  let best: string | null = null;
  let bestErr = Infinity;
  for (const [range, mins] of Object.entries(TOKENS_RANGES)) {
    if (!mins) continue;
    const err = Math.abs(Math.log(minutes / mins));
    if (err < bestErr) { bestErr = err; best = range; }
  }
  return bestErr <= Math.log(SNAP_TOLERANCE) ? best : null;
}

/** ISO lower bound for a range; undefined for lifetime. */
export function rangeFrom(range: string, now: number = Date.now()): string | undefined {
  const minutes = TOKENS_RANGES[range];
  if (!minutes) return undefined;
  return new Date(now - minutes * 60_000).toISOString();
}

/**
 * Build and store one range. The worker calls this.
 *
 * With `unlessCurrentMs`, a stored payload built from the same messages and
 * younger than that is left alone and null comes back: nothing new to read
 * means nothing new to write.
 */
export function refreshTokensPayload(
  range: string,
  opts: { unlessCurrentMs?: number } = {},
  db: Database.Database = getDb(),
): any | null {
  const watermark = messagesWatermark();
  if (opts.unlessCurrentMs !== undefined && payloadCurrent(key(range), opts.unlessCurrentMs, watermark)) return null;
  const payload = buildTokensPayload(db, { from: rangeFrom(range) });
  storePayload(key(range), payload, watermark);
  return payload;
}

/** The stored payload for a range when it is fresh enough, else null. */
export function readTokensPayload(range: string, maxAgeMs = 10 * 60_000) {
  return readPayload<any>(key(range), maxAgeMs);
}

/**
 * Every range that has ever been stored. A range nobody warms is built on
 * its first request and stored; the worker then keeps it as fresh as the
 * other long ranges, rather than serving that first build forever.
 */
export function storedTokensRanges(db: Database.Database = getDb()): string[] {
  const rows = db
    .prepare(`SELECT key FROM settings WHERE key LIKE ? ESCAPE '\\'`)
    .all(`${KEY_PREFIX.replace(/_/g, '\\_')}%\\_at`) as Array<{ key: string }>;
  return rows
    .map((r) => r.key.slice(KEY_PREFIX.length, -'_at'.length))
    .filter((r) => r in TOKENS_RANGES);
}

/** The ranges the page opens on, rebuilt every minute a message has landed. */
export const WARM_TOKENS_SHORT_RANGES = ['24h', '7d'] as const;
/** Lifetime is an 11 s build and a month does not move in a minute. */
export const WARM_TOKENS_LONG_RANGES = ['28d', 'all'] as const;
