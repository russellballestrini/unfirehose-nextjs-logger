import { NextRequest, NextResponse } from 'next/server';
import { getDb } from '@unturf/unfirehose/db/schema';

/* eslint-disable @typescript-eslint/no-explicit-any */

/**
 * POST /api/metrics
 *   Body: { pathname, metric, value, rating, sessionId? }
 *   Inserts a web-vitals sample for real-user-monitoring.
 *
 * GET /api/metrics?days=7
 *   Returns per-pathname aggregates (p50/p75/p95 + count) for each metric.
 *   Percentiles are computed in-process via sorted ORDER BY since SQLite has no
 *   percentile_cont — counts per (pathname, metric) are well-bounded for RUM.
 */

const ALLOWED_METRICS = new Set(['TTFB', 'FCP', 'LCP', 'INP', 'CLS']);
const ALLOWED_RATINGS = new Set(['good', 'needs-improvement', 'poor']);

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const pathname = typeof body.pathname === 'string' ? body.pathname : null;
    const metric = typeof body.metric === 'string' ? body.metric : null;
    const value = typeof body.value === 'number' ? body.value : null;
    const rating = typeof body.rating === 'string' ? body.rating : null;
    const sessionId = typeof body.sessionId === 'string' ? body.sessionId : null;

    if (!pathname || !metric || value == null || !rating) {
      return NextResponse.json({ error: 'missing required field' }, { status: 400 });
    }
    if (!ALLOWED_METRICS.has(metric)) {
      return NextResponse.json({ error: `unknown metric ${metric}` }, { status: 400 });
    }
    if (!ALLOWED_RATINGS.has(rating)) {
      return NextResponse.json({ error: `unknown rating ${rating}` }, { status: 400 });
    }
    if (!Number.isFinite(value)) {
      return NextResponse.json({ error: 'value must be finite' }, { status: 400 });
    }

    const db = getDb();
    db.prepare(
      'INSERT INTO web_vitals (ts, pathname, metric, value, rating, session_id) VALUES (?, ?, ?, ?, ?, ?)'
    ).run(Date.now(), pathname, metric, value, rating, sessionId);

    return NextResponse.json({ ok: true });
  } catch (err) {
    return NextResponse.json(
      { error: 'failed to record metric', detail: String(err) },
      { status: 500 }
    );
  }
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  if (sorted.length === 1) return sorted[0];
  // Linear interpolation (same definition as percentile_cont).
  const rank = (p / 100) * (sorted.length - 1);
  const lo = Math.floor(rank);
  const hi = Math.ceil(rank);
  if (lo === hi) return sorted[lo];
  const frac = rank - lo;
  return sorted[lo] * (1 - frac) + sorted[hi] * frac;
}

const round = (n: number) => Math.round(n * 100) / 100;

export async function GET(req: NextRequest) {
  try {
    const days = Math.max(1, Math.min(parseInt(req.nextUrl.searchParams.get('days') ?? '7'), 90));
    const since = Date.now() - days * 86400_000;
    const db = getDb();

    // Pull only the columns we need, ordered so percentile sort is cheap downstream.
    const rows = db.prepare(
      'SELECT pathname, metric, value FROM web_vitals WHERE ts >= ? ORDER BY pathname, metric, value ASC'
    ).all(since) as Array<{ pathname: string; metric: string; value: number }>;

    // Group: pathname -> metric -> sorted values
    const groups = new Map<string, Map<string, number[]>>();
    for (const r of rows) {
      let byMetric = groups.get(r.pathname);
      if (!byMetric) { byMetric = new Map(); groups.set(r.pathname, byMetric); }
      let arr = byMetric.get(r.metric);
      if (!arr) { arr = []; byMetric.set(r.metric, arr); }
      arr.push(r.value);
    }

    const aggregates: any[] = [];
    for (const [pathname, byMetric] of groups) {
      const metrics: Record<string, any> = {};
      for (const [metric, values] of byMetric) {
        // already sorted ASC from SQL ORDER BY
        metrics[metric] = {
          count: values.length,
          p50: round(percentile(values, 50)),
          p75: round(percentile(values, 75)),
          p95: round(percentile(values, 95)),
        };
      }
      aggregates.push({ pathname, metrics });
    }

    // Sort by total sample volume so the busiest pages bubble to the top.
    aggregates.sort((a, b) => {
      const aCount = Object.values(a.metrics as Record<string, any>).reduce((s, m) => s + (m as any).count, 0);
      const bCount = Object.values(b.metrics as Record<string, any>).reduce((s, m) => s + (m as any).count, 0);
      return bCount - aCount;
    });

    return NextResponse.json({ days, totalSamples: rows.length, aggregates });
  } catch (err) {
    return NextResponse.json(
      { error: 'failed to read metrics', detail: String(err) },
      { status: 500 }
    );
  }
}
