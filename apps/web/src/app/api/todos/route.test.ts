/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';
import { createTestDb } from '@/test/db-helper';

const db = createTestDb();

vi.mock('@unturf/unfirehose/db/schema', () => ({ getDb: () => db }));
vi.mock('@unturf/unfirehose/uuidv7', () => ({ uuidv7: () => 'test-uuid-001' }));

const { GET, POST, PATCH, DELETE: DELETE_handler } = await import('./route');

function req(url: string, opts?: { method?: string; body?: any }) {
  const r = new NextRequest(new URL(url, 'http://localhost:3000'), {
    method: opts?.method ?? 'GET',
    ...(opts?.body ? { body: JSON.stringify(opts.body), headers: { 'Content-Type': 'application/json' } } : {}),
  });
  return r;
}

function seedProject(name: string) {
  return db.prepare('INSERT OR IGNORE INTO projects (name, display_name, path) VALUES (?, ?, ?)').run(name, name, '/test/' + name).lastInsertRowid as number;
}

function seedTodo(projectId: number, content: string, opts: { status?: string; source?: string } = {}) {
  return db.prepare(
    "INSERT INTO todos (project_id, content, status, source, updated_at) VALUES (?, ?, ?, ?, datetime('now'))"
  ).run(projectId, content, opts.status ?? 'pending', opts.source ?? 'claude').lastInsertRowid as number;
}

beforeEach(() => {
  db.exec('DELETE FROM todo_events');
  db.exec('DELETE FROM todos');
  db.exec('DELETE FROM projects');
});

// === POST /api/todos ===

describe('POST /api/todos', () => {
  it('creates a todo with required fields', async () => {
    seedProject('post-test');
    const res = await POST(req('/api/todos', {
      method: 'POST',
      body: { content: 'Write tests', projectName: 'post-test' },
    }));
    const data = await res.json();
    expect(res.status).toBe(200);
    expect(data.ok).toBe(true);
    expect(data.id).toBeGreaterThan(0);
  });

  it('rejects empty content', async () => {
    seedProject('empty-test');
    const res = await POST(req('/api/todos', {
      method: 'POST',
      body: { content: '', projectName: 'empty-test' },
    }));
    expect(res.status).toBe(400);
  });

  it('creates in_progress todo when status specified', async () => {
    seedProject('status-test');
    const res = await POST(req('/api/todos', {
      method: 'POST',
      body: { content: 'Start now', projectName: 'status-test', status: 'in_progress' },
    }));
    const data = await res.json();
    expect(data.ok).toBe(true);

    const todo = db.prepare('SELECT status FROM todos WHERE id = ?').get(data.id) as any;
    expect(todo.status).toBe('in_progress');
  });

  it('creates audit event on creation', async () => {
    seedProject('audit-test');
    const res = await POST(req('/api/todos', {
      method: 'POST',
      body: { content: 'Audited task', projectName: 'audit-test' },
    }));
    const data = await res.json();
    const events = db.prepare('SELECT * FROM todo_events WHERE todo_id = ?').all(data.id) as any[];
    expect(events.length).toBe(1);
    expect(events[0].new_status).toBe('pending');
    expect(events[0].old_status).toBeNull();
  });
});

// === PATCH /api/todos ===

describe('PATCH /api/todos', () => {
  it('updates status', async () => {
    const pid = seedProject('patch-test');
    const tid = seedTodo(pid, 'Complete me');
    const res = await PATCH(req('/api/todos', {
      method: 'PATCH',
      body: { id: tid, status: 'completed' },
    }));
    expect(res.status).toBe(200);
    const todo = db.prepare('SELECT status FROM todos WHERE id = ?').get(tid) as any;
    expect(todo.status).toBe('completed');
  });

  it('sets estimated_minutes', async () => {
    const pid = seedProject('estimate-test');
    const tid = seedTodo(pid, 'Estimate me');
    await PATCH(req('/api/todos', {
      method: 'PATCH',
      body: { id: tid, estimatedMinutes: 30 },
    }));
    const todo = db.prepare('SELECT estimated_minutes FROM todos WHERE id = ?').get(tid) as any;
    expect(todo.estimated_minutes).toBe(30);
  });

  it('rejects without id', async () => {
    const res = await PATCH(req('/api/todos', {
      method: 'PATCH',
      body: { status: 'completed' },
    }));
    expect(res.status).toBe(400);
  });
});

// === DELETE /api/todos ===

describe('DELETE /api/todos', () => {
  it('soft-deletes a single todo', async () => {
    const pid = seedProject('delete-test');
    const tid = seedTodo(pid, 'Delete me');
    const res = await DELETE_handler(req('/api/todos', {
      method: 'DELETE',
      body: { id: tid },
    }));
    const data = await res.json();
    expect(data.ok).toBe(true);
    expect(data.deleted).toBe(1);

    const todo = db.prepare('SELECT status FROM todos WHERE id = ?').get(tid) as any;
    expect(todo.status).toBe('deleted');
  });

  it('soft-deletes multiple todos', async () => {
    const pid = seedProject('bulk-delete-test');
    const t1 = seedTodo(pid, 'Task 1');
    const t2 = seedTodo(pid, 'Task 2');
    const t3 = seedTodo(pid, 'Task 3');

    const res = await DELETE_handler(req('/api/todos', {
      method: 'DELETE',
      body: { ids: [t1, t2, t3] },
    }));
    const data = await res.json();
    expect(data.deleted).toBe(3);
  });

  it('creates audit events for each deletion', async () => {
    const pid = seedProject('delete-audit-test');
    const tid = seedTodo(pid, 'Audit delete');
    await DELETE_handler(req('/api/todos', {
      method: 'DELETE',
      body: { id: tid },
    }));
    const events = db.prepare('SELECT * FROM todo_events WHERE todo_id = ?').all(tid) as any[];
    expect(events.length).toBe(1);
    expect(events[0].new_status).toBe('deleted');
  });

  it('rejects without id or ids', async () => {
    const res = await DELETE_handler(req('/api/todos', {
      method: 'DELETE',
      body: {},
    }));
    expect(res.status).toBe(400);
  });
});

// === GET /api/todos ===

describe('GET /api/todos', () => {
  it('excludes deleted todos', async () => {
    const pid = seedProject('get-test');
    seedTodo(pid, 'Active task');
    const del = seedTodo(pid, 'Deleted task');
    db.prepare("UPDATE todos SET status = 'deleted' WHERE id = ?").run(del);

    const res = await GET(req('/api/todos'));
    const data = await res.json();
    expect(data.todos.length).toBe(1);
    expect(data.todos[0].content).toBe('Active task');
  });

  it('returns counts excluding deleted', async () => {
    const pid = seedProject('count-test');
    seedTodo(pid, 'Pending 1');
    seedTodo(pid, 'Pending 2');
    seedTodo(pid, 'Done', { status: 'completed' });
    const del = seedTodo(pid, 'Gone');
    db.prepare("UPDATE todos SET status = 'deleted' WHERE id = ?").run(del);

    const res = await GET(req('/api/todos'));
    const data = await res.json();
    expect(data.counts.pending).toBe(2);
    expect(data.counts.completed).toBe(1);
    expect(data.counts.total).toBe(3);
  });

  it('filters by project', async () => {
    const p1 = seedProject('proj-a');
    const p2 = seedProject('proj-b');
    seedTodo(p1, 'Task A');
    seedTodo(p2, 'Task B');

    const res = await GET(req('/api/todos?project=proj-a'));
    const data = await res.json();
    expect(data.todos.length).toBe(1);
  });

  it('filters by status', async () => {
    const pid = seedProject('status-filter');
    seedTodo(pid, 'Pending');
    seedTodo(pid, 'Working', { status: 'in_progress' });
    seedTodo(pid, 'Done', { status: 'completed' });

    const res = await GET(req('/api/todos?status=in_progress'));
    const data = await res.json();
    expect(data.todos.length).toBe(1);
    expect(data.todos[0].status).toBe('in_progress');
  });

  it('groups by project in byProject', async () => {
    const p1 = seedProject('group-a');
    const p2 = seedProject('group-b');
    seedTodo(p1, 'Task A1');
    seedTodo(p1, 'Task A2');
    seedTodo(p2, 'Task B1');

    const res = await GET(req('/api/todos'));
    const data = await res.json();
    expect(data.byProject.length).toBe(2);
    const groupA = data.byProject.find((g: any) => g.project === 'group-a');
    expect(groupA.todos.length).toBe(2);
  });
});
