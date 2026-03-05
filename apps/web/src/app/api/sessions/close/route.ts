import { NextRequest, NextResponse } from 'next/server';
import { getDb } from '@sexy-logger/core/db/schema';

/* eslint-disable @typescript-eslint/no-explicit-any */

/**
 * PATCH /api/sessions/close
 *
 * Close sessions and optionally obsolete all their pending todos.
 * Closed sessions are preserved in the DB for training/history — never deleted.
 * The ingest process skips status updates for todos in terminal states,
 * so closed todos stay closed even on re-ingestion.
 *
 * Body:
 *   sessionUuids   — array of session UUIDs to close
 *   obsoleteTodos  — if true, mark all pending/in_progress todos as 'obsolete' (default true)
 *   reason         — optional reason string stored in todo_events
 *
 * Alternative body (close by age):
 *   project        — project name (required with olderThanDays)
 *   olderThanDays  — close all sessions inactive for N+ days in this project
 *   obsoleteTodos  — same as above
 *   reason         — same as above
 */
export async function PATCH(request: NextRequest) {
  try {
    const db = getDb();
    const body = await request.json();
    const { sessionUuids, project, olderThanDays, obsoleteTodos = true, reason } = body;

    const now = new Date().toISOString();
    let closedSessions = 0;
    let obsoletedTodos = 0;

    const tx = db.transaction(() => {
      let uuids: string[] = [];

      if (sessionUuids && Array.isArray(sessionUuids)) {
        uuids = sessionUuids;
      } else if (project && olderThanDays) {
        // Find sessions by age
        const rows = db.prepare(`
          SELECT s.session_uuid
          FROM sessions s
          JOIN projects p ON s.project_id = p.id
          WHERE p.name = ?
            AND (s.status IS NULL OR s.status = 'active')
            AND COALESCE(s.last_message_at, s.updated_at) < datetime('now', ?)
        `).all(project, `-${olderThanDays} days`) as any[];
        uuids = rows.map((r: any) => r.session_uuid);
      }

      if (uuids.length === 0) return;
      if (uuids.length > 500) throw new Error('max 500 sessions per batch');

      const closeSession = db.prepare(
        `UPDATE sessions SET status = 'closed', closed_at = ? WHERE session_uuid = ? AND (status IS NULL OR status = 'active')`
      );
      const findTodos = db.prepare(
        `SELECT t.id, t.status FROM todos t
         JOIN sessions s ON t.session_id = s.id
         WHERE s.session_uuid = ? AND t.status IN ('pending', 'in_progress')`
      );
      const obsoleteTodo = db.prepare(
        `UPDATE todos SET status = 'obsolete', updated_at = ?, completed_at = ? WHERE id = ?`
      );
      const logEvent = db.prepare(
        `INSERT INTO todo_events (todo_id, old_status, new_status, event_at) VALUES (?, ?, 'obsolete', ?)`
      );

      for (const uuid of uuids) {
        const result = closeSession.run(now, uuid);
        if (result.changes > 0) closedSessions++;

        if (obsoleteTodos) {
          const todos = findTodos.all(uuid) as any[];
          for (const todo of todos) {
            obsoleteTodo.run(now, now, todo.id);
            logEvent.run(todo.id, todo.status, now);
            obsoletedTodos++;
          }
        }
      }
    });
    tx();

    return NextResponse.json({
      ok: true,
      closedSessions,
      obsoletedTodos,
      reason: reason ?? null,
    });
  } catch (err: any) {
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}
