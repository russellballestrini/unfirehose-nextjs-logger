import { NextRequest, NextResponse } from 'next/server';
import {
  getRecentAlerts,
  getUnacknowledgedAlerts,
  acknowledgeAlert,
  getAlertThresholds,
  updateAlertThreshold,
} from '@/lib/db/ingest';

export async function GET(request: NextRequest) {
  const url = new URL(request.url);
  const filter = url.searchParams.get('filter');

  try {
    if (filter === 'unacknowledged') {
      return NextResponse.json(getUnacknowledgedAlerts());
    }
    if (filter === 'thresholds') {
      return NextResponse.json(getAlertThresholds());
    }
    const limit = parseInt(url.searchParams.get('limit') ?? '20');
    return NextResponse.json(getRecentAlerts(limit));
  } catch (err) {
    return NextResponse.json(
      { error: 'Failed to read alerts', detail: String(err) },
      { status: 500 }
    );
  }
}

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();

    if (body.action === 'acknowledge' && body.id) {
      acknowledgeAlert(body.id);
      return NextResponse.json({ ok: true });
    }

    if (body.action === 'update_threshold' && body.id) {
      updateAlertThreshold(body.id, body.value, body.enabled ?? true);
      return NextResponse.json({ ok: true });
    }

    return NextResponse.json({ error: 'Unknown action' }, { status: 400 });
  } catch (err) {
    return NextResponse.json(
      { error: 'Failed to process alert action', detail: String(err) },
      { status: 500 }
    );
  }
}
