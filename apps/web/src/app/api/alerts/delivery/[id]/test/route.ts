import { NextRequest, NextResponse } from 'next/server';
import { getDb } from '@unturf/unfirehose/db/schema';
import { sendTestAlert, fileSecretStore } from '@unturf/unfirehose/db/alert-delivery';

// "Send test": one synthetic alert through the same build, sign and send
// path the worker uses, sent from here so the answer comes back to the
// button. Only ever to the destination the user saved on this rule.
export async function POST(_request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const id = Number((await params).id);
  if (!Number.isInteger(id) || id <= 0) return NextResponse.json({ error: 'Invalid rule id' }, { status: 400 });
  try {
    const r = await sendTestAlert(getDb(), fileSecretStore(), id);
    if (!r) return NextResponse.json({ error: 'Rule not found' }, { status: 404 });
    return NextResponse.json(r);
  } catch (err) {
    return NextResponse.json({ error: 'Test send failed', detail: (err as Error).message }, { status: 500 });
  }
}
