import { describe, it, expect, vi, beforeAll } from 'vitest';
import { NextRequest } from 'next/server';
import { createTestDb } from '@/test/db-helper';

const db = createTestDb();

// Add missing migrations that the test helper doesn't run
try { db.exec('ALTER TABLE sessions ADD COLUMN display_name TEXT'); } catch { /* already exists */ }

// Ensure todos table exists
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

function seedTodo(
  projectId: number,
  content: string,
  opts: { status?: string; source?: string; estimatedMinutes?: number | null } = {}
) {
  return db.prepare(
    "INSERT INTO todos (project_id, content, status, source, estimated_minutes, updated_at) VALUES (?, ?, ?, ?, ?, datetime('now'))"
  ).run(projectId, content, opts.status ?? 'pending', opts.source ?? 'claude', opts.estimatedMinutes ?? null)
    .lastInsertRowid as number;
}

describe('GET /api/todos/pending', () => {
  beforeAll(() => {
    db.exec('DELETE FROM todos');
  });

  it('returns 200 with an array', async () => {
    const res = await GET(req('/api/todos/pending'));
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(Array.isArray(data)).toBe(true);
  });

  it('only returns pending and in_progress todos', async () => {
    db.exec('DELETE FROM todos');
    const pid = seedProject('pending-test');
    seedTodo(pid, 'active work', { status: 'pending' });
    seedTodo(pid, 'wip', { status: 'in_progress' });
    seedTodo(pid, 'done', { status: 'completed' });

    const res = await GET(req('/api/todos/pending'));
    const data = await res.json();
    expect(data).toHaveLength(2);
    expect(data.every((t: { status: string }) => ['pending', 'in_progress'].includes(t.status))).toBe(true);
  });

  it('filters by project name', async () => {
    db.exec('DELETE FROM todos');
    const pid1 = seedProject('filter-proj-a');
    const pid2 = seedProject('filter-proj-b');
    seedTodo(pid1, 'task A');
    seedTodo(pid2, 'task B');

    const res = await GET(req('/api/todos/pending?project=filter-proj-a'));
    const data = await res.json();
    expect(data).toHaveLength(1);
    expect(data[0].project).toBe('filter-proj-a');
  });

  it('filters by source', async () => {
    db.exec('DELETE FROM todos');
    const pid = seedProject('source-test');
    seedTodo(pid, 'from claude', { source: 'claude' });
    seedTodo(pid, 'from fetch', { source: 'fetch' });
    seedTodo(pid, 'manual', { source: 'manual' });

    const res = await GET(req('/api/todos/pending?source=fetch'));
    const data = await res.json();
    expect(data).toHaveLength(1);
    expect(data[0].source).toBe('fetch');
  });

  it('filters by search substring', async () => {
    db.exec('DELETE FROM todos');
    const pid = seedProject('search-test');
    seedTodo(pid, 'write unit tests for the auth module');
    seedTodo(pid, 'deploy to production server');
    seedTodo(pid, 'fix auth defect in login flow');

    const res = await GET(req('/api/todos/pending?search=auth'));
    const data = await res.json();
    expect(data).toHaveLength(2);
    expect(data.every((t: { content: string }) => t.content.includes('auth'))).toBe(true);
  });

  it('filters by needs_ticket (estimated_minutes > 15)', async () => {
    db.exec('DELETE FROM todos');
    const pid = seedProject('ticket-test');
    seedTodo(pid, 'quick fix', { estimatedMinutes: 5 });
    seedTodo(pid, 'big refactor', { estimatedMinutes: 60 });
    seedTodo(pid, 'medium task', { estimatedMinutes: 20 });

    const res = await GET(req('/api/todos/pending?needs_ticket=true'));
    const data = await res.json();
    expect(data.length).toBe(2);
    expect(data.every((t: { estimatedMinutes: number }) => t.estimatedMinutes > 15)).toBe(true);
  });

  it('filters by quick (estimated_minutes <= 15 or null)', async () => {
    db.exec('DELETE FROM todos');
    const pid = seedProject('quick-test');
    seedTodo(pid, 'quick fix', { estimatedMinutes: 5 });
    seedTodo(pid, 'big refactor', { estimatedMinutes: 60 });
    seedTodo(pid, 'unestimated');

    const res = await GET(req('/api/todos/pending?quick=true'));
    const data = await res.json();
    expect(data.length).toBe(2);
  });

  it('respects the limit param', async () => {
    db.exec('DELETE FROM todos');
    const pid = seedProject('limit-test');
    for (let i = 0; i < 10; i++) seedTodo(pid, `task ${i}`);

    const res = await GET(req('/api/todos/pending?limit=3'));
    const data = await res.json();
    expect(data).toHaveLength(3);
  });

  it('returns rich fields on each todo', async () => {
    db.exec('DELETE FROM todos');
    const pid = seedProject('fields-test');
    seedTodo(pid, 'check all fields', { status: 'in_progress', estimatedMinutes: 10 });

    const res = await GET(req('/api/todos/pending'));
    const data = await res.json();
    const todo = data[0];
    expect(todo).toHaveProperty('id');
    expect(todo).toHaveProperty('content');
    expect(todo).toHaveProperty('status');
    expect(todo).toHaveProperty('source');
    expect(todo).toHaveProperty('project');
    expect(todo).toHaveProperty('projectDisplay');
    expect(todo).toHaveProperty('estimatedMinutes');
    expect(todo).toHaveProperty('needsTicket');
    expect(todo).toHaveProperty('staleDays');
    expect(todo).toHaveProperty('blockedBy');
    expect(Array.isArray(todo.blockedBy)).toBe(true);
  });

  it('puts in_progress todos before pending', async () => {
    db.exec('DELETE FROM todos');
    const pid = seedProject('order-test');
    seedTodo(pid, 'pending task', { status: 'pending' });
    seedTodo(pid, 'active task', { status: 'in_progress' });

    const res = await GET(req('/api/todos/pending'));
    const data = await res.json();
    expect(data[0].status).toBe('in_progress');
  });
});
