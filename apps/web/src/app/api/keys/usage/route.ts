import { NextRequest, NextResponse } from 'next/server';
import { getControlDb } from '@unturf/unfirehose/db/control';
import { requireAccount } from '@/lib/cloud-account';

export async function GET(request: NextRequest) {
  const auth = requireAccount(request, NextResponse.json({ error: 'Not in cloud mode' }, { status: 404 }));
  if ('response' in auth) return auth.response;
  const { accountId } = auth;

  const { searchParams } = new URL(request.url);
  const days = Math.max(1, Math.min(365, parseInt(searchParams.get('days') || '30', 10) || 30));

  const db = getControlDb();
  const now = new Date();
  const from = new Date(now.getTime() - days * 24 * 60 * 60 * 1000);
  const fromISO = from.toISOString();
  const toISO = now.toISOString();

  const rows = db.prepare(`
    SELECT
      ak.id          AS keyId,
      ak.key_prefix  AS keyPrefix,
      ak.label,
      ak.parent_key_id AS parentKeyId,
      ak.last_used_at  AS lastUsed,
      COALESCE(SUM(ul.event_count), 0) AS events,
      COALESCE(SUM(ul.bytes), 0)       AS bytes
    FROM api_keys ak
    LEFT JOIN usage_log ul
      ON ul.api_key_id = ak.id
      AND ul.recorded_at >= ?
    WHERE ak.account_id = ?
      AND ak.revoked_at IS NULL
    GROUP BY ak.id
    ORDER BY events DESC
  `).all(fromISO, accountId) as Array<{
    keyId: string;
    keyPrefix: string;
    label: string | null;
    parentKeyId: string | null;
    lastUsed: string | null;
    events: number;
    bytes: number;
  }>;

  const total = rows.reduce(
    (acc, r) => ({ events: acc.events + r.events, bytes: acc.bytes + r.bytes }),
    { events: 0, bytes: 0 },
  );

  return NextResponse.json({
    period: { days, from: fromISO, to: toISO },
    total,
    byKey: rows,
  });
}
