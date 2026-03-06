import { NextRequest, NextResponse } from 'next/server';
import { validateApiKey } from '@unfirehose/core/db/api-keys';
import { getControlDb } from '@unfirehose/core/db/control';
import { tierName, tierLimits } from '@unfirehose/core/tiers';

function getAccountId(request: NextRequest): string | null {
  const accountId = request.headers.get('X-Account-Id');
  if (accountId) return accountId;

  const apiKey = request.headers.get('X-Api-Key');
  if (apiKey) {
    const result = validateApiKey(apiKey);
    if (result) return result.accountId;
  }

  return null;
}

export async function GET(request: NextRequest) {
  if (process.env.MULTI_TENANT !== 'true') {
    return NextResponse.json({ mode: 'local' });
  }

  const accountId = getAccountId(request);
  if (!accountId) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

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
