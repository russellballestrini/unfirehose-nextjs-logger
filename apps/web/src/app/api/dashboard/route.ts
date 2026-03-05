import { NextRequest, NextResponse } from 'next/server';
import { getDb } from '@unfirehose/core/db/schema';

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

const TIME_RANGES: Record<string, number> = {
  '1h': 60,
  '3h': 180,
  '6h': 360,
  '12h': 720,
  '24h': 1440,
  '7d': 10080,
  '14d': 20160,
  '28d': 40320,
  'all': 0,
};

export async function GET(request: NextRequest) {
  const range = request.nextUrl.searchParams.get('range') ?? '7d';
  const minutes = TIME_RANGES[range] ?? 10080;

  try {
    const db = getDb();
    const windowStart = minutes > 0
      ? new Date(Date.now() - minutes * 60 * 1000).toISOString()
      : '1970-01-01T00:00:00.000Z';

    // Summary stats
    const summary = db.prepare(`
      SELECT
        COUNT(DISTINCT s.id) as sessions,
        COUNT(DISTINCT m.id) as messages,
        COUNT(DISTINCT m.model) as models
      FROM messages m
      JOIN sessions s ON m.session_id = s.id
      WHERE m.timestamp >= ?
    `).get(windowStart) as any;

    // Model breakdown with costs
    const dbModels = db.prepare(`
      SELECT model,
             SUM(input_tokens) as input_tokens,
             SUM(output_tokens) as output_tokens,
             SUM(cache_read_tokens) as cache_read_tokens,
             SUM(cache_creation_tokens) as cache_creation_tokens
      FROM messages
      WHERE model IS NOT NULL AND model != '<synthetic>'
        AND timestamp >= ?
      GROUP BY model
    `).all(windowStart) as any[];

    const modelBreakdown = dbModels.map((m) => ({
      model: m.model,
      inputTokens: m.input_tokens,
      outputTokens: m.output_tokens,
      cacheReadTokens: m.cache_read_tokens,
      cacheCreationTokens: m.cache_creation_tokens,
      totalTokens: m.input_tokens + m.output_tokens + m.cache_read_tokens + m.cache_creation_tokens,
      costUSD: calcCost(m.model, m.input_tokens, m.output_tokens, m.cache_read_tokens, m.cache_creation_tokens),
    }));

    const totalCost = modelBreakdown.reduce((s, m) => s + m.costUSD, 0);

    // Daily activity (message counts per day)
    const dailyActivity = db.prepare(`
      SELECT DATE(timestamp) as date, COUNT(*) as messageCount
      FROM messages
      WHERE timestamp >= ?
      GROUP BY DATE(timestamp)
      ORDER BY date
    `).all(windowStart) as any[];

    // Hour distribution
    const hourCounts = db.prepare(`
      SELECT CAST(strftime('%H', timestamp) AS INTEGER) as hour, COUNT(*) as count
      FROM messages
      WHERE timestamp >= ?
      GROUP BY hour
      ORDER BY hour
    `).all(windowStart) as any[];

    // Day-of-week distribution (0=Sunday, 6=Saturday)
    const dayOfWeekCounts = db.prepare(`
      SELECT CAST(strftime('%w', timestamp) AS INTEGER) as dow, COUNT(*) as count
      FROM messages
      WHERE timestamp >= ?
      GROUP BY dow
      ORDER BY dow
    `).all(windowStart) as any[];

    // Day-of-week × hour heatmap (for bell curves per day)
    const dowHourCounts = db.prepare(`
      SELECT CAST(strftime('%w', timestamp) AS INTEGER) as dow,
             CAST(strftime('%H', timestamp) AS INTEGER) as hour,
             COUNT(*) as count
      FROM messages
      WHERE timestamp >= ?
      GROUP BY dow, hour
      ORDER BY dow, hour
    `).all(windowStart) as any[];

    // First session date (all time, for the "Since" card)
    const firstSession = db.prepare(`
      SELECT MIN(timestamp) as first FROM messages WHERE timestamp IS NOT NULL
    `).get() as any;

    return NextResponse.json({
      range,
      summary: {
        sessions: summary?.sessions ?? 0,
        messages: summary?.messages ?? 0,
        models: summary?.models ?? 0,
        totalCost: Math.round(totalCost * 100) / 100,
        since: firstSession?.first?.split('T')[0] ?? null,
      },
      modelBreakdown,
      dailyActivity,
      hourCounts: hourCounts.map((h: any) => ({ hour: h.hour, count: h.count })),
      dayOfWeekCounts: dayOfWeekCounts.map((d: any) => ({
        day: ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][d.dow],
        dow: d.dow,
        count: d.count,
      })),
      dowHourHeatmap: dowHourCounts.map((d: any) => ({
        day: ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][d.dow],
        dow: d.dow,
        hour: d.hour,
        count: d.count,
      })),
    });
  } catch (err) {
    return NextResponse.json(
      { error: 'Failed to load dashboard', detail: String(err) },
      { status: 500 }
    );
  }
}
