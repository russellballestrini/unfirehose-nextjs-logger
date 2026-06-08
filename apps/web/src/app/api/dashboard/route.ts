import { NextRequest, NextResponse } from 'next/server';
import { getDb } from '@unturf/unfirehose/db/schema';
import { calcCost, hostForModel, getKwhRate } from '@unturf/unfirehose/pricing';

/* eslint-disable @typescript-eslint/no-explicit-any */

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

    // Self-hosted attribution: integrate gpu_power_watts from mesh_snapshots
    // over the window for each known host, then split by tokens-per-host so
    // multiple models on the same node share the measured energy.
    // SQLite datetime('now') stores 'YYYY-MM-DD HH:MM:SS' (no T, no Z).
    const meshSince = minutes > 0
      ? new Date(Date.now() - minutes * 60 * 1000).toISOString().replace('T', ' ').slice(0, 19)
      : '1970-01-01 00:00:00';
    const meshRows = db.prepare(`
      SELECT hostname, timestamp, gpu_power_watts
      FROM mesh_snapshots
      WHERE timestamp > ? AND gpu_power_watts IS NOT NULL AND gpu_power_watts > 0
      ORDER BY hostname ASC, timestamp ASC
    `).all(meshSince) as Array<{ hostname: string; timestamp: string; gpu_power_watts: number }>;

    const kwhByHost: Record<string, number> = {};
    const lastByHost: Record<string, { ts: number; w: number }> = {};
    for (const r of meshRows) {
      const tsMs = Date.parse(r.timestamp.replace(' ', 'T') + 'Z');
      const prev = lastByHost[r.hostname];
      if (prev) {
        const dtH = (tsMs - prev.ts) / 3_600_000;
        if (dtH > 0 && dtH < 5 / 60) {   // ignore gaps > 5 min (node offline)
          kwhByHost[r.hostname] = (kwhByHost[r.hostname] ?? 0) + (prev.w / 1000) * dtH;
        }
      }
      lastByHost[r.hostname] = { ts: tsMs, w: r.gpu_power_watts };
    }

    // First pass: sum tokens per host so we can split kWh proportionally.
    const tokensByHost: Record<string, number> = {};
    for (const m of dbModels) {
      const host = hostForModel(m.model);
      if (!host) continue;
      const tot = m.input_tokens + m.output_tokens + m.cache_read_tokens + m.cache_creation_tokens;
      tokensByHost[host] = (tokensByHost[host] ?? 0) + tot;
    }

    const kwhRate = getKwhRate();
    const modelBreakdown = dbModels.map((m) => {
      const totalTokens = m.input_tokens + m.output_tokens + m.cache_read_tokens + m.cache_creation_tokens;
      let costUSD = calcCost(m.model, m.input_tokens, m.output_tokens, m.cache_read_tokens, m.cache_creation_tokens);
      const host = hostForModel(m.model);
      let costSource: 'api' | 'mesh' | 'estimate' = host ? 'estimate' : 'api';
      if (host && kwhByHost[host] != null && tokensByHost[host] > 0) {
        const hostCost = kwhByHost[host] * kwhRate;
        costUSD = hostCost * (totalTokens / tokensByHost[host]);
        costSource = 'mesh';
      }
      return {
        model: m.model,
        inputTokens: m.input_tokens,
        outputTokens: m.output_tokens,
        cacheReadTokens: m.cache_read_tokens,
        cacheCreationTokens: m.cache_creation_tokens,
        totalTokens,
        costUSD,
        costSource,
        host,
      };
    }).sort((a, b) => b.totalTokens - a.totalTokens);

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
