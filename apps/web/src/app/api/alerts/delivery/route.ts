import { NextRequest, NextResponse } from 'next/server';
import { getDb } from '@unturf/unfirehose/db/schema';
import { createRule, listRules, listDeliveries, fileSecretStore, MATCH_METRICS } from '@unturf/unfirehose/db/alert-delivery';
import { DESTINATIONS, SECRET_FIELDS } from '@unturf/unfirehose/alert-delivery';

// Alert delivery rules. Secrets go in and never come back out whole: every
// rule in a response carries its secrets masked (see db/alert-delivery).
// Errors name a field, never echo a value.

export async function GET(request: NextRequest) {
  try {
    const db = getDb();
    const limit = Number(new URL(request.url).searchParams.get('limit') ?? 50);
    return NextResponse.json({
      rules: listRules(db, fileSecretStore()),
      deliveries: listDeliveries(db, { limit: Number.isFinite(limit) ? limit : 50 }),
      destinations: DESTINATIONS,
      secretFields: SECRET_FIELDS,
      metrics: MATCH_METRICS,
    });
  } catch (err) {
    return NextResponse.json({ error: 'Failed to read delivery rules', detail: (err as Error).message }, { status: 500 });
  }
}

export async function POST(request: NextRequest) {
  let body: Record<string, unknown>;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'JSON body required' }, { status: 400 });
  }
  try {
    const r = createRule(getDb(), fileSecretStore(), body);
    if (!r.ok) return NextResponse.json({ error: 'Invalid rule', errors: r.errors }, { status: 400 });
    return NextResponse.json({ ok: true, rule: r.rule }, { status: 201 });
  } catch (err) {
    return NextResponse.json({ error: 'Failed to save rule', detail: (err as Error).message }, { status: 500 });
  }
}
