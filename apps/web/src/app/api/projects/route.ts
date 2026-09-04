import { NextResponse } from 'next/server';
import { readProjectList, refreshProjectList } from '@unturf/unfirehose/projects-list';

/**
 * Serve the list the worker built.
 *
 * Building it is ~5s of aggregate queries and filesystem work, and Node is
 * single-threaded: doing that here starved every other request on the
 * server, so a cached response still took seconds to get out. The worker
 * owns the work now; this route only builds when nothing has been stored
 * yet, which is the first load against a database no worker has seen.
 */
export async function GET() {
  const stored = readProjectList();
  if (stored) {
    return NextResponse.json(stored.payload, {
      headers: { 'Server-Timing': 'stored;dur=0', 'X-Computed-At': stored.at },
    });
  }

  try {
    const rows = await refreshProjectList();
    return NextResponse.json(rows, { headers: { 'Server-Timing': 'built;dur=0' } });
  } catch (err) {
    return NextResponse.json(
      { error: 'Failed to list projects', detail: String(err) },
      { status: 500 },
    );
  }
}
