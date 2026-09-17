import { NextRequest, NextResponse } from 'next/server';
import { readDashboard, refreshDashboard } from '@unturf/unfirehose/dashboard';
import { ingestLagMinutes } from '@unturf/unfirehose/db/ingest';

/**
 * Serve the dashboard the worker built.
 *
 * Building it is ~1.2s and the page polls every 30 seconds; doing that here
 * charged the cost to every other request on this single-threaded server.
 * A range nobody warms is built once on first request and stored.
 */
export async function GET(request: NextRequest) {
  const range = request.nextUrl.searchParams.get('range') ?? '7d';

  // Keep the last successful result available while the worker is importing.
  // X-Computed-At exposes its age; expiry must not move rebuilds onto requests.
  const stored = readDashboard(range, Infinity);
  if (stored) {
    // The worker leaves a payload alone while no message lands, so the lag
    // it stamped at build time would read as a quiet worker either way. The
    // heartbeat is one settings row; read it now.
    const payload = { ...stored.payload, ingestLagMinutes: ingestLagMinutes() };
    return NextResponse.json(payload, {
      headers: { 'Server-Timing': 'stored;dur=0', 'X-Computed-At': stored.at },
    });
  }

  try {
    return NextResponse.json(refreshDashboard(range), {
      headers: { 'Server-Timing': 'built;dur=0' },
    });
  } catch (err) {
    return NextResponse.json(
      { error: 'Failed to build dashboard', detail: String(err) },
      { status: 500 },
    );
  }
}
