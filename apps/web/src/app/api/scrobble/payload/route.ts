import { NextResponse } from 'next/server';
import { getDb } from '@unturf/unfirehose/db/schema';
import { readScrobblePayload, refreshScrobblePayload } from '@unturf/unfirehose/scrobble';
import { Timing } from '@/lib/timing';

/**
 * Serve the payload the worker precomputed.
 *
 * Building it is two full scans of a 1.6M-row `messages` table — it was
 * eight, and 11.6s, before 2026-09-03 — so a visitor should not be the one
 * paying for them. The worker refreshes it every 15 minutes when messages
 * have landed, and at least every two hours otherwise; this route
 * rebuilds only when nothing has ever been stored, the first load on a
 * database no worker has run against.
 *
 * Any stored copy is served, whatever its age. This used to reject one
 * older than ten minutes and rebuild in-process, which is exactly when the
 * worker is behind — just restarted, or catching up on ingest — and the
 * rebuild then blocked every request on the server for the length of the
 * scans, on every visit, until the worker caught up. A copy a few minutes
 * old is the right answer; X-Computed-At says how old.
 */
export async function GET() {
  const t = new Timing();
  try {
    const stored = readScrobblePayload(Infinity);
    if (stored) {
      t.mark('stored');
      return NextResponse.json(stored.payload, {
        headers: { 'Server-Timing': t.header(), 'X-Computed-At': stored.at },
      });
    }
    const payload = refreshScrobblePayload(getDb());
    t.mark('computed');
    return NextResponse.json(payload, { headers: { 'Server-Timing': t.header() } });
  } catch (err) {
    return NextResponse.json(
      { error: 'Failed to build scrobble payload', detail: String(err) },
      { status: 500 },
    );
  }
}
