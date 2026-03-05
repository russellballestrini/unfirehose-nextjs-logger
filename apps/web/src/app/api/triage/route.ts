import { NextRequest, NextResponse } from 'next/server';
import { getDb } from '@sexy-logger/core/db/schema';

/* eslint-disable @typescript-eslint/no-explicit-any */

/**
 * GET /api/triage
 *
 * Comprehensive triage overview: projects → sessions → todos, with staleness
 * indicators and actionability signals. Designed for agents to make bulk
 * close/keep decisions without LLMs.
 *
 * Query params:
 *   project  — filter to one project
 *   days     — staleness threshold (default 7)
 *   limit    — max projects (default 25)
 *
 * Returns hierarchical view: projects with their stale sessions and todo counts.
 */
export async function GET(request: NextRequest) {
  try {
    const db = getDb();
    const url = request.nextUrl;
    const project = url.searchParams.get('project');
    const days = parseInt(url.searchParams.get('days') ?? '7');
    const limit = Math.min(parseInt(url.searchParams.get('limit') ?? '25'), 50);

    // Overall counts
    const totals = db.prepare(`
      SELECT
        (SELECT COUNT(*) FROM sessions WHERE status IS NULL OR status = 'active') as active_sessions,
        (SELECT COUNT(*) FROM sessions WHERE status = 'closed') as closed_sessions,
        (SELECT COUNT(*) FROM todos WHERE status IN ('pending', 'in_progress')) as open_todos,
        (SELECT COUNT(*) FROM todos WHERE status IN ('completed', 'obsolete')) as closed_todos,
        (SELECT COUNT(*) FROM sessions
         WHERE (status IS NULL OR status = 'active')
         AND COALESCE(last_message_at, updated_at) < datetime('now', ?)) as stale_sessions,
        (SELECT COUNT(*) FROM todos
         WHERE status IN ('pending', 'in_progress')
         AND created_at < datetime('now', ?)) as stale_todos
    `).get(`-${days} days`, `-${days} days`) as any;

    // Per-project breakdown
    const params: any[] = [`-${days} days`, `-${days} days`];
    let projectFilter = '';
    if (project) {
      projectFilter = 'AND p.name = ?';
      params.push(project);
    }

    const projects = db.prepare(`
      SELECT
        p.name, p.display_name,
        COUNT(DISTINCT s.id) as total_sessions,
        COUNT(DISTINCT CASE WHEN (s.status IS NULL OR s.status = 'active')
          AND COALESCE(s.last_message_at, s.updated_at) < datetime('now', ?) THEN s.id END) as stale_sessions,
        COUNT(DISTINCT CASE WHEN s.status = 'closed' THEN s.id END) as closed_sessions,
        (SELECT COUNT(*) FROM todos t WHERE t.project_id = p.id
         AND t.status IN ('pending', 'in_progress')) as open_todos,
        (SELECT COUNT(*) FROM todos t WHERE t.project_id = p.id
         AND t.status IN ('pending', 'in_progress')
         AND t.created_at < datetime('now', ?)) as stale_todos
      FROM projects p
      LEFT JOIN sessions s ON s.project_id = p.id
      WHERE 1=1 ${projectFilter}
      GROUP BY p.id
      HAVING open_todos > 0 OR stale_sessions > 0
      ORDER BY stale_sessions DESC, open_todos DESC
      LIMIT ?
    `).all(...params, limit) as any[];

    // If drilling into a project, include session details
    let sessionDetails: any[] = [];
    if (project) {
      sessionDetails = db.prepare(`
        SELECT
          s.session_uuid, s.display_name, s.first_prompt, s.status,
          s.created_at, s.updated_at, s.last_message_at, s.cli_version,
          CAST(julianday('now') - julianday(COALESCE(s.last_message_at, s.updated_at)) AS INTEGER) as inactive_days,
          (SELECT COUNT(*) FROM messages m WHERE m.session_id = s.id) as message_count,
          (SELECT COUNT(*) FROM todos t WHERE t.session_id = s.id
           AND t.status IN ('pending', 'in_progress')) as pending_todos,
          (SELECT GROUP_CONCAT(t.id) FROM todos t WHERE t.session_id = s.id
           AND t.status IN ('pending', 'in_progress')) as pending_todo_ids
        FROM sessions s
        JOIN projects p ON s.project_id = p.id
        WHERE p.name = ? AND (s.status IS NULL OR s.status = 'active')
        ORDER BY s.updated_at ASC
        LIMIT 100
      `).all(project) as any[];
    }

    return NextResponse.json({
      thresholdDays: days,
      totals: {
        activeSessions: totals.active_sessions,
        closedSessions: totals.closed_sessions,
        openTodos: totals.open_todos,
        closedTodos: totals.closed_todos,
        staleSessions: totals.stale_sessions,
        staleTodos: totals.stale_todos,
      },
      projects: projects.map(p => ({
        name: p.name,
        display: p.display_name,
        totalSessions: p.total_sessions,
        staleSessions: p.stale_sessions,
        closedSessions: p.closed_sessions,
        openTodos: p.open_todos,
        staleTodos: p.stale_todos,
      })),
      sessions: sessionDetails.map(s => ({
        sessionUuid: s.session_uuid,
        displayName: s.display_name ?? s.first_prompt?.slice(0, 80) ?? s.session_uuid?.slice(0, 8),
        firstPrompt: s.first_prompt?.slice(0, 200),
        status: s.status ?? 'active',
        cliVersion: s.cli_version,
        createdAt: s.created_at,
        updatedAt: s.updated_at,
        inactiveDays: s.inactive_days,
        messageCount: s.message_count,
        pendingTodos: s.pending_todos,
        pendingTodoIds: s.pending_todo_ids ? s.pending_todo_ids.split(',').map(Number) : [],
      })),
    });
  } catch (err: any) {
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}

/**
 * POST /api/triage
 *
 * Execute a triage plan in one call. Close sessions and obsolete their todos.
 *
 * Body:
 *   actions — array of:
 *     { action: "close_project_sessions", project: "name", olderThanDays: 14 }
 *     { action: "close_sessions", sessionUuids: ["uuid1", "uuid2"] }
 *     { action: "obsolete_todos", todoIds: [1, 2, 3] }
 *     { action: "keep_todos", todoIds: [4, 5] }  (set estimated_minutes, mark as triaged)
 */
export async function POST(request: NextRequest) {
  try {
    const db = getDb();
    const body = await request.json();
    const { actions } = body;

    if (!actions || !Array.isArray(actions)) {
      return NextResponse.json({ error: 'actions array required' }, { status: 400 });
    }

    const now = new Date().toISOString();
    const results: any[] = [];

    const tx = db.transaction(() => {
      for (const action of actions) {
        switch (action.action) {
          case 'close_project_sessions': {
            const rows = db.prepare(`
              SELECT s.session_uuid
              FROM sessions s
              JOIN projects p ON s.project_id = p.id
              WHERE p.name = ?
                AND (s.status IS NULL OR s.status = 'active')
                AND COALESCE(s.last_message_at, s.updated_at) < datetime('now', ?)
            `).all(action.project, `-${action.olderThanDays} days`) as any[];

            let closed = 0;
            let obsoleted = 0;
            for (const row of rows) {
              db.prepare(
                `UPDATE sessions SET status = 'closed', closed_at = ? WHERE session_uuid = ?`
              ).run(now, row.session_uuid);
              closed++;

              const todos = db.prepare(
                `SELECT t.id, t.status FROM todos t
                 JOIN sessions s ON t.session_id = s.id
                 WHERE s.session_uuid = ? AND t.status IN ('pending', 'in_progress')`
              ).all(row.session_uuid) as any[];

              for (const t of todos) {
                db.prepare(
                  `UPDATE todos SET status = 'obsolete', updated_at = ?, completed_at = ? WHERE id = ?`
                ).run(now, now, t.id);
                db.prepare(
                  `INSERT INTO todo_events (todo_id, old_status, new_status, event_at) VALUES (?, ?, 'obsolete', ?)`
                ).run(t.id, t.status, now);
                obsoleted++;
              }
            }
            results.push({ action: action.action, project: action.project, closedSessions: closed, obsoletedTodos: obsoleted });
            break;
          }

          case 'close_sessions': {
            let closed = 0;
            let obsoleted = 0;
            for (const uuid of (action.sessionUuids ?? [])) {
              const r = db.prepare(
                `UPDATE sessions SET status = 'closed', closed_at = ? WHERE session_uuid = ? AND (status IS NULL OR status = 'active')`
              ).run(now, uuid);
              if (r.changes > 0) closed++;

              const todos = db.prepare(
                `SELECT t.id, t.status FROM todos t
                 JOIN sessions s ON t.session_id = s.id
                 WHERE s.session_uuid = ? AND t.status IN ('pending', 'in_progress')`
              ).all(uuid) as any[];

              for (const t of todos) {
                db.prepare(
                  `UPDATE todos SET status = 'obsolete', updated_at = ?, completed_at = ? WHERE id = ?`
                ).run(now, now, t.id);
                db.prepare(
                  `INSERT INTO todo_events (todo_id, old_status, new_status, event_at) VALUES (?, ?, 'obsolete', ?)`
                ).run(t.id, t.status, now);
                obsoleted++;
              }
            }
            results.push({ action: action.action, closedSessions: closed, obsoletedTodos: obsoleted });
            break;
          }

          case 'obsolete_todos': {
            let count = 0;
            for (const id of (action.todoIds ?? [])) {
              const old = db.prepare('SELECT status FROM todos WHERE id = ?').get(id) as any;
              if (!old || old.status === 'completed' || old.status === 'obsolete') continue;
              db.prepare(
                `UPDATE todos SET status = 'obsolete', updated_at = ?, completed_at = ? WHERE id = ?`
              ).run(now, now, id);
              db.prepare(
                `INSERT INTO todo_events (todo_id, old_status, new_status, event_at) VALUES (?, ?, 'obsolete', ?)`
              ).run(id, old.status, now);
              count++;
            }
            results.push({ action: action.action, obsoleted: count });
            break;
          }

          case 'keep_todos': {
            let count = 0;
            for (const id of (action.todoIds ?? [])) {
              db.prepare(
                `UPDATE todos SET updated_at = ? WHERE id = ? AND status IN ('pending', 'in_progress')`
              ).run(now, id);
              count++;
            }
            results.push({ action: action.action, refreshed: count });
            break;
          }
        }
      }
    });
    tx();

    return NextResponse.json({ ok: true, results });
  } catch (err: any) {
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}
