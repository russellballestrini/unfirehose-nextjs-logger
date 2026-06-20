import { readFile, stat } from 'fs/promises';
import { claudePaths } from '@unturf/unfirehose/claude-paths';
import { NextRequest, NextResponse } from 'next/server';
import type { StatsCache } from '@unturf/unfirehose/types';
import { getDb } from '@unturf/unfirehose/db/schema';
import { calcCostBreakdown } from '@unturf/unfirehose/pricing';
import { Timing } from '@/lib/timing';

/* eslint-disable @typescript-eslint/no-explicit-any */

// In-process memo of the stats-cache JSON keyed by mtime. The file is only
// touched by our background ingester so this hits 100% between ingests and
// we skip a 5-1800ms readFile+JSON.parse round-trip on every request.
let statsCacheMemo: { mtimeMs: number; data: StatsCache } | null = null;

export async function GET(request: NextRequest) {
  const t = new Timing();
  try {
    const url = request.nextUrl;
    const from = url.searchParams.get('from');
    const to = url.searchParams.get('to');

    // Build date filter clause (applies only to date-filtered queries)
    let dateFilter = '';
    const dateParams: string[] = [];
    if (from) {
      dateFilter += ' AND m.timestamp >= ?';
      dateParams.push(from);
    }
    if (to) {
      dateFilter += ' AND m.timestamp < ?';
      dateParams.push(to);
    }

    const db = getDb();

    // Sessions lookup map: id -> harness. ~25ms via idx_sessions_id_harness.
    // We resolve harness in JS so our main aggregate query can scan a single
    // covering index on `messages` without joining.
    const sessionRows = db.prepare(`SELECT id, harness FROM sessions`).all() as Array<{ id: number; harness: string | null }>;
    const harnessById = new Map<number, string>();
    for (const r of sessionRows) {
      harnessById.set(r.id, r.harness ?? 'unknown');
    }
    t.mark('sessions-map');

    // Per (session_id, model) aggregate. Single covering index scan, no JOIN.
    // Includes last_ts so we can derive `dailyByHarness` from this same data
    // without a second 250k-row scan. 99% of sessions are single-day so
    // attributing tokens to `DATE(last_ts)` is accurate; multi-day sessions
    // get pinned to their final day, close enough for our chart.
    // .raw() returns rows as arrays instead of objects — skips V8 property
    // construction for ~19k rows, measurable speedup vs .all().
    // Column order: session_id, model, in, out, cr, cc, msgs, last_ts.
    const perSessionModel = db.prepare(`
      SELECT m.session_id, m.model,
             SUM(m.input_tokens) as input_tokens,
             SUM(m.output_tokens) as output_tokens,
             SUM(m.cache_read_tokens) as cache_read_tokens,
             SUM(m.cache_creation_tokens) as cache_creation_tokens,
             COUNT(*) as messages,
             MAX(m.timestamp) as last_ts
      FROM messages m
      WHERE m.model IS NOT NULL AND m.model != '<synthetic>'${dateFilter}
      GROUP BY m.session_id, m.model
    `).raw().all(...dateParams) as Array<[number, string, number, number, number, number, number, string | null]>;
    t.mark('per-session-model');

    // Roll up per-session-model rows into our breakdowns in JS.
    // 19k rows is trivial to traverse.
    const modelMap = new Map<string, { input: number; output: number; cacheRead: number; cacheWrite: number }>();
    const harnessModelKeyed = new Map<string, {
      harness: string; model: string;
      input_tokens: number; output_tokens: number;
      cache_read_tokens: number; cache_creation_tokens: number;
      sessions: Set<number>;
    }>();
    const harnessMap = new Map<string, {
      input: number; output: number; cacheRead: number; cacheWrite: number;
      sessions: Set<number>;
    }>();
    // dailyByHarness derived from per-session last_ts (no second SQL scan).
    // Chart only displays last 30 days, so we clamp at the JS layer.
    const cutoffDate = new Date(Date.now() - 30 * 86400_000).toISOString().slice(0, 10);
    const dailyKeyed = new Map<string, { date: string; harness: string; tokens: number; messages: number }>();

    for (const r of perSessionModel) {
      const session_id = r[0];
      const model = r[1];
      const input_tokens = r[2];
      const output_tokens = r[3];
      const cache_read_tokens = r[4];
      const cache_creation_tokens = r[5];
      const messages = r[6];
      const last_ts = r[7];
      const harness = harnessById.get(session_id) ?? 'unknown';

      const mm = modelMap.get(model) ?? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
      mm.input += input_tokens;
      mm.output += output_tokens;
      mm.cacheRead += cache_read_tokens;
      mm.cacheWrite += cache_creation_tokens;
      modelMap.set(model, mm);

      const hmKey = harness + '\x00' + model;
      let hm = harnessModelKeyed.get(hmKey);
      if (!hm) {
        hm = {
          harness, model,
          input_tokens: 0, output_tokens: 0,
          cache_read_tokens: 0, cache_creation_tokens: 0,
          sessions: new Set(),
        };
        harnessModelKeyed.set(hmKey, hm);
      }
      hm.input_tokens += input_tokens;
      hm.output_tokens += output_tokens;
      hm.cache_read_tokens += cache_read_tokens;
      hm.cache_creation_tokens += cache_creation_tokens;
      hm.sessions.add(session_id);

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

      // Daily attribution: pin each session-model row to its final day.
      // last_ts is ISO-8601 so substr(0,10) is the date.
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
      const c = calcCostBreakdown(model, t.input, t.output, t.cacheRead, t.cacheWrite);
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

    const totalTokens = modelBreakdown.reduce((s, m) => s + m.totalTokens, 0);
    const totalCost = modelBreakdown.reduce((s, m) => s + m.costUSD, 0);
    const totalInputCost = modelBreakdown.reduce((s, m) => s + m.inputCostUSD, 0);
    const totalOutputCost = modelBreakdown.reduce((s, m) => s + m.outputCostUSD, 0);
    const totalCacheReadCost = modelBreakdown.reduce((s, m) => s + m.cacheReadCostUSD, 0);
    const totalCacheWriteCost = modelBreakdown.reduce((s, m) => s + m.cacheWriteCostUSD, 0);
    const totalInput = modelBreakdown.reduce((s, m) => s + m.inputTokens, 0);
    const totalOutput = modelBreakdown.reduce((s, m) => s + m.outputTokens, 0);
    const totalCacheRead = modelBreakdown.reduce((s, m) => s + m.cacheReadTokens, 0);
    const totalCacheWrite = modelBreakdown.reduce((s, m) => s + m.cacheCreationTokens, 0);

    const harnessModelBreakdown = [...harnessModelKeyed.values()].map(hm => ({
      harness: hm.harness,
      model: hm.model,
      input_tokens: hm.input_tokens,
      output_tokens: hm.output_tokens,
      cache_read_tokens: hm.cache_read_tokens,
      cache_creation_tokens: hm.cache_creation_tokens,
      sessions: hm.sessions.size,
    }));

    const harnessCostMap = new Map<string, { input: number; output: number; cacheRead: number; cacheWrite: number; total: number }>();
    for (const hm of harnessModelBreakdown) {
      const c = calcCostBreakdown(hm.model, hm.input_tokens, hm.output_tokens, hm.cache_read_tokens, hm.cache_creation_tokens);
      const prev = harnessCostMap.get(hm.harness) ?? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 };
      prev.input += c.input;
      prev.output += c.output;
      prev.cacheRead += c.cacheRead;
      prev.cacheWrite += c.cacheWrite;
      prev.total += c.total;
      harnessCostMap.set(hm.harness, prev);
    }

    const harnessData = [...harnessMap.entries()].map(([harness, t]) => {
      const c = harnessCostMap.get(harness) ?? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 };
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
    t.mark('rollup');

    // Combined tool query: tool calls + by model + by harness in one pass.
    // Uses idx_content_blocks_tool covering index.
    const toolRows = db.prepare(`
      SELECT cb.tool_name,
             m.model,
             m.session_id,
             COUNT(*) as count
      FROM content_blocks cb
      JOIN messages m ON m.id = cb.message_id
      WHERE cb.block_type = 'tool_use' AND cb.tool_name IS NOT NULL${dateFilter}
      GROUP BY cb.tool_name, m.model, m.session_id
    `).all(...dateParams) as Array<{ tool_name: string; model: string; session_id: number; count: number }>;
    t.mark('tools');

    // Derive toolCalls (by tool_name), toolsByModel, toolsByHarness in JS.
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

    // dailyByHarness was already computed in the rollup above (no extra SQL scan).
    const dailyByHarness = [...dailyKeyed.values()].sort((a, b) => a.date.localeCompare(b.date));

    // Content block type breakdown.
    const blockTypes = dateFilter
      ? db.prepare(`
          SELECT cb.block_type, COUNT(*) as count
          FROM content_blocks cb
          JOIN messages m ON m.id = cb.message_id
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
    t.mark('blocks');

    // Read stats cache for daily activity (mtime-keyed memo to skip cold
    // disk reads under dev-mode FS contention).
    let dailyActivity: any[] = [];
    let dailyModelTokens: any[] = [];
    try {
      const st = await stat(claudePaths.statsCache);
      if (statsCacheMemo && statsCacheMemo.mtimeMs === st.mtimeMs) {
        dailyActivity = statsCacheMemo.data.dailyActivity ?? [];
        dailyModelTokens = statsCacheMemo.data.dailyModelTokens ?? [];
      } else {
        const raw = await readFile(claudePaths.statsCache, 'utf-8');
        const stats: StatsCache = JSON.parse(raw);
        statsCacheMemo = { mtimeMs: st.mtimeMs, data: stats };
        dailyActivity = stats.dailyActivity ?? [];
        dailyModelTokens = stats.dailyModelTokens ?? [];
      }
    } catch { /* stats cache missing is fine */ }
    t.mark('stats-cache');

    return NextResponse.json({
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
      dailyActivity,
      dailyModelTokens,
      blockTypes,
      harnessData,
      harnessModelBreakdown,
      harnessSessions,
      toolsByHarness,
      dailyByHarness,
    }, { headers: { 'Server-Timing': t.header() } });
  } catch (err) {
    return NextResponse.json(
      { error: 'Failed to read token data', detail: String(err) },
      { status: 500, headers: { 'Server-Timing': t.header() } }
    );
  }
}
