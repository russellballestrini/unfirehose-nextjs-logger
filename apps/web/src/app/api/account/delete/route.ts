import { NextRequest, NextResponse } from 'next/server';
import { listApiKeys, revokeApiKey } from '@unturf/unfirehose/db/api-keys';
import { getControlDb } from '@unturf/unfirehose/db/control';
import { closeTenantDb } from '@unturf/unfirehose/db/tenant';
import { unlinkSync } from 'fs';
import path from 'path';
import { requireAccount } from '@/lib/cloud-account';

export async function POST(request: NextRequest) {
  const auth = requireAccount(request, NextResponse.json({ error: 'Not in cloud mode' }, { status: 404 }));
  if ('response' in auth) return auth.response;
  const { accountId } = auth;

  let body: { confirm?: boolean };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 });
  }

  if (body.confirm !== true) {
    return NextResponse.json(
      { error: 'Must confirm deletion with {"confirm": true}' },
      { status: 400 },
    );
  }

  const db = getControlDb();

  // Verify account exists
  const account = db.prepare('SELECT id FROM accounts WHERE id = ?').get(accountId);
  if (!account) {
    return NextResponse.json({ error: 'Account not found' }, { status: 404 });
  }

  // Revoke all API keys
  const keys = listApiKeys(accountId);
  for (const key of keys) {
    if (!key.revokedAt) {
      revokeApiKey(key.id);
    }
  }

  // Delete usage log entries
  db.prepare('DELETE FROM usage_log WHERE account_id = ?').run(accountId);

  // Delete account record
  db.prepare('DELETE FROM accounts WHERE id = ?').run(accountId);

  // Close and delete tenant DB file
  closeTenantDb(accountId);
  const tenantDbDir = process.env.TENANT_DB_DIR || '/data/tenants';
  const tenantDbPath = path.join(tenantDbDir, `${accountId}.db`);
  try {
    unlinkSync(tenantDbPath);
    // Also remove WAL/SHM files if they exist
    try { unlinkSync(`${tenantDbPath}-wal`); } catch { /* may not exist */ }
    try { unlinkSync(`${tenantDbPath}-shm`); } catch { /* may not exist */ }
  } catch {
    // Tenant DB file may not exist
  }

  return NextResponse.json({ ok: true, deleted: accountId });
}
