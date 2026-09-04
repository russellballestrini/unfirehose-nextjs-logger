import { NextRequest, NextResponse } from 'next/server';
import { readDashboard, refreshDashboard } from '@unturf/unfirehose/dashboard';

/**
 * Serve the dashboard the worker built.
 *
 * Building it is ~1.2s and the page polls every 30 seconds; doing that here
 * charged the cost to every other request on this single-threaded server.
 * A range nobody warms is built once on first request and stored.
 */
export async function GET(request: NextRequest) {
  const range = request.nextUrl.searchParams.get('range') ?? '7d';

  const stored = readDashboard(range);
  if (stored) {
    return NextResponse.json(stored.payload, {
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
