import { NextRequest, NextResponse } from 'next/server';
import { getDb } from '@sexy-logger/core/db/schema';

/* eslint-disable @typescript-eslint/no-explicit-any */

/**
 * GET /api/todos/pending
 *
 * Flat list of actionable todos (pending + in_progress).
 * Designed for agents (Claude Code, Fetch, scripts) to quickly find work.
 *
 * Query params:
 *   project  — filter by project name
 *   source   — filter by source (claude, fetch, manual)
 *   search   — substring match on content
 *   limit    — max results (default 100)
 *   needs_ticket — if "true", only items with estimated_minutes > 15
 *   quick    — if "true", only items with estimated_minutes <= 15
 *
 * Returns plain array — no nesting, no grouping.
 */
export async function GET(request: NextRequest) {
  try {
    const db = getDb();
    const url = request.nextUrl;
    const project = url.searchParams.get('project');
    const source = url.searchParams.get('source');
    const search = url.searchParams.get('search');
    const limit = Math.min(parseInt(url.searchParams.get('limit') ?? '100'), 1000);
    const needsTicket = url.searchParams.get('needs_ticket') === 'true';
    const quick = url.searchParams.get('quick') === 'true';

    const params: any[] = [];
    let where = "t.status IN ('pending', 'in_progress')";

    if (project) {
      where += ' AND p.name = ?';
      params.push(project);
    }
    if (source) {
      where += ' AND t.source = ?';
      params.push(source);
    }
    if (search) {
      where += ' AND t.content LIKE ?';
      params.push(`%${search}%`);
    }
    if (needsTicket) {
      where += ' AND t.estimated_minutes > 15';
    }
    if (quick) {
      where += ' AND (t.estimated_minutes IS NULL OR t.estimated_minutes <= 15)';
    }

    const rows = db.prepare(`
      SELECT t.id, t.uuid, t.content, t.status, t.source, t.external_id,
             t.estimated_minutes, t.active_form, t.blocked_by,
             t.created_at, t.updated_at,
             p.name as project, p.display_name as project_display,
             s.session_uuid, s.display_name as session_display
      FROM todos t
      JOIN projects p ON t.project_id = p.id
      LEFT JOIN sessions s ON t.session_id = s.id
      WHERE ${where}
      ORDER BY
        CASE t.status WHEN 'in_progress' THEN 0 ELSE 1 END,
        t.updated_at DESC
      LIMIT ?
    `).all(...params, limit) as any[];

    const todos = rows.map(r => ({
      id: r.id,
      uuid: r.uuid,
      content: r.content,
      status: r.status,
      source: r.source,
      externalId: r.external_id,
      estimatedMinutes: r.estimated_minutes,
      activeForm: r.active_form,
      blockedBy: r.blocked_by ? JSON.parse(r.blocked_by) : [],
      project: r.project,
      projectDisplay: r.project_display,
      sessionUuid: r.session_uuid,
      sessionDisplay: r.session_display,
      createdAt: r.created_at,
      updatedAt: r.updated_at,
      needsTicket: (r.estimated_minutes ?? 0) > 15,
      staleDays: Math.floor((Date.now() - new Date(r.updated_at).getTime()) / 86400000),
    }));

    return NextResponse.json(todos);
  } catch (err: any) {
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}
