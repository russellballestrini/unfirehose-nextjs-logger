import { NextRequest, NextResponse } from 'next/server';
import { getDb } from '@unturf/unfirehose/db/schema';
import {
  syncPricing,
  hydratePricing,
  catalogAge,
  ORACLE_URLS,
} from '@unturf/unfirehose/pricing-sync';
import {
  CATALOG_SOURCES,
  catalogStats,
  resolvePrice,
  aliasCandidates,
  MODEL_ALIASES,
  SYNTHETIC_MODELS,
  SELF_HOST_HARDWARE,
  getKwhRate,
} from '@unturf/unfirehose/pricing';

export const dynamic = 'force-dynamic';

/**
 * GET /api/pricing
 *   Catalog status, plus a resolution report for every model in our DB so a
 *   missing price is visible instead of silently rendering as $0.
 *
 * GET /api/pricing?model=claude-opus-5
 *   Show how one model name resolves — candidates tried, oracle that won.
 *
 * POST /api/pricing
 *   Force a sync from both oracles.
 */
export async function GET(req: NextRequest) {
  const db = getDb();
  hydratePricing(db);

  const model = req.nextUrl.searchParams.get('model');
  if (model) {
    return NextResponse.json({
      model,
      candidates: aliasCandidates(model),
      resolved: Object.fromEntries(
        CATALOG_SOURCES.map((s) => [s, resolvePrice(model, [s]) ?? null]),
      ),
      preferred: resolvePrice(model) ?? null,
    });
  }

  // Every model we have actually logged, with the price we would apply.
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
    return {
      model: r.model,
      totalTokens: r.input + r.output + r.cache_read + r.cache_write,
      lastSeen: r.last_seen,
      priced: !!p && p.source !== 'unknown',
      source: p?.source ?? 'unknown',
      matchedId: p?.matchedId ?? null,
      synthetic: SYNTHETIC_MODELS.has(r.model.toLowerCase()),
    };
  });

  return NextResponse.json({
    oracles: CATALOG_SOURCES.map((s) => ({
      source: s,
      url: ORACLE_URLS[s],
      models: catalogStats()[s].models,
      ageSeconds: catalogAge(s, db),
    })),
    pins: MODEL_ALIASES,
    selfHost: {
      kwhRateUSD: getKwhRate(),
      hardware: SELF_HOST_HARDWARE,
    },
    coverage,
    unpriced: coverage.filter((c) => !c.priced && !c.synthetic && c.totalTokens > 0),
  });
}

export async function POST() {
  const db = getDb();
  const results = await syncPricing(db);
  return NextResponse.json({
    results,
    catalog: catalogStats(),
  });
}
