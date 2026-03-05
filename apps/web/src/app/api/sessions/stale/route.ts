import { NextRequest, NextResponse } from 'next/server';
import { getDb } from '@unfirehose/core/db/schema';

/* eslint-disable @typescript-eslint/no-explicit-any */

/**
 * GET /api/sessions/stale
 *
 * Find sessions that look inactive and should be considered for closing.
 * A session is stale if its last activity exceeds the threshold.
 *
 * Query params:
 *   days     — inactivity threshold (default 7)
 *   project  — filter by project name
 *   limit    — max results (default 50)
 *   status   — filter by session status (default: active)
 *
 * Returns sessions with their todo counts and age info.
 */
export async function GET(request: NextRequest) {
  try {
    const db = getDb();
    const url = request.nextUrl;
    const days = parseInt(url.searchParams.get('days') ?? '7');
    const project = url.searchParams.get('project');
    const limit = Math.min(parseInt(url.searchParams.get('limit') ?? '50'), 200);
    const status = url.searchParams.get('status') ?? 'active';

    const params: any[] = [];
    let where = `(s.status IS NULL OR s.status = ?) AND COALESCE(s.last_message_at, s.updated_at) < datetime('now', ?)`;
    params.push(status, `-${days} days`);

    if (project) {
      where += ' AND p.name = ?';
      params.push(project);
    }

    const sessions = db.prepare(`
      SELECT
        s.id, s.session_uuid, s.display_name, s.first_prompt,
        s.git_branch, s.status, s.created_at, s.updated_at, s.last_message_at, s.cli_version,
        p.name as project_name, p.display_name as project_display,
        CAST(julianday('now') - julianday(COALESCE(s.last_message_at, s.updated_at)) AS INTEGER) as inactive_days,
        (SELECT COUNT(*) FROM messages m WHERE m.session_id = s.id) as message_count,
        (SELECT COUNT(*) FROM todos t WHERE t.session_id = s.id AND t.status IN ('pending', 'in_progress')) as pending_todos,
        (SELECT COUNT(*) FROM todos t WHERE t.session_id = s.id) as total_todos
      FROM sessions s
      JOIN projects p ON s.project_id = p.id
      WHERE ${where}
      ORDER BY s.updated_at ASC
      LIMIT ?
    `).all(...params, limit) as any[];

    const summary = db.prepare(`
      SELECT
        COUNT(*) as total_sessions,
        COUNT(*) FILTER (WHERE s.status IS NULL OR s.status = 'active') as active_sessions,
        COUNT(*) FILTER (WHERE s.status = 'closed') as closed_sessions,
        COUNT(*) FILTER (WHERE (s.status IS NULL OR s.status = 'active') AND COALESCE(s.last_message_at, s.updated_at) < datetime('now', ?)) as stale_sessions
      FROM sessions s
    `).get(`-${days} days`) as any;

    return NextResponse.json({
      thresholdDays: days,
      summary: {
        total: summary.total_sessions,
        active: summary.active_sessions,
        closed: summary.closed_sessions,
        stale: summary.stale_sessions,
      },
      sessions: sessions.map(s => ({
        id: s.id,
        sessionUuid: s.session_uuid,
        displayName: s.display_name ?? s.first_prompt?.slice(0, 80) ?? s.session_uuid?.slice(0, 8),
        firstPrompt: s.first_prompt?.slice(0, 200),
        gitBranch: s.git_branch,
        status: s.status ?? 'active',
        cliVersion: s.cli_version,
        createdAt: s.created_at,
        updatedAt: s.updated_at,
        lastMessageAt: s.last_message_at,
        inactiveDays: s.inactive_days,
        projectName: s.project_name,
        projectDisplay: s.project_display,
        messageCount: s.message_count,
        pendingTodos: s.pending_todos,
        totalTodos: s.total_todos,
      })),
    });
  } catch (err: any) {
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}
