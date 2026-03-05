import { describe, it, expect, vi } from 'vitest';
import { createTestDb } from '@/test/db-helper';

// Build the test DB before mocking so the module mock can use it
const db = createTestDb();

// The todos table may not be in the helper; run the DDL here
db.exec(`
  CREATE TABLE IF NOT EXISTS todos (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    project_id INTEGER NOT NULL REFERENCES projects(id),
    session_id INTEGER REFERENCES sessions(id),
    external_id TEXT,
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

vi.mock('@sexy-logger/core/db/schema', () => ({ getDb: () => db }));

const { GET } = await import('./route');

function seedProject(name = 'proj-a') {
  return db.prepare('INSERT OR IGNORE INTO projects (name, display_name) VALUES (?, ?)').run(name, name).lastInsertRowid as number;
}

function seedTodo(projectId: number, status = 'pending', estimatedMinutes: number | null = null) {
  return db.prepare(
    "INSERT INTO todos (project_id, content, status, estimated_minutes, updated_at) VALUES (?, 'do something', ?, ?, datetime('now', '-1 day'))"
  ).run(projectId, status, estimatedMinutes).lastInsertRowid as number;
}

describe('GET /api/todos/summary', () => {
  it('returns 200 with counts object', async () => {
    const res = await GET();
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data).toHaveProperty('counts');
    expect(data.counts).toHaveProperty('pending');
    expect(data.counts).toHaveProperty('inProgress');
    expect(data.counts).toHaveProperty('completed');
    expect(data.counts).toHaveProperty('total');
  });

  it('returns totalMinutes, unestimated, needsTicket, staleCount fields', async () => {
    const res = await GET();
    const data = await res.json();
    expect(data).toHaveProperty('totalMinutes');
    expect(data).toHaveProperty('unestimated');
    expect(data).toHaveProperty('needsTicket');
    expect(data).toHaveProperty('staleCount');
  });

  it('returns byProject and bySource arrays', async () => {
    const res = await GET();
    const data = await res.json();
    expect(Array.isArray(data.byProject)).toBe(true);
    expect(Array.isArray(data.bySource)).toBe(true);
  });

  it('counts pending todos correctly', async () => {
    // Wipe existing todos to have a clean count
    db.exec('DELETE FROM todos');
    const pid = seedProject('count-test');
    seedTodo(pid, 'pending');
    seedTodo(pid, 'pending');
    seedTodo(pid, 'completed');

    const res = await GET();
    const data = await res.json();
    expect(data.counts.pending).toBe(2);
    expect(data.counts.completed).toBe(1);
    expect(data.counts.total).toBe(3);
  });

  it('counts unestimated todos correctly', async () => {
    db.exec('DELETE FROM todos');
    const pid = seedProject('est-test');
    seedTodo(pid, 'pending', null);          // unestimated
    seedTodo(pid, 'pending', 10);            // estimated, quick
    seedTodo(pid, 'pending', 20);            // estimated, needs ticket

    const res = await GET();
    const data = await res.json();
    expect(data.unestimated).toBe(1);
    expect(data.needsTicket).toBe(1);
  });

  it('returns oldestPending as null when no pending todos', async () => {
    db.exec('DELETE FROM todos');
    const pid = seedProject('no-pending');
    seedTodo(pid, 'completed');

    const res = await GET();
    const data = await res.json();
    expect(data.oldestPending).toBeNull();
  });

  it('returns oldestPending object when pending todos exist', async () => {
    db.exec('DELETE FROM todos');
    const pid = seedProject('has-pending');
    seedTodo(pid, 'pending');

    const res = await GET();
    const data = await res.json();
    expect(data.oldestPending).not.toBeNull();
    expect(data.oldestPending).toHaveProperty('id');
    expect(data.oldestPending).toHaveProperty('content');
    expect(data.oldestPending).toHaveProperty('project');
    expect(data.oldestPending).toHaveProperty('staleDays');
  });

  it('byProject groups todos by project', async () => {
    db.exec('DELETE FROM todos');
    const pid1 = seedProject('proj-x');
    const pid2 = seedProject('proj-y');
    seedTodo(pid1, 'pending');
    seedTodo(pid1, 'pending');
    seedTodo(pid2, 'in_progress');

    const res = await GET();
    const data = await res.json();
    expect(data.byProject.length).toBeGreaterThanOrEqual(2);
    const projX = data.byProject.find((p: { project: string }) => p.project === 'proj-x');
    expect(projX).toBeDefined();
    expect(projX.pending).toBe(2);
  });
});
