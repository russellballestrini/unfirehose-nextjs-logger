import { NextRequest, NextResponse } from 'next/server';
import { getDb } from '@unturf/unfirehose/db/schema';
import {
  syncPricing,
  hydratePricing,
  catalogAge,
  recentSyncRuns,
  recentPriceChanges,
  priceHistory,
  unpricedModels,
  ORACLE_URLS,
} from '@unturf/unfirehose/pricing-sync';
import {
  CATALOG_SOURCES,
  LIST_PRICE_SOURCES,
  catalogStats,
  resolvePrice,
  priceConsensus,
  aliasCandidates,
  MODEL_ALIASES,
  PROMO_DISCOUNTS,
  SYNTHETIC_MODELS,
  SELF_HOST_HARDWARE,
  getKwhRate,
} from '@unturf/unfirehose/pricing';

export const dynamic = 'force-dynamic';

/**
 * GET /api/pricing
 *   The book: every oracle's status, the sync register, prices that moved in
 *   the last 30 days, and a resolution + consensus report for every model in
 *   our DB so a missing price or a disagreeing oracle is visible instead of
 *   silently rendering as $0 or silently winning by preference order.
 *
 * GET /api/pricing?model=claude-opus-5[&at=2026-06-01]
 *   How one model name resolves — candidates tried, each oracle's answer,
 *   whether they agree — optionally as of a past instant.
 *
 * GET /api/pricing?history=anthropic/claude-opus-5
 *   The step series for one upstream id across every book. Chart fodder.
 *
 * POST /api/pricing
 *   Force a sync from every oracle. Written to the register as trigger=api.
 */
export async function GET(req: NextRequest) {
  const db = getDb();
  hydratePricing(db);
  const q = req.nextUrl.searchParams;

  const model = q.get('model');
  if (model) {
    const at = q.get('at');
    return NextResponse.json({
      model,
      at: at ?? null,
      candidates: aliasCandidates(model),
      resolved: Object.fromEntries(
        CATALOG_SOURCES.map((s) => [s, resolvePrice(model, [s], at) ?? null]),
      ),
      preferred: resolvePrice(model, undefined, at) ?? null,
      consensus: priceConsensus(model, at),
    });
  }

  const historyId = q.get('history');
  if (historyId) {
    return NextResponse.json({ modelId: historyId, rows: priceHistory(historyId, db) });
  }

  // Every model we have actually logged, with the price we would apply today
  // and whether the list-price books agree on it.
  const rows = db
    .prepare(
      `SELECT model,
              SUM(input_tokens)          AS input,
              SUM(output_tokens)         AS output,
              SUM(cache_read_tokens)     AS cache_read,
              SUM(cache_creation_tokens) AS cache_write,
              MAX(timestamp)             AS last_seen
         FROM messages
        WHERE model IS NOT NULL AND model != ''
        GROUP BY model
        ORDER BY SUM(input_tokens + output_tokens + cache_read_tokens + cache_creation_tokens) DESC`,
    )
    .all() as Array<{
      model: string;
      input: number;
      output: number;
      cache_read: number;
      cache_write: number;
      last_seen: string;
    }>;

  const coverage = rows.map((r) => {
    const p = resolvePrice(r.model);
    const c = priceConsensus(r.model);
    return {
      model: r.model,
      totalTokens: r.input + r.output + r.cache_read + r.cache_write,
      lastSeen: r.last_seen,
      priced: !!p && p.source !== 'unknown',
      source: p?.source ?? 'unknown',
      matchedId: p?.matchedId ?? null,
      price: p ? { input: p.input, output: p.output, cacheRead: p.cacheRead, cacheWrite: p.cacheWrite } : null,
      effectiveFrom: p?.effectiveFrom ?? null,
      synthetic: SYNTHETIC_MODELS.has(r.model.toLowerCase()),
      books: c.quotes.length,
      corroborated: c.corroborated,
      agree: c.agree,
      spread: c.spread,
      quotes: c.quotes,
      resale: c.resale,
    };
  });

  const stats = catalogStats();
  return NextResponse.json({
    oracles: CATALOG_SOURCES.map((s) => ({
      source: s,
      url: ORACLE_URLS[s],
      listPrice: LIST_PRICE_SOURCES.includes(s),
      models: stats[s].models,
      ageSeconds: catalogAge(s, db),
    })),
    register: recentSyncRuns(db, 30),
    recentChanges: recentPriceChanges(db, 30 * 86400, 200),
    pins: MODEL_ALIASES,
    promos: PROMO_DISCOUNTS,
    selfHost: {
      kwhRateUSD: getKwhRate(),
      hardware: SELF_HOST_HARDWARE,
    },
    coverage,
    unpriced: coverage.filter((c) => !c.priced && !c.synthetic && c.totalTokens > 0),
    disagreements: coverage.filter((c) => c.books > 1 && !c.agree),
    unpricedRecent: unpricedModels(db, 24),
  });
}

export async function POST() {
  const db = getDb();
  const results = await syncPricing(db, { trigger: 'api' });
  return NextResponse.json({
    results,
    catalog: catalogStats(),
  });
}
