import { NextRequest, NextResponse } from 'next/server';
import { getDb } from '@unturf/unfirehose/db/schema';
import { scanRateLimits, scanRateLimitsFully, backfillReportedRefusals } from '@unturf/unfirehose/db/rate-limit-scan';

export const dynamic = 'force-dynamic';

/**
 * GET /api/rate-limits?minutes=1440&target=inference&kind=all   (or days=30)
 *
 * When a provider refused us, who did it, and how hard.
 *
 * `target=inference` is the default and the one that matters for cost: an LLM
 * provider refused a call. `web` is a crawled site returning 429 and `service`
 * is our own infrastructure (unsandbox concurrency, Matrix); both are real but
 * neither says anything about our API budget.
 *
 * `kind` narrows to one refusal condition, or to `throttles` for the four
 * where a provider is limiting us. Not every refusal is a throttle — a model
 * deregistered mid-run 404s, which costs a run without ever hitting a limit —
 * and the default is `all` because filtering that out by default is how it
 * stayed invisible.
 *
 * POST rescans content blocks for events — `{"fromScratch": true}` re-reads
 * history, which is what a detector change calls for.
 */
export async function GET(req: NextRequest) {
  const db = getDb();
  // `minutes` is the window the page's range picker speaks (0 = lifetime);
  // `days` stays for callers that predate it. Quantising to whole days made
  // every sub-day choice return the same 24h.
  const minutesParam = req.nextUrl.searchParams.get('minutes');
  const minutes = minutesParam !== null
    ? (Number(minutesParam) > 0 ? Math.min(Number(minutesParam), 365 * 1440) : 365 * 1440)
    : Math.max(1, Math.min(365, Number(req.nextUrl.searchParams.get('days') ?? 30))) * 1440;
  const days = Math.max(1, Math.ceil(minutes / 1440));
  const target = req.nextUrl.searchParams.get('target') ?? 'inference';
  const limit = Math.max(1, Math.min(500, Number(req.nextUrl.searchParams.get('limit') ?? 100)));

  const since = new Date(Date.now() - minutes * 60_000).toISOString();
  const targetClause = target === 'all' ? '' : 'AND target = ?';

  // `kind` filters the same rows every panel already reads, so it composes
  // with `target` instead of replacing it. `throttles` is the grouped
  // shortcut: the four conditions where a provider is limiting us, as
  // opposed to refusing us some other way (a 404 is a refusal, not a
  // throttle, and lumping them together hides both).
  const kind = req.nextUrl.searchParams.get('kind') ?? 'all';
  const THROTTLES = ['rate_limit', 'concurrency', 'quota', 'overloaded'];
  let kindClause = '';
  let kindArgs: string[] = [];
  if (kind === 'throttles') {
    kindClause = `AND kind IN (${THROTTLES.map(() => '?').join(',')})`;
    kindArgs = THROTTLES;
  } else if (kind !== 'all') {
    kindClause = 'AND kind = ?';
    kindArgs = [kind];
  }

  const filter = `${targetClause} ${kindClause}`;
  const args = [since, ...(target === 'all' ? [] : [target]), ...kindArgs];

  // Grouped by the upstream that refused, not the harness that got refused,
  // and by HTTP status: a 529 and a 503 under one kind are two provider
  // states, and the code is the one field a human reads first.
  // COALESCE to a sentinel rather than dropping nulls: "we do not know" is the
  // most common answer and hiding it would misrepresent the data as complete.
  const byUpstream = db.prepare(`
    SELECT COALESCE(upstream, '(not reported)') AS upstream,
           COALESCE(provider, '(unknown)')      AS harness,
           COALESCE(operation, '')              AS operation,
           kind,
           http_status,
           COUNT(*)       AS events,
           MAX(timestamp) AS last_seen
      FROM rate_limit_events
     WHERE timestamp >= ? ${filter}
     GROUP BY upstream, provider, operation, kind, http_status
     ORDER BY events DESC
  `).all(...args);

  // `named` vs `reported` are different questions and the gap between them
  // is the actionable one. A harness-reported row knows its route because it
  // was written at the moment of failure; a text-scanned row never can, since
  // the error string a harness prints does not carry the provider. So an
  // unnamed upstream points at which SOURCE the row came from, not at a
  // harness that forgot to log it.
  const reported = db.prepare(`
    SELECT SUM(CASE WHEN upstream IS NOT NULL THEN 1 ELSE 0 END)      AS named,
           SUM(CASE WHEN rule = 'harness-reported' THEN 1 ELSE 0 END) AS reported,
           COUNT(*)                                                   AS total
      FROM rate_limit_events
     WHERE timestamp >= ? ${filter}
  `).get(...args) as { named: number | null; reported: number | null; total: number };

  // Every kind in the window regardless of the kind filter, so the UI can
  // show what it is currently hiding.
  const kinds = db.prepare(`
    SELECT kind, COUNT(*) AS events
      FROM rate_limit_events
     WHERE timestamp >= ? ${targetClause}
     GROUP BY kind
     ORDER BY events DESC
  `).all(...[since, ...(target === 'all' ? [] : [target])]);

  const byProvider = db.prepare(`
    SELECT COALESCE(provider, '(unknown)') AS provider,
           kind,
           http_status,
           COUNT(*)                        AS events,
           MAX(timestamp)                  AS last_seen,
           AVG(retry_after_s)              AS avg_retry_after_s
      FROM rate_limit_events
     WHERE timestamp >= ? ${filter}
     GROUP BY provider, kind, http_status
     ORDER BY events DESC
  `).all(...args);

  const byDay = db.prepare(`
    SELECT substr(timestamp, 1, 10) AS day,
           COUNT(*)                 AS events
      FROM rate_limit_events
     WHERE timestamp >= ? ${filter}
     GROUP BY day
     ORDER BY day
  `).all(...args);

  const recent = db.prepare(`
    SELECT e.timestamp, e.kind, e.target, e.provider, e.upstream, e.operation, e.model,
           e.http_status, e.retry_after_s, e.rule, e.detail,
           p.name AS project, s.session_uuid
      FROM rate_limit_events e
      LEFT JOIN projects p ON p.id = e.project_id
      LEFT JOIN sessions s ON s.id = e.session_id
     WHERE e.timestamp >= ? ${filter}
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

  return NextResponse.json({
    days, minutes, target, kind, total, targets, kinds, byProvider, byUpstream, byDay, recent,
    // How much of this window can even name who refused. Surfaced so the page
    // can say "N of M events do not identify an upstream" rather than showing
    // a blank column and letting it read as no throttling.
    attribution: {
      named: reported?.named ?? 0,
      reported: reported?.reported ?? 0,
      total: reported?.total ?? 0,
    },
  });
}

export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => ({}));
  // Rebuild harness-reported rows from the JSONL on disk — the one source a
  // text rescan can never recover.
  if (body?.backfillReported === true) {
    return NextResponse.json(backfillReportedRefusals(getDb()));
  }
  const opts = {
    fromScratch: body?.fromScratch === true,
    batch: typeof body?.batch === 'number' ? body.batch : undefined,
  };
  // `drain` runs batches until the cursor reaches the newest block; the
  // default single batch is what the worker's periodic tick uses.
  const result = body?.drain === true
    ? scanRateLimitsFully(getDb(), opts)
    : scanRateLimits(getDb(), opts);
  return NextResponse.json(result);
}
