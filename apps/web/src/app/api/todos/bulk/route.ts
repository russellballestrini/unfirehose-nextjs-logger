import { NextRequest, NextResponse } from 'next/server';
import { getDb } from '@unfirehose/core/db/schema';

/* eslint-disable @typescript-eslint/no-explicit-any */

/**
 * PATCH /api/todos/bulk
 *
 * Batch-update multiple todos at once. Agents can complete, estimate, or
 * change status for a list of todo IDs in one call.
 *
 * Body:
 *   ids              — array of todo IDs to update
 *   status           — new status for all (pending, in_progress, completed)
 *   estimatedMinutes — set time estimate for all
 *
 * Example: { "ids": [1, 5, 12], "status": "completed" }
 */
export async function PATCH(request: NextRequest) {
  try {
    const db = getDb();
    const body = await request.json();
    const { ids, status, estimatedMinutes } = body;

    if (!ids || !Array.isArray(ids) || ids.length === 0) {
      return NextResponse.json({ error: 'ids array required' }, { status: 400 });
    }
    if (ids.length > 500) {
      return NextResponse.json({ error: 'max 500 ids per batch' }, { status: 400 });
    }

    const now = new Date().toISOString();
    let updated = 0;

    const tx = db.transaction(() => {
      for (const id of ids) {
        if (status) {
          const old = db.prepare('SELECT status FROM todos WHERE id = ?').get(id) as any;
          if (!old) continue;

          const completedAt = (status === 'completed' || status === 'obsolete') ? now : null;
          db.prepare(
            'UPDATE todos SET status = ?, updated_at = ?, completed_at = COALESCE(?, completed_at) WHERE id = ?'
          ).run(status, now, completedAt, id);

          if (old.status !== status) {
            db.prepare(
              'INSERT INTO todo_events (todo_id, old_status, new_status, event_at) VALUES (?, ?, ?, ?)'
            ).run(id, old.status, status, now);
          }
          updated++;
        }

        if (estimatedMinutes !== undefined) {
          db.prepare('UPDATE todos SET estimated_minutes = ?, updated_at = ? WHERE id = ?')
            .run(estimatedMinutes, now, id);
          if (!status) updated++;
        }
      }
    });
    tx();

    return NextResponse.json({ ok: true, updated });
  } catch (err: any) {
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}
