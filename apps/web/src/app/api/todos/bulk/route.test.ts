/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';
import { createTestDb } from '@/test/db-helper';

const db = createTestDb();

vi.mock('@unturf/unfirehose/db/schema', () => ({ getDb: () => db }));

const { PATCH } = await import('./route');

function req(body: any) {
  return new NextRequest(new URL('/api/todos/bulk', 'http://localhost:3000'), {
    method: 'PATCH',
    body: JSON.stringify(body),
    headers: { 'Content-Type': 'application/json' },
  });
}

function seedProject(name: string) {
  return db.prepare('INSERT OR IGNORE INTO projects (name, display_name) VALUES (?, ?)').run(name, name).lastInsertRowid as number;
}

function seedTodo(projectId: number, content: string, status = 'pending') {
  return db.prepare(
    "INSERT INTO todos (project_id, content, status, source, updated_at) VALUES (?, ?, ?, 'claude', datetime('now'))"
  ).run(projectId, content, status).lastInsertRowid as number;
}

beforeEach(() => {
  db.exec('DELETE FROM todo_events');
  db.exec('DELETE FROM todos');
  db.exec('DELETE FROM projects');
});

describe('PATCH /api/todos/bulk', () => {
  it('bulk-completes multiple todos', async () => {
    const pid = seedProject('bulk-test');
    const t1 = seedTodo(pid, 'Task 1');
    const t2 = seedTodo(pid, 'Task 2');
    const t3 = seedTodo(pid, 'Task 3');

    const res = await PATCH(req({ ids: [t1, t2, t3], status: 'completed' }));
    const data = await res.json();
    expect(data.ok).toBe(true);
    expect(data.updated).toBe(3);

    const todos = db.prepare('SELECT status FROM todos WHERE id IN (?, ?, ?)').all(t1, t2, t3) as any[];
    expect(todos.every((t: any) => t.status === 'completed')).toBe(true);
  });

  it('creates audit events for each status change', async () => {
    const pid = seedProject('audit-bulk');
    const t1 = seedTodo(pid, 'Task 1');
    const t2 = seedTodo(pid, 'Task 2');

    await PATCH(req({ ids: [t1, t2], status: 'completed' }));

    const events = db.prepare('SELECT * FROM todo_events WHERE todo_id IN (?, ?)').all(t1, t2) as any[];
    expect(events.length).toBe(2);
    expect(events.every((e: any) => e.old_status === 'pending' && e.new_status === 'completed')).toBe(true);
  });

  it('sets completed_at for completed status', async () => {
    const pid = seedProject('completed-at');
    const tid = seedTodo(pid, 'Complete me');

    await PATCH(req({ ids: [tid], status: 'completed' }));

    const todo = db.prepare('SELECT completed_at FROM todos WHERE id = ?').get(tid) as any;
    expect(todo.completed_at).toBeTruthy();
  });

  it('sets completed_at for obsolete status', async () => {
    const pid = seedProject('obsolete-at');
    const tid = seedTodo(pid, 'Mark obsolete');

    await PATCH(req({ ids: [tid], status: 'obsolete' }));

    const todo = db.prepare('SELECT completed_at, status FROM todos WHERE id = ?').get(tid) as any;
    expect(todo.status).toBe('obsolete');
    expect(todo.completed_at).toBeTruthy();
  });

  it('handles re-ingestion scenario: bulk close resurrected todos', async () => {
    const pid = seedProject('reingest');
    // Simulate re-ingestion creating 5 pending todos that were previously completed
    const ids = [];
    for (let i = 0; i < 5; i++) {
      ids.push(seedTodo(pid, `Resurrected todo ${i}`));
    }

    const res = await PATCH(req({ ids, status: 'completed' }));
    const data = await res.json();
    expect(data.updated).toBe(5);

    // Verify all completed
    const pending = db.prepare("SELECT COUNT(*) as c FROM todos WHERE status = 'pending'").get() as any;
    expect(pending.c).toBe(0);
  });

  it('rejects empty ids array', async () => {
    const res = await PATCH(req({ ids: [], status: 'completed' }));
    expect(res.status).toBe(400);
  });

  it('rejects more than 500 ids', async () => {
    const ids = Array.from({ length: 501 }, (_, i) => i + 1);
    const res = await PATCH(req({ ids, status: 'completed' }));
    expect(res.status).toBe(400);
  });

  it('sets estimated_minutes in bulk', async () => {
    const pid = seedProject('estimate-bulk');
    const t1 = seedTodo(pid, 'Task 1');
    const t2 = seedTodo(pid, 'Task 2');

    const res = await PATCH(req({ ids: [t1, t2], estimatedMinutes: 15 }));
    const data = await res.json();
    expect(data.updated).toBe(2);

    const todos = db.prepare('SELECT estimated_minutes FROM todos WHERE id IN (?, ?)').all(t1, t2) as any[];
    expect(todos.every((t: any) => t.estimated_minutes === 15)).toBe(true);
  });

  it('skips non-existent ids gracefully', async () => {
    const pid = seedProject('skip-test');
    const tid = seedTodo(pid, 'Real task');

    const res = await PATCH(req({ ids: [tid, 99999], status: 'completed' }));
    const data = await res.json();
    expect(data.updated).toBe(1);
  });
});
