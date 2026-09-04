import { NextResponse } from 'next/server';
import { ingestAll, getDbStats } from '@unturf/unfirehose/db/ingest';

/**
 * Run a pass over every harness log and report what landed.
 *
 * apps/worker does this on a timer; this is the on-demand form, for the
 * moment after a harness writes something you want to see now.
 */
export async function POST() {
  try {
    const result = await ingestAll();
    return NextResponse.json({ ingested: result, db: getDbStats() });
  } catch (err) {
    return NextResponse.json(
      { error: 'Ingestion failed', detail: String(err) },
      { status: 500 },
    );
  }
}

export async function GET() {
  try {
    return NextResponse.json(getDbStats());
  } catch (err) {
    return NextResponse.json(
      { error: 'Failed to read DB stats', detail: String(err) },
      { status: 500 },
    );
  }
}
