import Database from 'better-sqlite3';
import path from 'path';
import { mkdirSync } from 'fs';
import { migrateTenantDb } from './schema';

const TENANT_DB_DIR = process.env.TENANT_DB_DIR || '/data/tenants';
const MAX_POOL_SIZE = 50;

interface PoolEntry {
  db: Database.Database;
  lastAccess: number;
}

const pool = new Map<string, PoolEntry>();

function evictLru() {
  if (pool.size < MAX_POOL_SIZE) return;

  let oldestKey: string | null = null;
  let oldestTime = Infinity;

  for (const [key, entry] of pool) {
    if (entry.lastAccess < oldestTime) {
      oldestTime = entry.lastAccess;
      oldestKey = key;
    }
  }

  if (oldestKey) {
    const entry = pool.get(oldestKey)!;
    entry.db.close();
    pool.delete(oldestKey);
  }
}

export function getTenantDb(accountId: string): Database.Database {
  const existing = pool.get(accountId);
  if (existing) {
    existing.lastAccess = Date.now();
    return existing.db;
  }

  evictLru();

  mkdirSync(TENANT_DB_DIR, { recursive: true });
  const dbPath = path.join(TENANT_DB_DIR, `${accountId}.db`);

  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('synchronous = NORMAL');
  db.pragma('foreign_keys = ON');

  migrateTenantDb(db);

  pool.set(accountId, { db, lastAccess: Date.now() });
  return db;
}

export function closeTenantDb(accountId: string): void {
  const entry = pool.get(accountId);
  if (entry) {
    entry.db.close();
    pool.delete(accountId);
  }
}

export function closeAllTenantDbs(): void {
  for (const [, entry] of pool) {
    entry.db.close();
  }
  pool.clear();
}

/**
 * Delete data older than `days` for free-tier accounts.
 * Runs on ingest to keep free-tier DBs bounded.
 */
export function pruneOldData(db: Database.Database, days: number): number {
  if (!isFinite(days)) return 0;
  const cutoff = new Date(Date.now() - days * 86400_000).toISOString();
  const result = db.prepare('DELETE FROM logs WHERE timestamp < ?').run(cutoff);
  return result.changes;
}
