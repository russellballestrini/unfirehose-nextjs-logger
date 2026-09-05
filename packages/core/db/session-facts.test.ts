import { describe, it, expect } from 'vitest';
import {
  OPEN_TODO_STATUSES, CLOSED_TODO_STATUSES, OPEN_TODO_SQL, CLOSED_TODO_SQL,
  isOpenTodo, INACTIVE_DAYS_SQL, MESSAGE_COUNT_SQL, OPEN_TODO_COUNT_SQL,
} from './session-facts';
import { createTestDb, seedProject, seedSession, seedTodo, seedMessage } from '../test/db-helper';

/**
 * What our queries mean by "open" and "idle".
 *
 * "A todo is open" was spelled out seventeen times across eight files.
 * Adding a status would have meant finding all seventeen, and the ones
 * missed would answer a different question from the ones changed — which
 * is not a failure anything reports, only a number that stops adding up.
 *
 * These fragments go into real queries here, because a SQL string that is
 * never executed is a string.
 */

const db = createTestDb();
const projectId = seedProject(db, '-home-fox-git-demo', 'demo');

describe('what counts as open', () => {
  it('is pending or in progress, and nothing else', () => {
    expect([...OPEN_TODO_STATUSES]).toEqual(['pending', 'in_progress']);
    expect([...CLOSED_TODO_STATUSES]).toEqual(['completed', 'obsolete']);
  });

  it('partitions every status we use — none is both, none is neither', () => {
    const open = new Set<string>(OPEN_TODO_STATUSES);
    for (const s of CLOSED_TODO_STATUSES) expect(open.has(s)).toBe(false);
    expect([...OPEN_TODO_STATUSES, ...CLOSED_TODO_STATUSES].sort())
      .toEqual(['completed', 'in_progress', 'obsolete', 'pending']);
  });

  it('answers the same way in a query and in hand', () => {
    // Two spellings of one rule is the thing this module exists to stop.
    for (const s of OPEN_TODO_STATUSES) expect(isOpenTodo(s)).toBe(true);
    for (const s of CLOSED_TODO_STATUSES) expect(isOpenTodo(s)).toBe(false);
    expect(isOpenTodo('blocked')).toBe(false);
  });

  it('quotes each value separately, not the list', () => {
    expect(OPEN_TODO_SQL).toBe("IN ('pending', 'in_progress')");
    expect(CLOSED_TODO_SQL).toBe("IN ('completed', 'obsolete')");
  });
});

describe('the fragments run', () => {
  const sessionId = seedSession(db, projectId, 'sess-facts');
  seedMessage(db, sessionId, { type: 'assistant', uuid: 'facts-m1' });
  seedMessage(db, sessionId, { type: 'user', uuid: 'facts-m2' });
  seedTodo(db, projectId, 'still open', { status: 'pending', uuid: 'f1' });
  seedTodo(db, projectId, 'in flight', { status: 'in_progress', uuid: 'f2' });
  seedTodo(db, projectId, 'finished', { status: 'completed', uuid: 'f3' });
  db.prepare('UPDATE todos SET session_id = ? WHERE uuid IN (?, ?, ?)')
    .run(sessionId, 'f1', 'f2', 'f3');

  it('counts only open todos', () => {
    const row = db.prepare(
      `SELECT ${OPEN_TODO_COUNT_SQL} AS n FROM sessions s WHERE s.id = ?`,
    ).get(sessionId) as { n: number };
    expect(row.n).toBe(2);
  });

  it('counts a session\'s messages', () => {
    const row = db.prepare(
      `SELECT ${MESSAGE_COUNT_SQL} AS n FROM sessions s WHERE s.id = ?`,
    ).get(sessionId) as { n: number };
    expect(row.n).toBe(2);
  });

  it('reads a session touched just now as idle for no days', () => {
    db.prepare("UPDATE sessions SET last_message_at = datetime('now') WHERE id = ?").run(sessionId);
    const row = db.prepare(
      `SELECT ${INACTIVE_DAYS_SQL} AS d FROM sessions s WHERE s.id = ?`,
    ).get(sessionId) as { d: number };
    expect(row.d).toBe(0);
  });

  it('answers null, not a number, for a session with no timestamps at all', () => {
    // Both columns null makes the arithmetic null, and every staleness
    // rule compares with `>` — so such a session is never swept. That is
    // the safe direction, and it is worth knowing it is what happens
    // rather than assuming a zero or an infinity.
    const bare = seedSession(db, projectId, 'sess-bare');
    db.prepare('UPDATE sessions SET last_message_at = NULL, updated_at = NULL WHERE id = ?').run(bare);
    const row = db.prepare(
      `SELECT ${INACTIVE_DAYS_SQL} AS d FROM sessions s WHERE s.id = ?`,
    ).get(bare) as { d: number | null };
    expect(row.d).toBeNull();
  });

  it('falls back to updated_at for a session that produced no messages', () => {
    // Otherwise an empty session reads as infinitely idle and is swept up
    // by every staleness rule we have.
    const empty = seedSession(db, projectId, 'sess-empty');
    db.prepare("UPDATE sessions SET last_message_at = NULL, updated_at = datetime('now', '-3 days') WHERE id = ?")
      .run(empty);
    const row = db.prepare(
      `SELECT ${INACTIVE_DAYS_SQL} AS d FROM sessions s WHERE s.id = ?`,
    ).get(empty) as { d: number };
    expect(row.d).toBe(3);
  });

  it('prefers the last message over the row\'s own timestamp', () => {
    const touched = seedSession(db, projectId, 'sess-touched');
    db.prepare(`UPDATE sessions SET last_message_at = datetime('now', '-1 day'),
                updated_at = datetime('now', '-9 days') WHERE id = ?`).run(touched);
    const row = db.prepare(
      `SELECT ${INACTIVE_DAYS_SQL} AS d FROM sessions s WHERE s.id = ?`,
    ).get(touched) as { d: number };
    expect(row.d).toBe(1);
  });
});
