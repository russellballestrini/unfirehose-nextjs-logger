import { describe, it, expect, vi, beforeAll } from 'vitest';
import { NextRequest } from 'next/server';
import { createTestDb } from '@/test/db-helper';

const db = createTestDb();

db.exec(`
  CREATE TABLE IF NOT EXISTS todos (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    project_id INTEGER NOT NULL REFERENCES projects(id),
    session_id INTEGER REFERENCES sessions(id),
    external_id TEXT,
    uuid TEXT,
    content TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending',
    active_form TEXT,
    source TEXT NOT NULL DEFAULT 'claude',
    source_session_uuid TEXT,
    blocked_by TEXT,
    estimated_minutes INTEGER,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    completed_at TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_todos_project ON todos(project_id);
  CREATE INDEX IF NOT EXISTS idx_todos_status ON todos(status);
`);

vi.mock('@unfirehose/core/db/schema', () => ({ getDb: () => db }));

const { GET } = await import('./route');

function req(url: string) {
  return new NextRequest(new URL(url, 'http://localhost:3000'));
}

function seedProject(name: string) {
  return db.prepare('INSERT OR IGNORE INTO projects (name, display_name) VALUES (?, ?)').run(name, name).lastInsertRowid as number;
}

function seedTodoWithAge(projectId: number, content: string, daysOld: number, status = 'pending') {
  return db.prepare(
    "INSERT INTO todos (project_id, content, status, updated_at, created_at) VALUES (?, ?, ?, datetime('now', ? || ' days'), datetime('now', ? || ' days'))"
  ).run(projectId, content, status, `-${daysOld}`, `-${daysOld}`).lastInsertRowid as number;
}

describe('GET /api/todos/stale', () => {
  beforeAll(() => {
    db.exec('DELETE FROM todos');
  });

  it('returns 200 with staleThresholdDays, count, todos', async () => {
    const res = await GET(req('/api/todos/stale'));
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data).toHaveProperty('staleThresholdDays');
    expect(data).toHaveProperty('count');
    expect(Array.isArray(data.todos)).toBe(true);
  });

  it('default threshold is 3 days', async () => {
    const res = await GET(req('/api/todos/stale'));
    const data = await res.json();
    expect(data.staleThresholdDays).toBe(3);
  });

  it('returns todos older than threshold', async () => {
    db.exec('DELETE FROM todos');
    const pid = seedProject('stale-basic');
    seedTodoWithAge(pid, 'old pending task', 5);    // stale
    seedTodoWithAge(pid, 'fresh task', 1);           // not stale
    seedTodoWithAge(pid, 'completed old', 10, 'completed'); // stale but completed

    const res = await GET(req('/api/todos/stale?days=3'));
    const data = await res.json();
    expect(data.count).toBe(1);
    expect(data.todos[0].content).toBe('old pending task');
  });

  it('custom days threshold works', async () => {
    db.exec('DELETE FROM todos');
    const pid = seedProject('stale-custom');
    seedTodoWithAge(pid, 'two day old task', 2);
    seedTodoWithAge(pid, 'six day old task', 6);

    const res = await GET(req('/api/todos/stale?days=5'));
    const data = await res.json();
    expect(data.staleThresholdDays).toBe(5);
    expect(data.count).toBe(1);
    expect(data.todos[0].content).toBe('six day old task');
  });

  it('filters by project name', async () => {
    db.exec('DELETE FROM todos');
    const pid1 = seedProject('stale-proj-1');
    const pid2 = seedProject('stale-proj-2');
    seedTodoWithAge(pid1, 'stale in proj 1', 5);
    seedTodoWithAge(pid2, 'stale in proj 2', 5);

    const res = await GET(req('/api/todos/stale?days=3&project=stale-proj-1'));
    const data = await res.json();
    expect(data.count).toBe(1);
    expect(data.todos[0].project).toBe('stale-proj-1');
  });

  it('respects limit param', async () => {
    db.exec('DELETE FROM todos');
    const pid = seedProject('stale-limit');
    for (let i = 0; i < 8; i++) seedTodoWithAge(pid, `stale task ${i}`, 7);

    const res = await GET(req('/api/todos/stale?days=3&limit=3'));
    const data = await res.json();
    expect(data.todos).toHaveLength(3);
  });

  it('returns staleDays on each todo', async () => {
    db.exec('DELETE FROM todos');
    const pid = seedProject('stale-fields');
    seedTodoWithAge(pid, 'stale with days', 5);

    const res = await GET(req('/api/todos/stale?days=3'));
    const data = await res.json();
    expect(data.todos[0]).toHaveProperty('staleDays');
    expect(data.todos[0].staleDays).toBeGreaterThanOrEqual(4);
  });

  it('returns needsTicket=true for todos with estimatedMinutes > 15', async () => {
    db.exec('DELETE FROM todos');
    const pid = seedProject('stale-ticket');
    db.prepare(
      "INSERT INTO todos (project_id, content, status, estimated_minutes, updated_at) VALUES (?, 'big stale task', 'pending', 30, datetime('now', '-5 days'))"
    ).run(pid);

    const res = await GET(req('/api/todos/stale?days=3'));
    const data = await res.json();
    expect(data.todos[0].needsTicket).toBe(true);
  });

  it('count matches todos array length', async () => {
    db.exec('DELETE FROM todos');
    const pid = seedProject('stale-count');
    seedTodoWithAge(pid, 'stale a', 4);
    seedTodoWithAge(pid, 'stale b', 6);

    const res = await GET(req('/api/todos/stale'));
    const data = await res.json();
    expect(data.count).toBe(data.todos.length);
  });
});
