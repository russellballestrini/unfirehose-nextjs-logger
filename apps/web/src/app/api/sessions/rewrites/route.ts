import { NextRequest, NextResponse } from 'next/server';
import { getDb } from '@unturf/unfirehose/db/schema';
import { getRewrites, getRewriteSummary } from '@unturf/unfirehose/db/rewrite-watch';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

/**
 * GET /api/sessions/rewrites?limit=50&session=<uuid>&harness=claude-code&hours=24
 *
 * Harnesses caught in the act: every line of a LIVE unchained journal
 * that the rewrite watch saw one way and then another, with the before
 * and after side by side, how far from the tail it sat, and which JSON
 * keys moved (`message.usage` is a refresh, `message.content` is an
 * edit). `summary` covers the last `hours`; `rows` are the newest
 * first, narrowed by `session`, `harness` and the same window.
 */
export async function GET(request: NextRequest) {
  const q = request.nextUrl.searchParams;
  const limit = Math.max(1, Math.min(parseInt(q.get('limit') ?? '50', 10) || 50, 1000));
  const hours = Math.max(0, parseFloat(q.get('hours') ?? '24') || 24);
  const session = q.get('session') || undefined;
  const harness = q.get('harness') || undefined;
  const db = getDb();
  return NextResponse.json({
    summary: getRewriteSummary(db, { sinceHours: hours }),
    rows: getRewrites(db, { limit, session, harness, since: new Date(Date.now() - hours * 3_600_000) }),
  });
}
