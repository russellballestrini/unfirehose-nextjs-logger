import { readFile } from 'fs/promises';
import { claudePaths } from '@unturf/unfirehose/claude-paths';
import { NextRequest, NextResponse } from 'next/server';
import type { StatsCache } from '@unturf/unfirehose/types';
import { getDb } from '@unturf/unfirehose/db/schema';

/* eslint-disable @typescript-eslint/no-explicit-any */

// Anthropic API pricing per million tokens (2026 rates)
// Used to show equivalent value even on Max plan
// Pricing: cache_read = 10% of input, cache_write = 125% of input
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

export async function GET(request: NextRequest) {
  try {
    const url = request.nextUrl;
    const from = url.searchParams.get('from');
    const to = url.searchParams.get('to');

    // Build date filter clause
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

    // Single mega-query: harness × model breakdown with session counts
    // This one query replaces: modelBreakdown, harnessBreakdown, harnessModelBreakdown, harnessSessions, and the N+1 cost queries
    const harnessModelRows = db.prepare(`
      SELECT COALESCE(s.harness, 'unknown') as harness,
             m.model,
             SUM(m.input_tokens) as input_tokens,
             SUM(m.output_tokens) as output_tokens,
             SUM(m.cache_read_tokens) as cache_read_tokens,
             SUM(m.cache_creation_tokens) as cache_creation_tokens,
             COUNT(DISTINCT s.id) as sessions
      FROM messages m
      JOIN sessions s ON s.id = m.session_id
      WHERE m.model IS NOT NULL AND m.model != '<synthetic>'${dateFilter}
      GROUP BY harness, m.model
    `).all(...dateParams) as Array<{
      harness: string;
      model: string;
      input_tokens: number;
      output_tokens: number;
      cache_read_tokens: number;
      cache_creation_tokens: number;
      sessions: number;
    }>;

    // Derive modelBreakdown by aggregating across harnesses
    const modelMap = new Map<string, { input: number; output: number; cacheRead: number; cacheWrite: number }>();
    for (const r of harnessModelRows) {
      const prev = modelMap.get(r.model) ?? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
      prev.input += r.input_tokens;
      prev.output += r.output_tokens;
      prev.cacheRead += r.cache_read_tokens;
      prev.cacheWrite += r.cache_creation_tokens;
      modelMap.set(r.model, prev);
    }
    const modelBreakdown = [...modelMap.entries()].map(([model, t]) => ({
      model,
      inputTokens: t.input,
      outputTokens: t.output,
      cacheReadTokens: t.cacheRead,
      cacheCreationTokens: t.cacheWrite,
      totalTokens: t.input + t.output + t.cacheRead + t.cacheWrite,
      costUSD: calcCost(model, t.input, t.output, t.cacheRead, t.cacheWrite),
    }));

    const totalTokens = modelBreakdown.reduce((s, m) => s + m.totalTokens, 0);
    const totalCost = modelBreakdown.reduce((s, m) => s + m.costUSD, 0);
    const totalInput = modelBreakdown.reduce((s, m) => s + m.inputTokens, 0);
    const totalOutput = modelBreakdown.reduce((s, m) => s + m.outputTokens, 0);
    const totalCacheRead = modelBreakdown.reduce((s, m) => s + m.cacheReadTokens, 0);
    const totalCacheWrite = modelBreakdown.reduce((s, m) => s + m.cacheCreationTokens, 0);

    // Derive harnessData by aggregating across models (no extra query!)
    const harnessMap = new Map<string, { input: number; output: number; cacheRead: number; cacheWrite: number; sessions: Set<number> }>();
    for (const r of harnessModelRows) {
      let prev = harnessMap.get(r.harness);
      if (!prev) {
        prev = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, sessions: new Set() };
        harnessMap.set(r.harness, prev);
      }
      prev.input += r.input_tokens;
      prev.output += r.output_tokens;
      prev.cacheRead += r.cache_read_tokens;
      prev.cacheWrite += r.cache_creation_tokens;
      // sessions is COUNT(DISTINCT) per harness×model, but we need per-harness total
      // We'll track it separately below
    }

    // Compute per-harness cost from harnessModelRows (no N+1!)
    const harnessCostMap = new Map<string, number>();
    for (const r of harnessModelRows) {
      const prev = harnessCostMap.get(r.harness) ?? 0;
      harnessCostMap.set(r.harness, prev + calcCost(r.model, r.input_tokens, r.output_tokens, r.cache_read_tokens, r.cache_creation_tokens));
    }

    const harnessData = [...harnessMap.entries()].map(([harness, t]) => ({
      harness,
      inputTokens: t.input,
      outputTokens: t.output,
      cacheReadTokens: t.cacheRead,
      cacheCreationTokens: t.cacheWrite,
      totalTokens: t.input + t.output + t.cacheRead + t.cacheWrite,
      costUSD: harnessCostMap.get(harness) ?? 0,
      cacheEfficiency: t.input > 0 ? t.cacheRead / t.input : 0,
    }));

    // harnessModelBreakdown is just the raw rows
    const harnessModelBreakdown = harnessModelRows;

    // Derive harnessSessions: distinct session count per harness
    const harnessSessionRows = db.prepare(`
      SELECT COALESCE(s.harness, 'unknown') as harness,
             COUNT(DISTINCT s.id) as sessions
      FROM messages m
      JOIN sessions s ON s.id = m.session_id
      WHERE m.model IS NOT NULL AND m.model != '<synthetic>'${dateFilter}
      GROUP BY harness
    `).all(...dateParams) as Array<{ harness: string; sessions: number }>;
    const harnessSessions = harnessSessionRows;

    // Combined tool query: tool calls + by model + by harness in one pass
    const toolRows = db.prepare(`
      SELECT cb.tool_name,
             m.model,
             COALESCE(s.harness, 'unknown') as harness,
             COUNT(*) as count
      FROM content_blocks cb
      JOIN messages m ON m.id = cb.message_id
      JOIN sessions s ON s.id = m.session_id
      WHERE cb.block_type = 'tool_use' AND cb.tool_name IS NOT NULL${dateFilter}
      GROUP BY cb.tool_name, m.model, harness
    `).all(...dateParams) as Array<{ tool_name: string; model: string; harness: string; count: number }>;

    // Derive toolCalls (by tool_name)
    const toolCountMap = new Map<string, number>();
    const toolModelMap = new Map<string, number>();
    const toolHarnessMap = new Map<string, Map<string, number>>();
    for (const r of toolRows) {
      toolCountMap.set(r.tool_name, (toolCountMap.get(r.tool_name) ?? 0) + r.count);
      toolModelMap.set(r.model, (toolModelMap.get(r.model) ?? 0) + r.count);
      if (!toolHarnessMap.has(r.harness)) toolHarnessMap.set(r.harness, new Map());
      const hm = toolHarnessMap.get(r.harness)!;
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

    // Daily tokens by harness
    const dailyByHarness = db.prepare(`
      SELECT DATE(m.timestamp) as date,
             COALESCE(s.harness, 'unknown') as harness,
             SUM(m.input_tokens + m.output_tokens + m.cache_read_tokens + m.cache_creation_tokens) as tokens,
             COUNT(*) as messages
      FROM messages m
      JOIN sessions s ON s.id = m.session_id
      WHERE m.model IS NOT NULL AND m.model != '<synthetic>'${dateFilter}
      GROUP BY date, harness
      ORDER BY date
    `).all(...dateParams) as Array<{ date: string; harness: string; tokens: number; messages: number }>;

    // Content block type breakdown
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

    // Read stats cache for daily activity (non-blocking, fallback to empty)
    let dailyActivity: any[] = [];
    let dailyModelTokens: any[] = [];
    try {
      const raw = await readFile(claudePaths.statsCache, 'utf-8');
      const stats: StatsCache = JSON.parse(raw);
      dailyActivity = stats.dailyActivity ?? [];
      dailyModelTokens = stats.dailyModelTokens ?? [];
    } catch { /* stats cache missing is fine */ }

    return NextResponse.json({
      modelBreakdown,
      totalTokens,
      totalCost,
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
    });
  } catch (err) {
    return NextResponse.json(
      { error: 'Failed to read token data', detail: String(err) },
      { status: 500 }
    );
  }
}
