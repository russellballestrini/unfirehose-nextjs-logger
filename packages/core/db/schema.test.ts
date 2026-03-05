import { describe, it, expect } from 'vitest';
import { createTestDb } from '../test/db-helper';

describe('schema migration', () => {
  it('creates all expected tables', () => {
    const db = createTestDb();
    const tables = db.prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name"
    ).all() as { name: string }[];
    const names = tables.map((t) => t.name);

    expect(names).toContain('projects');
    expect(names).toContain('sessions');
    expect(names).toContain('messages');
    expect(names).toContain('content_blocks');
    expect(names).toContain('usage_minutes');
    expect(names).toContain('alerts');
    expect(names).toContain('alert_thresholds');
    expect(names).toContain('ingest_offsets');
    db.close();
  });

  it('creates expected indexes', () => {
    const db = createTestDb();
    const indexes = db.prepare(
      "SELECT name FROM sqlite_master WHERE type='index' AND name LIKE 'idx_%' ORDER BY name"
    ).all() as { name: string }[];
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
    db.close();
  });

  it('seeds 7 default alert thresholds', () => {
    const db = createTestDb();
    const count = db.prepare('SELECT COUNT(*) as c FROM alert_thresholds').get() as { c: number };
    expect(count.c).toBe(7);
    db.close();
  });

  it('migration is idempotent (running DDL twice does not error)', () => {
    const db = createTestDb();
    // Run the same DDL again — should not throw
    expect(() => {
      db.exec('CREATE TABLE IF NOT EXISTS projects (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT UNIQUE NOT NULL, display_name TEXT NOT NULL, path TEXT, first_seen TEXT NOT NULL DEFAULT (datetime(\'now\')))');
    }).not.toThrow();
    db.close();
  });

  it('enforces foreign key constraints', () => {
    const db = createTestDb();
    // Inserting a session with a non-existent project_id should fail
    expect(() => {
      db.prepare('INSERT INTO sessions (session_uuid, project_id) VALUES (?, ?)').run('test', 9999);
    }).toThrow();
    db.close();
  });

  it('enforces unique constraint on messages.message_uuid', () => {
    const db = createTestDb();
    // Setup: project + session
    db.prepare('INSERT INTO projects (name, display_name) VALUES (?, ?)').run('p', 'p');
    db.prepare('INSERT INTO sessions (session_uuid, project_id) VALUES (?, ?)').run('s', 1);
    // First insert
    db.prepare('INSERT INTO messages (session_id, message_uuid, type) VALUES (?, ?, ?)').run(1, 'uuid-1', 'user');
    // Duplicate uuid should fail with INSERT (not INSERT OR IGNORE)
    expect(() => {
      db.prepare('INSERT INTO messages (session_id, message_uuid, type) VALUES (?, ?, ?)').run(1, 'uuid-1', 'user');
    }).toThrow();
    db.close();
  });

  it('allows null message_uuid (no unique constraint on null)', () => {
    const db = createTestDb();
    db.prepare('INSERT INTO projects (name, display_name) VALUES (?, ?)').run('p', 'p');
    db.prepare('INSERT INTO sessions (session_uuid, project_id) VALUES (?, ?)').run('s', 1);
    // Multiple null uuids should be fine
    db.prepare('INSERT INTO messages (session_id, message_uuid, type) VALUES (?, ?, ?)').run(1, null, 'user');
    db.prepare('INSERT INTO messages (session_id, message_uuid, type) VALUES (?, ?, ?)').run(1, null, 'user');
    const count = db.prepare('SELECT COUNT(*) as c FROM messages').get() as { c: number };
    expect(count.c).toBe(2);
    db.close();
  });

  it('projects table has correct columns', () => {
    const db = createTestDb();
    const cols = db.prepare("PRAGMA table_info('projects')").all() as { name: string }[];
    const names = cols.map((c) => c.name);
    expect(names).toEqual(expect.arrayContaining(['id', 'name', 'display_name', 'path', 'first_seen']));
    db.close();
  });

  it('messages table has token columns', () => {
    const db = createTestDb();
    const cols = db.prepare("PRAGMA table_info('messages')").all() as { name: string }[];
    const names = cols.map((c) => c.name);
    expect(names).toContain('input_tokens');
    expect(names).toContain('output_tokens');
    expect(names).toContain('cache_read_tokens');
    expect(names).toContain('cache_creation_tokens');
    db.close();
  });
});
