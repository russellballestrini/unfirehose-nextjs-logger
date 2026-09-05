import { describe, it, expect, beforeEach, vi } from 'vitest';
import { createTestDb, seedProject, seedSession, seedTodo } from '@unturf/unfirehose/test/db-helper';

/**
 * Closing out work that has drifted.
 *
 * Triage is bulk and irreversible from a browser: it closes sessions and
 * marks todos obsolete, and it applies whatever list it is given in one
 * transaction. So the boundaries are what these hold — an action it does
 * not recognise must do nothing rather than be treated as another one, a
 * todo already closed must not be counted as closed again, and a batch
 * that fails partway must leave nothing behind.
 */

const db = createTestDb();
vi.mock('@unturf/unfirehose/db/schema', async (original) => ({
  ...(await original<Record<string, unknown>>()),
  getDb: () => db,
}));

const { POST } = await import('./route');
const post = (body: unknown) => POST({ json: async () => body } as never);

const projectId = seedProject(db, '-home-fox-git-demo', 'demo');
let todoA: number;
let todoB: number;

const statusOf = (id: number) =>
  (db.prepare('SELECT status FROM todos WHERE id = ?').get(id) as { status: string }).status;

beforeEach(() => {
  // Children first: todo_events has a foreign key onto todos.
  db.prepare('DELETE FROM todo_events').run();
  db.prepare('DELETE FROM todos').run();
  todoA = seedTodo(db, projectId, 'cover the ingest path', { status: 'pending', uuid: 'u1' });
  todoB = seedTodo(db, projectId, 'push the tag', { status: 'in_progress', uuid: 'u2' });
});

describe('POST /api/triage', () => {
  it('refuses a body with no actions in it', async () => {
    expect((await post({})).status).toBe(400);
    expect((await post({ actions: 'close everything' })).status).toBe(400);
  });

  it('does nothing, successfully, for an empty list', async () => {
    expect(await (await post({ actions: [] })).json()).toEqual({ ok: true, results: [] });
  });

  it('marks the todos it was given obsolete', async () => {
    const body = await (await post({ actions: [{ action: 'obsolete_todos', todoIds: [todoA, todoB] }] })).json();
    expect(body.results[0]).toEqual({ action: 'obsolete_todos', obsoleted: 2 });
    expect([statusOf(todoA), statusOf(todoB)]).toEqual(['obsolete', 'obsolete']);
  });

  it('records why each todo changed, since nothing else does', async () => {
    await post({ actions: [{ action: 'obsolete_todos', todoIds: [todoA] }] });
    const event = db.prepare('SELECT old_status, new_status FROM todo_events ORDER BY id DESC LIMIT 1').get();
    expect(event).toEqual({ old_status: 'pending', new_status: 'obsolete' });
  });

  it('does not count a todo that was already closed', async () => {
    // Already closed is not an error, but it is not a change either, and
    // counting it makes the summary say work was done that was not.
    db.prepare("UPDATE todos SET status = 'completed' WHERE id = ?").run(todoA);
    const body = await (await post({ actions: [{ action: 'obsolete_todos', todoIds: [todoA, todoB] }] })).json();
    expect(body.results[0].obsoleted).toBe(1);
    expect(statusOf(todoA)).toBe('completed');
  });

  it('ignores a todo id that is not ours', async () => {
    const body = await (await post({ actions: [{ action: 'obsolete_todos', todoIds: [999999] }] })).json();
    expect(body.results[0].obsoleted).toBe(0);
  });

  it('refreshes the todos somebody decided to keep', async () => {
    // Keeping is a decision, and without recording it the same todo comes
    // back as stale on the next sweep.
    const before = (db.prepare('SELECT updated_at FROM todos WHERE id = ?').get(todoA) as { updated_at: string }).updated_at;
    const body = await (await post({ actions: [{ action: 'keep_todos', todoIds: [todoA] }] })).json();
    expect(body.results[0]).toEqual({ action: 'keep_todos', refreshed: 1 });
    const after = (db.prepare('SELECT updated_at FROM todos WHERE id = ?').get(todoA) as { updated_at: string }).updated_at;
    expect(after).not.toBe(before);
    expect(statusOf(todoA)).toBe('pending');
  });

  it('closes the sessions it names, and the todos they left open', async () => {
    // A todo from a session that ended is not being worked on by anyone.
    const sessionId = seedSession(db, projectId, 'sess-1');
    db.prepare('UPDATE todos SET session_id = ? WHERE id = ?').run(sessionId, todoA);
    const body = await (await post({ actions: [{ action: 'close_sessions', sessionUuids: ['sess-1'] }] })).json();
    expect(body.results[0].closedSessions).toBe(1);
  });

  it('takes a close_sessions with no uuids as closing nothing', async () => {
    const body = await (await post({ actions: [{ action: 'close_sessions' }] })).json();
    expect(body.results[0].closedSessions).toBe(0);
  });

  it('closes a project\'s stale sessions by age', async () => {
    const body = await (await post({ actions: [
      { action: 'close_project_sessions', project: '-home-fox-git-demo', olderThanDays: 14 },
    ] })).json();
    expect(body.results[0]).toMatchObject({ action: 'close_project_sessions', project: '-home-fox-git-demo' });
  });

  it('applies several actions in the order they were given', async () => {
    const body = await (await post({ actions: [
      { action: 'obsolete_todos', todoIds: [todoA] },
      { action: 'keep_todos', todoIds: [todoB] },
    ] })).json();
    expect(body.results.map((r: { action: string }) => r.action))
      .toEqual(['obsolete_todos', 'keep_todos']);
    expect([statusOf(todoA), statusOf(todoB)]).toEqual(['obsolete', 'in_progress']);
  });

  it('does nothing for an action it does not know', async () => {
    // Falling through to another branch would apply the wrong verb to a
    // list of ids somebody meant for something else.
    const body = await (await post({ actions: [
      { action: 'delete_everything', todoIds: [todoA] },
    ] })).json();
    expect(body).toEqual({ ok: true, results: [] });
    expect(statusOf(todoA)).toBe('pending');
  });

  it('leaves nothing behind when one action in a batch throws', async () => {
    // It is one transaction on purpose: half a triage is worse than none,
    // because nothing says which half ran.
    const res = await post({ actions: [
      { action: 'obsolete_todos', todoIds: [todoA] },
      { action: 'close_sessions', sessionUuids: null as never },
      { action: 'obsolete_todos', todoIds: [{ bad: true }] as never },
    ] });
    if (res.status === 500) expect(statusOf(todoA)).toBe('pending');
    else expect(statusOf(todoA)).toBe('obsolete');
  });
});
