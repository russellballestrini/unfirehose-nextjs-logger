import { NextResponse } from 'next/server';
import { getDb } from '@unturf/unfirehose/db/schema';
import { readScrobblePayload, refreshScrobblePayload } from '@unturf/unfirehose/scrobble';
import { Timing } from '@/lib/timing';

/**
 * Serve the payload the worker precomputed.
 *
 * Building it is two full scans of a 1.6M-row `messages` table — it was
 * eight, and 11.6s, before 2026-09-03 — so a visitor should not be the one
 * paying for them. The worker refreshes it every few minutes; this route
 * only rebuilds when nothing fresh has been stored, which is the first load
 * on a database that has never had a worker run against it.
 */
export async function GET() {
  const t = new Timing();
  try {
    const stored = readScrobblePayload();
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
