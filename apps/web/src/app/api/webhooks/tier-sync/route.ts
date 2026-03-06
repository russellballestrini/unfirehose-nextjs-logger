import { NextRequest, NextResponse } from 'next/server';
import { createHmac, timingSafeEqual } from 'crypto';
import { isMultiTenant } from '@unfirehose/core/auth';
import { getControlDb } from '@unfirehose/core/db/control';
import { tierFromString } from '@unfirehose/core/tiers';

export async function POST(request: NextRequest) {
  if (!isMultiTenant()) {
    return NextResponse.json({ error: 'Not found' }, { status: 404 });
  }

  const secret = process.env.UNFIREHOSE_WEBHOOK_SECRET;
  if (!secret) {
    return NextResponse.json({ error: 'Webhook secret not configured' }, { status: 500 });
  }

  const signature = request.headers.get('x-webhook-signature');
  if (!signature) {
    return NextResponse.json({ error: 'Missing signature' }, { status: 401 });
  }

  const rawBody = await request.text();

  const expected = createHmac('sha256', secret).update(rawBody).digest('hex');
  const sigBuf = Buffer.from(signature, 'hex');
  const expBuf = Buffer.from(expected, 'hex');

  if (sigBuf.length !== expBuf.length || !timingSafeEqual(sigBuf, expBuf)) {
    return NextResponse.json({ error: 'Invalid signature' }, { status: 401 });
  }

  let payload: { account_id?: string; tier?: string; email?: string };
  try {
    payload = JSON.parse(rawBody);
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 });
  }

  if (!payload.account_id || !payload.tier) {
    return NextResponse.json({ error: 'Missing account_id or tier' }, { status: 400 });
  }

  const tierLevel = tierFromString(payload.tier);
  const db = getControlDb();

  const existing = db.prepare('SELECT tier FROM accounts WHERE id = ?').get(payload.account_id) as
    | { tier: number }
    | undefined;

  const previousTier = existing?.tier ?? 0;

  db.prepare(`
    INSERT INTO accounts (id, email, tier, updated_at)
    VALUES (?, ?, ?, datetime('now'))
    ON CONFLICT(id) DO UPDATE SET
      tier = excluded.tier,
      email = COALESCE(excluded.email, accounts.email),
      updated_at = excluded.updated_at
  `).run(payload.account_id, payload.email ?? '', tierLevel);

  if (previousTier >= 33 && tierLevel < 33) {
    db.prepare(`
      UPDATE api_keys SET revoked_at = datetime('now')
      WHERE account_id = ? AND parent_key_id IS NOT NULL AND revoked_at IS NULL
    `).run(payload.account_id);
  }

  return NextResponse.json({ ok: true, tier: tierLevel });
}
