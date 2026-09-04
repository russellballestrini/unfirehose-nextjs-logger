import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createTestDb, seedProject, seedSession } from '../test/db-helper';

let db = createTestDb();
vi.mock('./schema', () => ({ getDb: () => db }));

const { closeSessions, staleSessionUuids, obsoleteTodo } = await import('./session-close');

/**
 * The cascade two routes rely on. What matters is that a closed session
 * never leaves todos behind, and that closing says so honestly: `obsolete`,
 * not `completed`, because a session ending is evidence the todo stopped
 * being tracked and no evidence the work was done.
 */
const addTodo = (sessionId: number, projectId: number, content: string, status = 'pending') =>
  db.prepare(
    `INSERT INTO todos (project_id, session_id, content, status) VALUES (?, ?, ?, ?)`,
  ).run(projectId, sessionId, content, status).lastInsertRowid as number;

const statusOf = (id: number) =>
  (db.prepare('SELECT status FROM todos WHERE id = ?').get(id) as { status: string }).status;

let project: number;
let session: number;

beforeEach(() => {
  db = createTestDb();
  project = seedProject(db, 'proj');
  session = seedSession(db, project, 'session-one');
});

describe('closeSessions', () => {
  it('closes a session and obsoletes the todos it left open', () => {
    const open = addTodo(session, project, 'unfinished');
    const running = addTodo(session, project, 'mid-flight', 'in_progress');

    const result = closeSessions(db, ['session-one']);

    expect(result).toEqual({ closedSessions: 1, obsoletedTodos: 2 });
    expect(statusOf(open)).toBe('obsolete');
    expect(statusOf(running)).toBe('obsolete');
  });

  it('leaves a finished todo alone', () => {
    // Rewriting completed to obsolete would erase the one fact we know.
    const done = addTodo(session, project, 'shipped', 'completed');
    closeSessions(db, ['session-one']);
    expect(statusOf(done)).toBe('completed');
  });

  it('records what each todo was before, so the sweep is reversible', () => {
    const running = addTodo(session, project, 'mid-flight', 'in_progress');
    closeSessions(db, ['session-one']);

    const event = db.prepare(
      'SELECT old_status, new_status FROM todo_events WHERE todo_id = ?',
    ).get(running) as { old_status: string; new_status: string };
    expect(event).toEqual({ old_status: 'in_progress', new_status: 'obsolete' });
  });

  it('counts a session only the first time it closes', () => {
    closeSessions(db, ['session-one']);
    expect(closeSessions(db, ['session-one']).closedSessions).toBe(0);
  });

  it('can close a session without touching its todos', () => {
    const open = addTodo(session, project, 'keep me');
    const result = closeSessions(db, ['session-one'], { cascadeTodos: false });

    expect(result.closedSessions).toBe(1);
    expect(result.obsoletedTodos).toBe(0);
    expect(statusOf(open)).toBe('pending');
  });

  it('ignores a uuid that is not ours', () => {
    expect(closeSessions(db, ['no-such-session'])).toEqual({
      closedSessions: 0, obsoletedTodos: 0,
    });
  });
});

describe('staleSessionUuids', () => {
  it('finds only sessions untouched for longer than asked', () => {
    db.prepare("UPDATE sessions SET updated_at = datetime('now', '-40 days') WHERE session_uuid = ?")
      .run('session-one');
    const fresh = seedSession(db, project, 'session-fresh');
    db.prepare("UPDATE sessions SET updated_at = datetime('now') WHERE id = ?").run(fresh);

    expect(staleSessionUuids(db, 'proj', 30)).toEqual(['session-one']);
  });

  it('does not return a session already closed', () => {
    db.prepare("UPDATE sessions SET updated_at = datetime('now', '-40 days') WHERE session_uuid = ?")
      .run('session-one');
    closeSessions(db, ['session-one']);
    expect(staleSessionUuids(db, 'proj', 30)).toEqual([]);
  });

  it('stays within the project it was asked about', () => {
    const other = seedProject(db, 'other-proj');
    const theirs = seedSession(db, other, 'their-session');
    db.prepare("UPDATE sessions SET updated_at = datetime('now', '-90 days')").run();

    expect(staleSessionUuids(db, 'proj', 30)).toEqual(['session-one']);
    void theirs;
  });
});

describe('obsoleteTodo', () => {
  it('stamps a completion time so a closed todo can be aged out', () => {
    const id = addTodo(session, project, 'whatever');
    obsoleteTodo(db, id, 'pending');
    const row = db.prepare('SELECT status, completed_at FROM todos WHERE id = ?').get(id) as
      { status: string; completed_at: string | null };
    expect(row.status).toBe('obsolete');
    expect(row.completed_at).toBeTruthy();
  });
});
