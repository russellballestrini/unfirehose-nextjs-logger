import Database from 'better-sqlite3';

const CONTROL_DB_PATH = process.env.CONTROL_DB_PATH || '/data/control.db';

let _db: Database.Database | null = null;

export function getControlDb(): Database.Database {
  if (_db) return _db;

  _db = new Database(CONTROL_DB_PATH);
  _db.pragma('journal_mode = WAL');
  _db.pragma('synchronous = NORMAL');
  _db.pragma('foreign_keys = ON');

  migrateControl(_db);
  return _db;
}

function migrateControl(db: Database.Database) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS accounts (
      id TEXT PRIMARY KEY,
      email TEXT NOT NULL,
      tier INTEGER NOT NULL DEFAULT 0,
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now')),
      active INTEGER DEFAULT 1
    );

    CREATE TABLE IF NOT EXISTS api_keys (
      id TEXT PRIMARY KEY,
      account_id TEXT NOT NULL REFERENCES accounts(id),
      key_hash TEXT NOT NULL,
      key_prefix TEXT NOT NULL,
      label TEXT,
      parent_key_id TEXT,
      scopes TEXT DEFAULT 'ingest',
      created_at TEXT DEFAULT (datetime('now')),
      last_used_at TEXT,
      revoked_at TEXT
    );

    CREATE TABLE IF NOT EXISTS usage_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      account_id TEXT NOT NULL,
      api_key_id TEXT NOT NULL,
      event_type TEXT NOT NULL,
      event_count INTEGER DEFAULT 1,
      bytes INTEGER DEFAULT 0,
      recorded_at TEXT DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS idx_api_keys_account ON api_keys(account_id);
    CREATE INDEX IF NOT EXISTS idx_api_keys_hash ON api_keys(key_hash);
    CREATE INDEX IF NOT EXISTS idx_usage_log_account ON usage_log(account_id);
    CREATE INDEX IF NOT EXISTS idx_usage_log_recorded ON usage_log(recorded_at);
  `);
}
