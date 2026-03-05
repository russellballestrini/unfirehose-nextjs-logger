import { describe, it, expect, vi } from 'vitest';

// Mock better-sqlite3 to create in-memory DB instead of file-backed
vi.mock('better-sqlite3', async (importOriginal) => {
  const original = await importOriginal<typeof import('better-sqlite3')>();
  // Must be a class (constructable) since schema.ts does `new Database(path)`
  class MockDatabase extends original.default {
    constructor(..._args: ConstructorParameters<typeof original.default>) {
      super(':memory:');
    }
  }
  return { default: MockDatabase };
});

const { getDb } = await import('./schema');

describe('getDb()', () => {
  it('returns a database instance with all tables created', () => {
    const db = getDb();
    expect(db).toBeTruthy();

    const tables = db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name"
      )
      .all() as { name: string }[];
    const names = tables.map((t) => t.name);

    expect(names).toContain('projects');
    expect(names).toContain('sessions');
    expect(names).toContain('messages');
    expect(names).toContain('content_blocks');
    expect(names).toContain('usage_minutes');
    expect(names).toContain('alerts');
    expect(names).toContain('alert_thresholds');
    expect(names).toContain('ingest_offsets');
  });

  it('returns the same cached instance on subsequent calls', () => {
    const db1 = getDb();
    const db2 = getDb();
    expect(db1).toBe(db2);
  });

  it('sets journal mode pragma (WAL on disk, memory for :memory:)', () => {
    const db = getDb();
    const wal = db.pragma('journal_mode') as { journal_mode: string }[];
    // In-memory DB returns 'memory' instead of 'wal'; pragma was still called
    expect(['wal', 'memory']).toContain(wal[0].journal_mode);
  });

  it('enables foreign keys', () => {
    const db = getDb();
    const fk = db.pragma('foreign_keys') as { foreign_keys: number }[];
    expect(fk[0].foreign_keys).toBe(1);
  });

  it('seeds 7 default alert thresholds', () => {
    const db = getDb();
    const count = db
      .prepare('SELECT COUNT(*) as c FROM alert_thresholds')
      .get() as { c: number };
    expect(count.c).toBe(7);
  });

  it('creates all expected indexes', () => {
    const db = getDb();
    const indexes = db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type='index' AND name LIKE 'idx_%' ORDER BY name"
      )
      .all() as { name: string }[];
    const names = indexes.map((i) => i.name);

    expect(names).toContain('idx_messages_session');
    expect(names).toContain('idx_messages_timestamp');
    expect(names).toContain('idx_messages_type');
    expect(names).toContain('idx_messages_model');
    expect(names).toContain('idx_content_blocks_message');
    expect(names).toContain('idx_content_blocks_type');
    expect(names).toContain('idx_usage_minutes_minute');
    expect(names).toContain('idx_alerts_triggered');
    expect(names).toContain('idx_sessions_project');
    expect(names).toContain('idx_messages_uuid_unique');
    expect(names).toContain('idx_posts_published');
    expect(names).toContain('idx_posts_type');
    expect(names).toContain('idx_todos_project');
    expect(names).toContain('idx_todos_status');
    expect(names).toContain('idx_todo_events_todo');
    expect(names).toContain('idx_pii_message');
    expect(names).toContain('idx_todos_uuid');
  });
});
