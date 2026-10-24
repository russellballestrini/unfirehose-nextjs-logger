import { NextRequest, NextResponse } from 'next/server';
import { getDb } from '@unturf/unfirehose/db/schema';
import { getRule, updateRule, deleteRule, listDeliveries, fileSecretStore } from '@unturf/unfirehose/db/alert-delivery';

type Ctx = { params: Promise<{ id: string }> };

async function ruleId(params: Ctx['params']): Promise<number | null> {
  const id = Number((await params).id);
  return Number.isInteger(id) && id > 0 ? id : null;
}

/** A thrown error answers as a 500 body, never a blank page. */
function failed(what: string, err: unknown) {
  return NextResponse.json({ error: `Failed to ${what}`, detail: (err as Error).message }, { status: 500 });
}

export async function GET(_request: NextRequest, { params }: Ctx) {
  const id = await ruleId(params);
  if (!id) return NextResponse.json({ error: 'Invalid rule id' }, { status: 400 });
  try {
    const db = getDb();
    const rule = getRule(db, fileSecretStore(), id);
    if (!rule) return NextResponse.json({ error: 'Rule not found' }, { status: 404 });
    return NextResponse.json({ rule, deliveries: listDeliveries(db, { ruleId: id, limit: 50 }) });
  } catch (err) {
    return failed('read rule', err);
  }
}

export async function PATCH(request: NextRequest, { params }: Ctx) {
  const id = await ruleId(params);
  if (!id) return NextResponse.json({ error: 'Invalid rule id' }, { status: 400 });
  let body: Record<string, unknown>;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'JSON body required' }, { status: 400 });
  }
  try {
    const r = updateRule(getDb(), fileSecretStore(), id, body);
    if (r === null) return NextResponse.json({ error: 'Rule not found' }, { status: 404 });
    if (!r.ok) return NextResponse.json({ error: 'Invalid rule', errors: r.errors }, { status: 400 });
    return NextResponse.json({ ok: true, rule: r.rule });
  } catch (err) {
    return failed('update rule', err);
  }
}

export async function DELETE(_request: NextRequest, { params }: Ctx) {
  const id = await ruleId(params);
  if (!id) return NextResponse.json({ error: 'Invalid rule id' }, { status: 400 });
  try {
    const deleted = deleteRule(getDb(), fileSecretStore(), id);
    if (!deleted) return NextResponse.json({ error: 'Rule not found' }, { status: 404 });
    return NextResponse.json({ ok: true });
  } catch (err) {
    return failed('delete rule', err);
  }
}
