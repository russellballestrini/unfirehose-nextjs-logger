import { NextRequest, NextResponse } from 'next/server';
import { getControlDb } from '@unturf/unfirehose/db/control';
import { getTenantDb } from '@unturf/unfirehose/db/tenant';
import { requireAccount } from '@/lib/cloud-account';

export async function GET(request: NextRequest) {
  const auth = requireAccount(request, NextResponse.json({ error: 'Not in cloud mode' }, { status: 404 }));
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

  const apiKeys = db.prepare(
    'SELECT id, key_prefix, label, scopes, parent_key_id, created_at, revoked_at FROM api_keys WHERE account_id = ?'
  ).all(accountId);

  const usageLog = db.prepare(
    'SELECT * FROM usage_log WHERE account_id = ?'
  ).all(accountId);

  // Gather stats from tenant DB
  let tenantStats = { sessions: 0, messages: 0, projects: 0 };
  try {
    const tenantDb = getTenantDb(accountId);
    const sessions = tenantDb.prepare('SELECT COUNT(*) as cnt FROM sessions').get() as { cnt: number };
    const messages = tenantDb.prepare('SELECT COUNT(*) as cnt FROM messages').get() as { cnt: number };
    const projects = tenantDb.prepare('SELECT COUNT(*) as cnt FROM projects').get() as { cnt: number };
    tenantStats = {
      sessions: sessions.cnt,
      messages: messages.cnt,
      projects: projects.cnt,
    };
  } catch {
    // Tenant DB may not exist yet
  }

  return NextResponse.json({
    account: {
      id: account.id,
      email: account.email,
      tier: account.tier,
      created_at: account.created_at,
      active: account.active,
    },
    apiKeys,
    usageLog,
    tenantStats,
  });
}
