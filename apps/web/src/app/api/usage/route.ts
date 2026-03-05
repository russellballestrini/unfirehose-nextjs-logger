import { NextRequest, NextResponse } from 'next/server';
import { getUsageTimeline, getUsageByProject } from '@unfirehose/core/db/ingest';

export async function GET(request: NextRequest) {
  const url = new URL(request.url);
  const minutes = parseInt(url.searchParams.get('minutes') ?? '60');
  const view = url.searchParams.get('view') ?? 'timeline';

  try {
    if (view === 'projects') {
      return NextResponse.json(getUsageByProject(minutes));
    }
    return NextResponse.json(getUsageTimeline(minutes));
  } catch (err) {
    return NextResponse.json(
      { error: 'Failed to read usage data', detail: String(err) },
      { status: 500 }
    );
  }
}
