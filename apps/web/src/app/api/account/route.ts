import { NextRequest, NextResponse } from 'next/server';
import { getControlDb } from '@unturf/unfirehose/db/control';
import { tierName, tierLimits } from '@unturf/unfirehose/tiers';
import { requireAccount } from '@/lib/cloud-account';

export async function GET(request: NextRequest) {
  const auth = requireAccount(request, NextResponse.json({ mode: 'local' }));
  if ('response' in auth) return auth.response;
  const { accountId } = auth;

  const db = getControlDb();
  const account = db.prepare('SELECT * FROM accounts WHERE id = ?').get(accountId) as {
    id: string;
    email: string;
    tier: number;
    created_at: string;
    active: number;
  } | undefined;

  if (!account) {
    return NextResponse.json({ error: 'Account not found' }, { status: 404 });
  }

  const limits = tierLimits(account.tier as 0 | 14 | 33);

  // Usage in current billing period (last 30 days)
  const usage = db.prepare(`
    SELECT COALESCE(SUM(event_count), 0) as totalEvents,
           COALESCE(SUM(bytes), 0) as totalBytes
    FROM usage_log
    WHERE account_id = ? AND recorded_at > datetime('now', '-30 days')
  `).get(accountId) as { totalEvents: number; totalBytes: number };

  const keyCount = db.prepare(
    'SELECT COUNT(*) as cnt FROM api_keys WHERE account_id = ? AND revoked_at IS NULL'
  ).get(accountId) as { cnt: number };

  return NextResponse.json({
    mode: 'cloud',
    accountId: account.id,
    email: account.email,
    tier: account.tier,
    tierName: tierName(account.tier as 0 | 14 | 33),
    limits,
    usage: {
      eventsLast30d: usage.totalEvents,
      bytesLast30d: usage.totalBytes,
    },
    activeKeys: keyCount.cnt,
  });
}
