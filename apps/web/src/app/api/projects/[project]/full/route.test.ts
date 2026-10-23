import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createTestDb, seedProject, seedTodo } from '@unturf/unfirehose/test/db-helper';

/**
 * The project overview's open-todo list holds open todos only, so an empty
 * list means "all done" or "never had one". The empty state differs between
 * the two, and `hasAnyTodos` is how the page tells them apart.
 */

const db = createTestDb();
vi.mock('@unturf/unfirehose/db/schema', () => ({ getDb: () => db }));
vi.mock('@unturf/unfirehose/pricing-sync', () => ({ ensurePricingHydrated: () => {} }));

const { GET } = await import('./route');

const call = async (project: string) => {
  const { NextRequest } = await import('next/server');
  const req = new NextRequest(new Request(`http://localhost/api/projects/${project}/full`));
  return GET(req, { params: Promise.resolve({ project }) });
};

beforeEach(() => {
  db.prepare('DELETE FROM todos').run();
  db.prepare('DELETE FROM projects').run();
});

describe('GET /api/projects/[project]/full — hasAnyTodos', () => {
  it('is false for a project that never had a todo', async () => {
    seedProject(db, 'demo');
    const body = await (await call('demo')).json();
    expect(body.todos).toEqual([]);
    expect(body.hasAnyTodos).toBe(false);
  });

  it('is true when every todo is long finished and the open list is empty', async () => {
    const id = seedProject(db, 'demo');
    seedTodo(db, id, 'shipped', { status: 'completed', completedAt: '2026-01-01 00:00:00' });
    const body = await (await call('demo')).json();
    expect(body.todos).toEqual([]);
    expect(body.hasAnyTodos).toBe(true);
  });

  it('is true while a todo is open', async () => {
    const id = seedProject(db, 'demo');
    seedTodo(db, id, 'write the test');
    const body = await (await call('demo')).json();
    expect(body.todos).toHaveLength(1);
    expect(body.hasAnyTodos).toBe(true);
  });
});
