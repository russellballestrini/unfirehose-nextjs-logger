import { NextRequest, NextResponse } from 'next/server';
import { getDb } from '@unturf/unfirehose/db/schema';
import { costForUsageRows, hostForMessage, getKwhRate, CLOUD_PROVIDERS, priceForModel } from '@unturf/unfirehose/pricing';
import { ensurePricingHydrated } from '@unturf/unfirehose/pricing-sync';
import { usageCacheHitRate, cacheHitRate } from '@unturf/unfirehose/vllm-metrics';
import { VLLM_BLOCK_TOKENS } from '@unturf/unfirehose/prefix-reuse';
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
    // Cost math reads an in-memory price catalog; make sure it reflects what
    // the worker last synced from our oracles.
    ensurePricingHydrated(db);
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
    // Grouped by day as well, so each day's tokens book at that day's price
    // (see the price ledger, ticket 4008). The per-model sums below are sums
    // of daily bookings, not window totals priced at today's rate.
    const dbModelEndpoints = db.prepare(`
      SELECT model, endpoint, provider, substr(timestamp, 1, 10) AS day,
             SUM(input_tokens) AS input_tokens,
             SUM(output_tokens) AS output_tokens,
             SUM(cache_read_tokens) AS cache_read_tokens,
             SUM(cache_creation_tokens) AS cache_creation_tokens,
             -- Split each day by whether the gateway quoted a price. An
             -- invoiced group books what we were charged; an unpriced one
             -- falls back to tokens times list price. Mixing them in one
             -- bucket would force a choice between ignoring real invoices
             -- and inventing them for calls that never carried one.
             (observed_cost_usd IS NOT NULL) AS priced,
             SUM(observed_cost_usd) AS observed_cost,
             MAX(timestamp) AS last_seen
      FROM messages
      WHERE model IS NOT NULL
        AND timestamp >= ?
      GROUP BY model, endpoint, provider, day, priced
    `).all(windowStart) as Array<{
      model: string;
      endpoint: string | null;
      provider: string | null;
      day: string;
      input_tokens: number;
      output_tokens: number;
      cache_read_tokens: number;
      cache_creation_tokens: number;
      priced: number;
      observed_cost: number | null;
      last_seen: string | null;
    }>;
    t.mark('models_attribution');

    // Roll up per-(model, endpoint, provider, day) rows into per-model rows,
    // keeping the per-day token split for pricing, while tracking the
    // dominant (endpoint, provider) by total tokens across the whole window.
    // observedUSD is the price the gateway quoted for this bucket, or null
    // when it quoted none. It rides alongside the tokens so pricing can
    // prefer the invoice per day rather than per model — a model can be
    // invoiced today and estimated yesterday.
    type DayTokens = { day: string; input: number; output: number; cacheRead: number; cacheWrite: number; observedUSD: number | null };
    const attrTotals: Record<string, Record<string, { endpoint: string | null; provider: string | null; tot: number }>> = {};
    const dominantAttr: Record<string, { endpoint: string | null; provider: string | null; _tot: number }> = {};
    const dbModelsMap: Record<string, {
      model: string;
      input_tokens: number;
      output_tokens: number;
      cache_read_tokens: number;
      cache_creation_tokens: number;
      last_seen: string | null;
      days: DayTokens[];
    }> = {};
    for (const r of dbModelEndpoints) {
      if (r.model === '<synthetic>') continue;
      const tot = r.input_tokens + r.output_tokens + r.cache_read_tokens + r.cache_creation_tokens;
      const attrKey = `${r.endpoint ?? ''}\x00${r.provider ?? ''}`;
      const byAttr = (attrTotals[r.model] ??= {});
      const a = (byAttr[attrKey] ??= { endpoint: r.endpoint, provider: r.provider, tot: 0 });
      a.tot += tot;
      const prevAttr = dominantAttr[r.model];
      if (!prevAttr || a.tot > prevAttr._tot) {
        dominantAttr[r.model] = { endpoint: a.endpoint, provider: a.provider, _tot: a.tot };
      }
      const day: DayTokens = {
        day: r.day, input: r.input_tokens, output: r.output_tokens,
        cacheRead: r.cache_read_tokens, cacheWrite: r.cache_creation_tokens,
        observedUSD: r.priced ? (r.observed_cost ?? null) : null,
      };
      const prev = dbModelsMap[r.model];
      if (prev) {
        prev.input_tokens += r.input_tokens;
        prev.output_tokens += r.output_tokens;
        prev.cache_read_tokens += r.cache_read_tokens;
        prev.cache_creation_tokens += r.cache_creation_tokens;
        prev.days.push(day);
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
          days: [day],
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
      if (!provider && priceForModel(model)) provider = 'anthropic';
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

    // Measured prefix cache, for the models we serve ourselves.
    //
    // A self-hosted model reports no cache_read tokens, so usage-based cache
    // math reads 0% for it however well the cache is working. vLLM counts the
    // real thing and we already sample it every minute into
    // vllm_cache_samples — it was simply stranded on one table on the Tokens
    // page and never reached the model rows anyone actually reads.
    //
    // Counters, differenced across the window, per (host, model), then summed
    // across hosts: the same model on two nodes is one model's cache.
    const vllmStart = windowStart.replace('T', ' ').slice(0, 19);
    const vllmRows = db.prepare(`
      SELECT hostname, model, queries, hits
        FROM vllm_cache_samples
       WHERE timestamp >= ?
       ORDER BY hostname, model, timestamp
    `).all(vllmStart) as Array<{ hostname: string; model: string; queries: number; hits: number }>;

    const perHost = new Map<string, { first: typeof vllmRows[0]; last: typeof vllmRows[0] }>();
    for (const r of vllmRows) {
      const k = `${r.hostname}\u0000${r.model}`;
      const cur = perHost.get(k);
      if (cur) cur.last = r;
      else perHost.set(k, { first: r, last: r });
    }
    const measuredByModel = new Map<string, { queries: number; hits: number; hosts: Set<string> }>();
    for (const [k, { first, last }] of perHost) {
      const [hostname, model] = k.split('\u0000');
      // One sample is not a window; a lone reading has no delta to report.
      const before = first === last ? undefined : { model, queries: first.queries, hits: first.hits };
      const w = cacheHitRate(before, { model, queries: last.queries, hits: last.hits });
      const acc = measuredByModel.get(model) ?? { queries: 0, hits: 0, hosts: new Set<string>() };
      acc.queries += w.queries;
      acc.hits += w.hits;
      acc.hosts.add(hostname);
      measuredByModel.set(model, acc);
    }

    // How much of each self-hosted model's prompt was a re-send of something
    // we had already sent it. vLLM will not report per-request cache hits
    // (vllm#44961), and its Prometheus counters describe the NODE rather than
    // our traffic — one 7-day window showed 6.6B query tokens across the mesh
    // against 791M of our own, so their ratio is not our hit rate. This is
    // derived from our own conversations instead: an agent loop appends, so
    // the prefix shared with the previous call is that call's whole prompt.
    // A ceiling, not a measurement — the UI must say so.
    const reuseRows = db.prepare(`
      SELECT model,
             SUM(input_tokens) AS prompt_tokens,
             SUM((min(COALESCE(prev, 0), input_tokens) / ?) * ?) AS reusable_tokens
        FROM (
          SELECT model, input_tokens,
                 LAG(input_tokens) OVER (
                   PARTITION BY session_id ORDER BY timestamp
                 ) AS prev
            FROM messages
           WHERE model IS NOT NULL
             AND timestamp >= ?
             AND input_tokens > 0
             AND cache_read_tokens = 0
        )
       GROUP BY model
    `).all(VLLM_BLOCK_TOKENS, VLLM_BLOCK_TOKENS, windowStart) as Array<{
      model: string; prompt_tokens: number; reusable_tokens: number;
    }>;
    const reuseByModel = new Map(reuseRows.map((r) => [r.model, r]));

    const kwhRate = getKwhRate();
    const modelBreakdown = dbModels.map((m) => {
      const totalTokens = m.input_tokens + m.output_tokens + m.cache_read_tokens + m.cache_creation_tokens;
      const { host, provider, endpoint } = attrFor(m.model);
      // selfHosted and oracle preference are decided inside costForUsage, so
      // this route cannot disagree with any other page about either. One
      // booking per day, at that day's price, summed.
      const c = costForUsageRows(m.days.map((d) => ({
        model: m.model,
        input: d.input,
        output: d.output,
        cacheRead: d.cacheRead,
        cacheWrite: d.cacheWrite,
        provider,
        endpoint,
        at: d.day,
        observedUSD: d.observedUSD,
      })));
      let meshObservedUSD: number | undefined;
      if (host && kwhByHost[host] != null && tokensByHost[host] > 0) {
        const hostCost = kwhByHost[host] * kwhRate;
        meshObservedUSD = hostCost * (totalTokens / tokensByHost[host]);
      }
      const measured = measuredByModel.get(m.model);
      const reuse = reuseByModel.get(m.model);
      // Nothing reported a cache for this model all window — the condition
      // vllm#44961 leaves us in, and the only one where an estimate helps.
      const reportsNoCache = m.cache_read_tokens === 0 && m.cache_creation_tokens === 0;
      return {
        model: m.model,
        // What vLLM measured, when we serve this model ourselves. Null for a
        // cloud model, which reports its cache in the usage fields instead.
        measuredCacheHitRate:
          measured && measured.queries > 0
            ? Math.min(1, measured.hits / measured.queries)
            : null,
        measuredCacheQueries: measured?.queries ?? null,
        measuredCacheHits: measured?.hits ?? null,
        measuredCacheNodes: measured ? [...measured.hosts].sort() : null,
        // Derived from our own conversation shape — see reuseRows above.
        // Gated on the MODEL reporting no cache at all across the window, not
        // on individual rows: a provider that tells us the truth is never
        // second-guessed by an estimate, and a handful of stray zero-cache
        // messages on an otherwise-reporting model is noise, not a signal.
        structuralReuseTokens: reportsNoCache ? (reuse?.reusable_tokens ?? null) : null,
        structuralReuseRate:
          reportsNoCache && reuse && reuse.prompt_tokens > 0
            ? Math.min(1, reuse.reusable_tokens / reuse.prompt_tokens)
            : null,
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
        // What these tokens would cost at oracle rates whoever served them,
        // and what running them ourselves saved. Zero for cloud rows.
        marketUSD: c.market,
        // What we actually spent on power to serve it ourselves. Zero for a
        // row we bought.
        energyUSD: c.energy,
        avoidedUSD: c.avoided,
        costSource: c.source,
        pricedAgainst: c.matchedId ?? null,
        // Non-null when a promo was unwound: the figure is list price, not
        // what the provider bills today.
        promo: c.promo ?? null,
        selfHosted: c.selfHosted,
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
    // Token totals sum the same filtered breakdown the table renders, so the
    // headline card and the table below it always reconcile. Cache read and
    // cache write are counted — on a Claude Code workload they are ~92% of
    // every token moved, and a total that omits them is not a total.
    const totalInput = modelBreakdown.reduce((s, m) => s + m.inputTokens, 0);
    const totalOutput = modelBreakdown.reduce((s, m) => s + m.outputTokens, 0);
    const totalCacheRead = modelBreakdown.reduce((s, m) => s + m.cacheReadTokens, 0);
    const totalCacheWrite = modelBreakdown.reduce((s, m) => s + m.cacheCreationTokens, 0);
    const totalTokens = totalInput + totalOutput + totalCacheRead + totalCacheWrite;
    const costSplit = {
      input: modelBreakdown.reduce((s, m) => s + m.inputCostUSD, 0),
      output: modelBreakdown.reduce((s, m) => s + m.outputCostUSD, 0),
      cacheRead: modelBreakdown.reduce((s, m) => s + m.cacheReadCostUSD, 0),
      cacheWrite: modelBreakdown.reduce((s, m) => s + m.cacheWriteCostUSD, 0),
    };
    const totalCacheCost = costSplit.cacheRead + costSplit.cacheWrite;
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
        totalTokens,
        inputTokens: totalInput,
        outputTokens: totalOutput,
        cacheReadTokens: totalCacheRead,
        cacheWriteTokens: totalCacheWrite,
        cacheHitRate: usageCacheHitRate(totalInput, totalCacheRead),
        cacheCost: Math.round(totalCacheCost * 100) / 100,
        costSplit,
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
