import { NextResponse } from 'next/server';
import { ingestAll, getDbStats } from '@unfirehose/core/db/ingest';

export async function POST() {
  try {
    const result = await ingestAll();
    const stats = getDbStats();
    return NextResponse.json({ ingested: result, db: stats });
  } catch (err) {
    return NextResponse.json(
      { error: 'Ingestion failed', detail: String(err) },
      { status: 500 }
    );
  }
}

export async function GET() {
  try {
    const stats = getDbStats();
    return NextResponse.json(stats);
  } catch (err) {
    return NextResponse.json(
      { error: 'Failed to read DB stats', detail: String(err) },
      { status: 500 }
    );
  }
}
