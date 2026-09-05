/**
 * Closing a session, and what that does to its todos.
 *
 * Two routes implemented this — /api/sessions/close and /api/triage — with
 * the same four statements written out twice. It is not layout: a session
 * closes, its open todos become obsolete, and each of those writes a
 * todo_events row recording what the status was before. Drift here means
 * closing from one path leaves todos open that closing from the other would
 * have cleared, and nothing would say so.
 *
 * `obsolete` rather than `completed` throughout, because a session ending is
 * evidence that a todo stopped being tracked and no evidence at all that the
 * work was done. Claude Code never closes its own todo lists — it just stops
 * — which is why these pile up in the thousands and why the distinction
 * matters when we sweep them.
 */

import type Database from 'better-sqlite3';
import { OPEN_TODO_SQL } from './session-facts';

export interface CloseResult {
  closedSessions: number;
  obsoletedTodos: number;
}

/** Session uuids for a project untouched for longer than `olderThanDays`. */
export function staleSessionUuids(
  db: Database.Database,
  project: string,
  olderThanDays: number,
): string[] {
  const rows = db.prepare(`
    SELECT s.session_uuid AS uuid
    FROM sessions s
    JOIN projects p ON s.project_id = p.id
    WHERE p.name = ?
      AND (s.status IS NULL OR s.status = 'active')
      AND COALESCE(s.last_message_at, s.updated_at) < datetime('now', ?)
  `).all(project, `-${olderThanDays} days`) as { uuid: string }[];
  return rows.map((r) => r.uuid);
}

/**
 * Close each session and, unless told otherwise, obsolete the todos it left
 * open. The caller owns the transaction: a partial sweep is worse than none.
 */
export function closeSessions(
  db: Database.Database,
  uuids: string[],
  { cascadeTodos = true, now = new Date().toISOString() } = {},
): CloseResult {
  const closeSession = db.prepare(
    `UPDATE sessions SET status = 'closed', closed_at = ?
     WHERE session_uuid = ? AND (status IS NULL OR status = 'active')`,
  );
  const findTodos = db.prepare(
    `SELECT t.id, t.status FROM todos t
     JOIN sessions s ON t.session_id = s.id
     WHERE s.session_uuid = ? AND t.status ${OPEN_TODO_SQL}`,
  );

  const result: CloseResult = { closedSessions: 0, obsoletedTodos: 0 };

  for (const uuid of uuids) {
    if (closeSession.run(now, uuid).changes > 0) result.closedSessions += 1;
    if (!cascadeTodos) continue;

    for (const todo of findTodos.all(uuid) as { id: number; status: string }[]) {
      obsoleteTodo(db, todo.id, todo.status, now);
      result.obsoletedTodos += 1;
    }
  }

  return result;
}

/** Mark one todo obsolete and record what it was. */
export function obsoleteTodo(
  db: Database.Database,
  id: number,
  fromStatus: string,
  now = new Date().toISOString(),
): void {
  db.prepare(
    'UPDATE todos SET status = ?, updated_at = ?, completed_at = ? WHERE id = ?',
  ).run('obsolete', now, now, id);
  db.prepare(
    `INSERT INTO todo_events (todo_id, old_status, new_status, event_at)
     VALUES (?, ?, 'obsolete', ?)`,
  ).run(id, fromStatus, now);
}
