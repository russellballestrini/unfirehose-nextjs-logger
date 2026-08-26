import { NextRequest, NextResponse } from 'next/server';
import { getDb } from '@unturf/unfirehose/db/schema';
import { scanRateLimits } from '@unturf/unfirehose/db/rate-limit-scan';

export const dynamic = 'force-dynamic';

/**
 * GET /api/rate-limits?days=30&target=inference
 *
 * When we were throttled, by whom, and how hard.
 *
 * `target=inference` is the default and the one that matters for cost: an LLM
 * provider refused a call. `web` is a crawled site returning 429 and `service`
 * is our own infrastructure (unsandbox concurrency, Matrix); both are real but
 * neither says anything about our API budget.
 *
 * POST rescans content blocks for events — `{"fromScratch": true}` re-reads
 * history, which is what a detector change calls for.
 */
export async function GET(req: NextRequest) {
  const db = getDb();
  const days = Math.max(1, Math.min(365, Number(req.nextUrl.searchParams.get('days') ?? 30)));
  const target = req.nextUrl.searchParams.get('target') ?? 'inference';
  const limit = Math.max(1, Math.min(500, Number(req.nextUrl.searchParams.get('limit') ?? 100)));

  const since = new Date(Date.now() - days * 86400_000).toISOString();
  const targetClause = target === 'all' ? '' : 'AND target = ?';
  const args = target === 'all' ? [since] : [since, target];

  const byProvider = db.prepare(`
    SELECT COALESCE(provider, '(unknown)') AS provider,
           kind,
           COUNT(*)                        AS events,
           MAX(timestamp)                  AS last_seen,
           AVG(retry_after_s)              AS avg_retry_after_s
      FROM rate_limit_events
     WHERE timestamp >= ? ${targetClause}
     GROUP BY provider, kind
     ORDER BY events DESC
  `).all(...args);

  const byDay = db.prepare(`
    SELECT substr(timestamp, 1, 10) AS day,
           COUNT(*)                 AS events
      FROM rate_limit_events
     WHERE timestamp >= ? ${targetClause}
     GROUP BY day
     ORDER BY day
  `).all(...args);

  const recent = db.prepare(`
    SELECT e.timestamp, e.kind, e.target, e.provider, e.model,
           e.http_status, e.retry_after_s, e.rule, e.detail,
           p.name AS project, s.session_uuid
      FROM rate_limit_events e
      LEFT JOIN projects p ON p.id = e.project_id
      LEFT JOIN sessions s ON s.id = e.session_id
     WHERE e.timestamp >= ? ${targetClause}
     ORDER BY e.timestamp DESC
     LIMIT ?
  `).all(...args, limit);

  // Everything, so the UI can show what it is filtering out.
  const targets = db.prepare(`
    SELECT target, COUNT(*) AS events
      FROM rate_limit_events
     WHERE timestamp >= ?
     GROUP BY target
  `).all(since);

  const total = (byProvider as Array<{ events: number }>).reduce((s, r) => s + r.events, 0);

  return NextResponse.json({ days, target, total, targets, byProvider, byDay, recent });
}

export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => ({}));
  const result = scanRateLimits(getDb(), {
    fromScratch: body?.fromScratch === true,
    batch: typeof body?.batch === 'number' ? body.batch : undefined,
  });
  return NextResponse.json(result);
}
