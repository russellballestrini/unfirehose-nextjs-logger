import { NextRequest, NextResponse } from 'next/server';
import {
  getRecentAlerts,
  getAlertsCount,
  getUnacknowledgedAlerts,
  acknowledgeAlert,
  getAlertThresholds,
  updateAlertThreshold,
  acknowledgeAlertsForThreshold,
  calibrateAlertThresholds,
  getAlertDailyCounts,
} from '@unturf/unfirehose/db/ingest';

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
    if (filter === 'daily') {
      const days = Math.min(Math.max(parseInt(url.searchParams.get('days') ?? '14'), 1), 365);
      return NextResponse.json(getAlertDailyCounts(days));
    }
    const limit = Math.min(parseInt(url.searchParams.get('limit') ?? '20'), 200);
    const offset = parseInt(url.searchParams.get('offset') ?? '0');
    const paginate = url.searchParams.get('paginate') === '1';

    const alerts = getRecentAlerts(limit, offset);

    if (paginate) {
      const total = getAlertsCount();
      return NextResponse.json({ alerts, total, limit, offset });
    }

    return NextResponse.json(alerts);
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

    if (body.action === 'acknowledge_all') {
      const unacked = getUnacknowledgedAlerts();
      for (const a of unacked) acknowledgeAlert(a.id);
      return NextResponse.json({ ok: true, count: unacked.length });
    }

    if (body.action === 'update_threshold' && body.id) {
      // Alerts open against the old number were measured against a rule we
      // are replacing; acknowledge them so the banner reflects the new rule.
      const current = (getAlertThresholds() as Array<{ id: number; window_minutes: number; metric: string; threshold_value: number }>)
        .find(t => t.id === body.id);
      updateAlertThreshold(body.id, body.value, body.enabled ?? true);
      let acknowledged = 0;
      if (current && Number(body.value) !== current.threshold_value) {
        acknowledged = acknowledgeAlertsForThreshold(current.window_minutes, current.metric);
      }
      return NextResponse.json({ ok: true, acknowledged });
    }

    if (body.action === 'calibrate') {
      const days = Math.min(Math.max(Number(body.days) || 7, 1), 90);
      const factor = Math.min(Math.max(Number(body.factor) || 1.5, 1), 10);
      const results = calibrateAlertThresholds(days, factor);
      return NextResponse.json({ ok: true, days, factor, results });
    }

    return NextResponse.json({ error: 'Unknown action' }, { status: 400 });
  } catch (err) {
    return NextResponse.json(
      { error: 'Failed to process alert action', detail: String(err) },
      { status: 500 }
    );
  }
}
