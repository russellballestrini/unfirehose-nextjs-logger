import { NextRequest, NextResponse } from 'next/server';
import { getDb } from '@unturf/unfirehose/db/schema';
import { getDbHealth, recordSizeSnapshot } from '@unturf/unfirehose/db/db-health';

export const dynamic = 'force-dynamic';

/**
 * GET /api/db/health — what Settings → Database shows: file, freelist and
 * WAL bytes, free disk, size by table from our worker's newest daily
 * snapshot, growth per week, cold-storage totals and the retention window.
 * Cheap: no dbstat scan (that is /api/db/meta, or a POST here).
 */
export async function GET() {
  try {
    return NextResponse.json(getDbHealth(getDb()), { headers: { 'Cache-Control': 'no-store' } });
  } catch (err) {
    return NextResponse.json({ error: (err as Error).message }, { status: 500 });
  }
}

/**
 * POST /api/db/health `{ action: "measure" }` — take today's size snapshot
 * now instead of waiting for our worker. Reads every page through dbstat:
 * seconds on a large database.
 */
export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => ({})) as { action?: string };
  if (body.action !== 'measure') {
    return NextResponse.json({ error: 'action must be "measure"' }, { status: 400 });
  }
  try {
    const db = getDb();
    const t0 = Date.now();
    recordSizeSnapshot(db);
    return NextResponse.json({ ...getDbHealth(db), measuredMs: Date.now() - t0 });
  } catch (err) {
    return NextResponse.json({ error: (err as Error).message }, { status: 500 });
  }
}
