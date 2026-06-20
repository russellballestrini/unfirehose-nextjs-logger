import { NextRequest, NextResponse } from 'next/server';
import { getDb } from '@unturf/unfirehose/db/schema';
import { calcCostBreakdown, hostForMessage, getKwhRate, CLOUD_PROVIDERS, PRICING } from '@unturf/unfirehose/pricing';
import { Timing } from '@/lib/timing';

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
  const t = new Timing();
  const range = request.nextUrl.searchParams.get('range') ?? '7d';
  const minutes = TIME_RANGES[range] ?? 10080;

  try {
    const db = getDb();
    t.mark('db_open');
    const windowStart = minutes > 0
      ? new Date(Date.now() - minutes * 60 * 1000).toISOString()
      : '1970-01-01T00:00:00.000Z';

    // Combined summary: drop the unnecessary JOIN to sessions — every message
    // already carries session_id, so we can count distinct directly on the
    // message rows. Also folds the standalone `models` count into this scan.
    const summary = db.prepare(`
      SELECT
        COUNT(DISTINCT session_id) AS sessions,
        COUNT(*) AS messages,
        COUNT(DISTINCT model) AS models
      FROM messages
      WHERE timestamp >= ?
    `).get(windowStart) as any;
    t.mark('summary');

    // Combined model breakdown + attribution: one GROUP BY (model, endpoint,
    // provider) gives us both per-model token sums and the per-endpoint
    // breakdown we need to pick the dominant attribution. Saves a full
    // pass over messages compared to the two-query version.
    const dbModelEndpoints = db.prepare(`
      SELECT model, endpoint, provider,
             SUM(input_tokens) AS input_tokens,
             SUM(output_tokens) AS output_tokens,
             SUM(cache_read_tokens) AS cache_read_tokens,
             SUM(cache_creation_tokens) AS cache_creation_tokens,
             MAX(timestamp) AS last_seen
      FROM messages
      WHERE model IS NOT NULL
        AND timestamp >= ?
      GROUP BY model, endpoint, provider
    `).all(windowStart) as Array<{
      model: string;
      endpoint: string | null;
      provider: string | null;
      input_tokens: number;
      output_tokens: number;
      cache_read_tokens: number;
      cache_creation_tokens: number;
      last_seen: string | null;
    }>;
    t.mark('models_attribution');

    // Roll up per-(model, endpoint, provider) rows into per-model rows, while
    // tracking the dominant (endpoint, provider) by total tokens — replaces
    // both the standalone `models` GROUP-BY and the dominantAttr loop.
    const dominantAttr: Record<string, { endpoint: string | null; provider: string | null; _tot: number }> = {};
    const dbModelsMap: Record<string, {
      model: string;
      input_tokens: number;
      output_tokens: number;
      cache_read_tokens: number;
      cache_creation_tokens: number;
      last_seen: string | null;
    }> = {};
    for (const r of dbModelEndpoints) {
      if (r.model === '<synthetic>') continue;
      const tot = r.input_tokens + r.output_tokens + r.cache_read_tokens + r.cache_creation_tokens;
      const prevAttr = dominantAttr[r.model];
      if (!prevAttr || tot > prevAttr._tot) {
        dominantAttr[r.model] = { endpoint: r.endpoint, provider: r.provider, _tot: tot };
      }
      const prev = dbModelsMap[r.model];
      if (prev) {
        prev.input_tokens += r.input_tokens;
        prev.output_tokens += r.output_tokens;
        prev.cache_read_tokens += r.cache_read_tokens;
        prev.cache_creation_tokens += r.cache_creation_tokens;
        if (r.last_seen && (!prev.last_seen || r.last_seen > prev.last_seen)) {
          prev.last_seen = r.last_seen;
        }
      } else {
        dbModelsMap[r.model] = {
          model: r.model,
          input_tokens: r.input_tokens,
          output_tokens: r.output_tokens,
          cache_read_tokens: r.cache_read_tokens,
          cache_creation_tokens: r.cache_creation_tokens,
          last_seen: r.last_seen,
        };
      }
    }
    const dbModels = Object.values(dbModelsMap);

    // Recency cutoff: model must have activity in the most-recent half of the
    // window. For 'all' (minutes=0), use a 30-day floor so we don't auto-show
    // every model that ever ran.
    const halfWindowMs = minutes > 0
      ? (minutes * 60 * 1000) / 2
      : 30 * 24 * 60 * 60 * 1000;
    const recencyCutoff = new Date(Date.now() - halfWindowMs).toISOString();

    // Self-hosted attribution: integrate gpu_power_watts from mesh_snapshots
    // over the window for each known host, then split by tokens-per-host so
    // multiple models on the same node share the measured energy.
    // SQLite datetime('now') stores 'YYYY-MM-DD HH:MM:SS' (no T, no Z).
    const meshSince = minutes > 0
      ? new Date(Date.now() - minutes * 60 * 1000).toISOString().replace('T', ' ').slice(0, 19)
      : '1970-01-01 00:00:00';
    // Only count active-inference samples — gpu_util > 30% — so idle box
    // hours don't smear the per-model attribution.
    const meshRows = db.prepare(`
      SELECT hostname, timestamp, gpu_power_watts
      FROM mesh_snapshots
      WHERE timestamp > ?
        AND gpu_power_watts IS NOT NULL AND gpu_power_watts > 0
        AND gpu_util IS NOT NULL AND gpu_util > 30
      ORDER BY hostname ASC, timestamp ASC
    `).all(meshSince) as Array<{ hostname: string; timestamp: string; gpu_power_watts: number }>;
    t.mark('mesh_query');

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

    const attrFor = (model: string) => {
      const a = dominantAttr[model];
      let provider = a?.provider ?? null;
      const endpoint = a?.endpoint ?? null;
      // Backstop: legacy rows missing provider, but the model is in our
      // Anthropic price table — must be a cloud call.
      if (!provider && PRICING[model]) provider = 'anthropic';
      // Cloud-provider claims override any model-name regex match.
      if (provider && CLOUD_PROVIDERS.has(provider)) {
        return { host: null, endpoint, provider };
      }
      return { host: hostForMessage(model, endpoint, provider), endpoint, provider };
    };

    // First pass: sum tokens per host so we can split kWh proportionally.
    const tokensByHost: Record<string, number> = {};
    for (const m of dbModels) {
      const { host } = attrFor(m.model);
      if (!host) continue;
      const tot = m.input_tokens + m.output_tokens + m.cache_read_tokens + m.cache_creation_tokens;
      tokensByHost[host] = (tokensByHost[host] ?? 0) + tot;
    }

    const kwhRate = getKwhRate();
    const modelBreakdown = dbModels.map((m) => {
      const totalTokens = m.input_tokens + m.output_tokens + m.cache_read_tokens + m.cache_creation_tokens;
      const c = calcCostBreakdown(m.model, m.input_tokens, m.output_tokens, m.cache_read_tokens, m.cache_creation_tokens);
      const { host, provider, endpoint } = attrFor(m.model);
      let meshObservedUSD: number | undefined;
      if (host && kwhByHost[host] != null && tokensByHost[host] > 0) {
        const hostCost = kwhByHost[host] * kwhRate;
        meshObservedUSD = hostCost * (totalTokens / tokensByHost[host]);
      }
      return {
        model: m.model,
        inputTokens: m.input_tokens,
        outputTokens: m.output_tokens,
        cacheReadTokens: m.cache_read_tokens,
        cacheCreationTokens: m.cache_creation_tokens,
        totalTokens,
        inputCostUSD: c.input,
        outputCostUSD: c.output,
        cacheReadCostUSD: c.cacheRead,
        cacheWriteCostUSD: c.cacheWrite,
        costUSD: c.total,
        costSource: PRICING[m.model] ? ('api' as const) : ('estimate' as const),
        host,
        provider,
        endpoint,
        meshObservedUSD,
      };
    })
      .filter((m) => m.totalTokens > 0)
      .filter((m) => {
        const row = dbModelsMap[m.model];
        return !row?.last_seen || row.last_seen >= recencyCutoff;
      })
      .sort((a, b) => b.totalTokens - a.totalTokens);

    const totalCost = modelBreakdown.reduce((s, m) => s + m.costUSD, 0);
    t.mark('cost_attribute');

    // Combined date+hour activity: substr is much cheaper than strftime+DATE
    // (~150ms vs ~410ms on 121k rows). One scan replaces the four separate
    // queries for daily / hours / dow / dow_hour — we aggregate them in JS
    // from this single (date, hour) result set. Day-of-week is derived from
    // the date string (small fixed cost, <10 unique dates per window).
    const dateHourCounts = db.prepare(`
      SELECT substr(timestamp, 1, 10) AS date,
             CAST(substr(timestamp, 12, 2) AS INTEGER) AS hour,
             COUNT(*) AS count
      FROM messages
      WHERE timestamp >= ?
      GROUP BY date, hour
      ORDER BY date, hour
    `).all(windowStart) as Array<{ date: string; hour: number; count: number }>;
    t.mark('date_hour');

    // Derive daily, hours, dow, dow_hour in JS from the combined result.
    const dailyMap = new Map<string, number>();
    const hourMap = new Map<number, number>();
    const dowMap = new Map<number, number>();
    const dowHourMap = new Map<string, { dow: number; hour: number; count: number }>();
    const dowCache = new Map<string, number>();
    for (const r of dateHourCounts) {
      dailyMap.set(r.date, (dailyMap.get(r.date) ?? 0) + r.count);
      hourMap.set(r.hour, (hourMap.get(r.hour) ?? 0) + r.count);
      let dow = dowCache.get(r.date);
      if (dow === undefined) {
        // Date string is 'YYYY-MM-DD' — UTC midnight is unambiguous.
        dow = new Date(r.date + 'T00:00:00Z').getUTCDay();
        dowCache.set(r.date, dow);
      }
      dowMap.set(dow, (dowMap.get(dow) ?? 0) + r.count);
      const key = `${dow}-${r.hour}`;
      const existing = dowHourMap.get(key);
      if (existing) {
        existing.count += r.count;
      } else {
        dowHourMap.set(key, { dow, hour: r.hour, count: r.count });
      }
    }
    const dailyActivity = Array.from(dailyMap, ([date, messageCount]) => ({ date, messageCount }))
      .sort((a, b) => a.date.localeCompare(b.date));
    const hourCounts = Array.from(hourMap, ([hour, count]) => ({ hour, count }))
      .sort((a, b) => a.hour - b.hour);
    const dayOfWeekCountsRaw = Array.from(dowMap, ([dow, count]) => ({ dow, count }))
      .sort((a, b) => a.dow - b.dow);
    const dowHourCountsRaw = Array.from(dowHourMap.values())
      .sort((a, b) => a.dow - b.dow || a.hour - b.hour);
    t.mark('aggregate_js');

    // First session date (all time, for the "Since" card)
    const firstSession = db.prepare(`
      SELECT MIN(timestamp) AS first FROM messages WHERE timestamp IS NOT NULL
    `).get() as any;
    t.mark('first_session');

    const dayLabels = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
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
      hourCounts,
      dayOfWeekCounts: dayOfWeekCountsRaw.map((d) => ({
        day: dayLabels[d.dow],
        dow: d.dow,
        count: d.count,
      })),
      dowHourHeatmap: dowHourCountsRaw.map((d) => ({
        day: dayLabels[d.dow],
        dow: d.dow,
        hour: d.hour,
        count: d.count,
      })),
    }, { headers: { 'Server-Timing': t.header() } });
  } catch (err) {
    return NextResponse.json(
      { error: 'Failed to load dashboard', detail: String(err) },
      { status: 500 }
    );
  }
}
