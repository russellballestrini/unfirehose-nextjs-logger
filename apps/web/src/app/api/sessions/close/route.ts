import { NextRequest, NextResponse } from 'next/server';
import { getDb } from '@unturf/unfirehose/db/schema';
import { closeSessions, staleSessionUuids } from '@unturf/unfirehose/db/session-close';

/**
 * PATCH /api/sessions/close
 *
 * Close sessions and, by default, obsolete the todos they left open. Closed
 * sessions stay in the database for history — never deleted — and ingest
 * skips status updates for todos in terminal states, so a closed todo stays
 * closed when its file is re-read.
 *
 * Body, either shape:
 *   sessionUuids   — the sessions to close
 *   project + olderThanDays — every session in a project inactive that long
 *   obsoleteTodos  — cascade to their open todos (default true)
 *   reason         — echoed back for the caller's own log
 */
export async function PATCH(request: NextRequest) {
  try {
    const db = getDb();
    const { sessionUuids, project, olderThanDays, obsoleteTodos = true, reason } =
      await request.json();

    const uuids: string[] = Array.isArray(sessionUuids)
      ? sessionUuids
      : project && olderThanDays
        ? staleSessionUuids(db, project, olderThanDays)
        : [];

    if (uuids.length > 500) {
      return NextResponse.json({ error: 'max 500 sessions per batch' }, { status: 400 });
    }

    // One transaction: a half-finished sweep leaves sessions closed with
    // their todos still open, which is worse than not sweeping.
    const result = db.transaction(() =>
      closeSessions(db, uuids, { cascadeTodos: obsoleteTodos }),
    )();

    return NextResponse.json({ ok: true, ...result, reason: reason ?? null });
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 500 });
  }
}
