import { readFile } from 'fs/promises';
import { claudePaths } from '@sexy-logger/core/claude-paths';
import { NextRequest, NextResponse } from 'next/server';
import type { StatsCache } from '@sexy-logger/core/types';
import { getDb } from '@sexy-logger/core/db/schema';

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
    const raw = await readFile(claudePaths.statsCache, 'utf-8');
    const stats: StatsCache = JSON.parse(raw);

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

    // Get real token numbers from SQLite
    const db = getDb();
    const dbModels = db.prepare(`
      SELECT model,
             SUM(input_tokens) as input_tokens,
             SUM(output_tokens) as output_tokens,
             SUM(cache_read_tokens) as cache_read_tokens,
             SUM(cache_creation_tokens) as cache_creation_tokens
      FROM messages m
      WHERE model IS NOT NULL AND model != '<synthetic>'${dateFilter}
      GROUP BY model
    `).all(...dateParams) as Array<{
      model: string;
      input_tokens: number;
      output_tokens: number;
      cache_read_tokens: number;
      cache_creation_tokens: number;
    }>;

    const modelBreakdown = dbModels.map((m) => {
      const cost = calcCost(m.model, m.input_tokens, m.output_tokens, m.cache_read_tokens, m.cache_creation_tokens);
      return {
        model: m.model,
        inputTokens: m.input_tokens,
        outputTokens: m.output_tokens,
        cacheReadTokens: m.cache_read_tokens,
        cacheCreationTokens: m.cache_creation_tokens,
        totalTokens: m.input_tokens + m.output_tokens + m.cache_read_tokens + m.cache_creation_tokens,
        costUSD: cost,
      };
    });

    const totalTokens = modelBreakdown.reduce((s, m) => s + m.totalTokens, 0);
    const totalCost = modelBreakdown.reduce((s, m) => s + m.costUSD, 0);
    const totalInput = modelBreakdown.reduce((s, m) => s + m.inputTokens, 0);
    const totalOutput = modelBreakdown.reduce((s, m) => s + m.outputTokens, 0);
    const totalCacheRead = modelBreakdown.reduce((s, m) => s + m.cacheReadTokens, 0);
    const totalCacheWrite = modelBreakdown.reduce((s, m) => s + m.cacheCreationTokens, 0);

    // Tool call breakdown from SQLite
    const toolCalls = db.prepare(`
      SELECT cb.tool_name, COUNT(*) as count
      FROM content_blocks cb
      JOIN messages m ON m.id = cb.message_id
      WHERE cb.block_type = 'tool_use' AND cb.tool_name IS NOT NULL${dateFilter}
      GROUP BY cb.tool_name
      ORDER BY count DESC
    `).all(...dateParams) as Array<{ tool_name: string; count: number }>;

    // Tool calls by model
    const toolsByModel = db.prepare(`
      SELECT m.model, COUNT(cb.id) as count
      FROM content_blocks cb
      JOIN messages m ON m.id = cb.message_id
      WHERE cb.block_type = 'tool_use'${dateFilter}
      GROUP BY m.model
      ORDER BY count DESC
    `).all(...dateParams) as Array<{ model: string; count: number }>;

    // Daily token usage from stats cache (line chart data)
    const dailyModelTokens = stats.dailyModelTokens ?? [];

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
      dailyActivity: stats.dailyActivity,
      dailyModelTokens,
      blockTypes,
    });
  } catch (err) {
    return NextResponse.json(
      { error: 'Failed to read token data', detail: String(err) },
      { status: 500 }
    );
  }
}
