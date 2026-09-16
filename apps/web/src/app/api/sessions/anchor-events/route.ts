import { NextRequest, NextResponse } from 'next/server';
import { getDb } from '@unturf/unfirehose/db/schema';
import { getRecentAnchorEvents } from '@unturf/unfirehose/db/provenance-ingest';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

/**
 * GET /api/sessions/anchor-events?hours=24&limit=100&kind=rewritten
 *
 * Every tamper finding across every session, newest first: a leaf the
 * witness saw differ from what it recorded (`rewritten`), a chained
 * line whose bytes changed under its own hash (`hash_mismatch`), a
 * range of lines a file lost (`lost`, `seq`..`seq_to`), and every chain
 * break the verifier hit by reason. One row per finding, so a session
 * with two edits is two rows and a re-audit that finds them again adds
 * none. The session's project and harness ride along for a feed.
 */
export async function GET(request: NextRequest) {
  const q = request.nextUrl.searchParams;
  const hours = Math.min(Math.max(parseInt(q.get('hours') ?? '24', 10) || 24, 1), 24 * 365);
  const limit = Math.min(Math.max(parseInt(q.get('limit') ?? '100', 10) || 100, 1), 1000);
  const kind = q.get('kind') || undefined;
  return NextResponse.json({ hours, events: getRecentAnchorEvents(getDb(), { hours, limit, kind }) });
}
