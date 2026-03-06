import { createHash, randomBytes } from 'crypto';
import { uuidv7 } from '../uuidv7';
import { getControlDb } from './control';

const BASE62 = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';

function base62Encode(buf: Buffer): string {
  let result = '';
  for (const byte of buf) {
    result += BASE62[byte % 62];
  }
  return result;
}

function hashKey(key: string): string {
  return createHash('sha256').update(key).digest('hex');
}

export function generateApiKey(): { key: string; keyHash: string; keyPrefix: string } {
  const suffix = base62Encode(randomBytes(21)).slice(0, 28);
  const key = `unfh_${suffix}`;
  const keyHash = hashKey(key);
  const keyPrefix = key.slice(0, 12);
  return { key, keyHash, keyPrefix };
}

interface ValidatedKey {
  accountId: string;
  tier: number;
  scopes: string;
  keyId: string;
}

export function validateApiKey(key: string): ValidatedKey | null {
  const db = getControlDb();
  const hash = hashKey(key);

  const row = db.prepare(`
    SELECT k.id as key_id, k.account_id, k.scopes, k.revoked_at,
           a.tier, a.active
    FROM api_keys k
    JOIN accounts a ON a.id = k.account_id
    WHERE k.key_hash = ?
  `).get(hash) as {
    key_id: string;
    account_id: string;
    scopes: string;
    revoked_at: string | null;
    tier: number;
    active: number;
  } | undefined;

  if (!row) return null;
  if (row.revoked_at) return null;
  if (!row.active) return null;

  db.prepare('UPDATE api_keys SET last_used_at = datetime(\'now\') WHERE id = ?').run(row.key_id);

  return {
    accountId: row.account_id,
    tier: row.tier,
    scopes: row.scopes,
    keyId: row.key_id,
  };
}

interface CreateKeyOpts {
  label?: string;
  parentKeyId?: string;
  scopes?: string;
}

export function createApiKey(accountId: string, opts?: CreateKeyOpts): { id: string; key: string; keyPrefix: string } {
  const db = getControlDb();
  const { key, keyHash, keyPrefix } = generateApiKey();
  const id = uuidv7();

  db.prepare(`
    INSERT INTO api_keys (id, account_id, key_hash, key_prefix, label, parent_key_id, scopes)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(
    id,
    accountId,
    keyHash,
    keyPrefix,
    opts?.label ?? null,
    opts?.parentKeyId ?? null,
    opts?.scopes ?? 'ingest',
  );

  return { id, key, keyPrefix };
}

export function revokeApiKey(keyId: string): void {
  const db = getControlDb();
  db.prepare("UPDATE api_keys SET revoked_at = datetime('now') WHERE id = ?").run(keyId);
}

interface ApiKeyInfo {
  id: string;
  keyPrefix: string;
  label: string | null;
  parentKeyId: string | null;
  scopes: string;
  createdAt: string;
  lastUsedAt: string | null;
  revokedAt: string | null;
}

export function listApiKeys(accountId: string): ApiKeyInfo[] {
  const db = getControlDb();
  const rows = db.prepare(`
    SELECT id, key_prefix, label, parent_key_id, scopes, created_at, last_used_at, revoked_at
    FROM api_keys
    WHERE account_id = ?
    ORDER BY created_at DESC
  `).all(accountId) as {
    id: string;
    key_prefix: string;
    label: string | null;
    parent_key_id: string | null;
    scopes: string;
    created_at: string;
    last_used_at: string | null;
    revoked_at: string | null;
  }[];

  return rows.map(r => ({
    id: r.id,
    keyPrefix: r.key_prefix,
    label: r.label,
    parentKeyId: r.parent_key_id,
    scopes: r.scopes,
    createdAt: r.created_at,
    lastUsedAt: r.last_used_at,
    revokedAt: r.revoked_at,
  }));
}
