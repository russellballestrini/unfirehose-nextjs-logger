import { NextRequest, NextResponse } from 'next/server';
import { getDb } from '@sexy-logger/core/db/schema';

/* eslint-disable @typescript-eslint/no-explicit-any */

/**
 * GET /api/todos/stale
 *
 * Active todos that haven't been touched in a while. Good for cleanup sweeps.
 *
 * Query params:
 *   days    — stale threshold in days (default 3)
 *   limit   — max results (default 50)
 *   project — filter by project name
 */
export async function GET(request: NextRequest) {
  try {
    const db = getDb();
    const url = request.nextUrl;
    const days = parseInt(url.searchParams.get('days') ?? '3');
    const limit = Math.min(parseInt(url.searchParams.get('limit') ?? '50'), 500);
    const project = url.searchParams.get('project');

    const params: any[] = [days];
    let where = "t.status IN ('pending', 'in_progress') AND t.updated_at < datetime('now', '-' || ? || ' days')";

    if (project) {
      where += ' AND p.name = ?';
      params.push(project);
    }

    const rows = db.prepare(`
      SELECT t.id, t.uuid, t.content, t.status, t.source, t.estimated_minutes,
             t.created_at, t.updated_at,
             p.name as project, p.display_name as project_display
      FROM todos t
      JOIN projects p ON t.project_id = p.id
      WHERE ${where}
      ORDER BY t.updated_at ASC
      LIMIT ?
    `).all(...params, limit) as any[];

    const todos = rows.map(r => ({
      id: r.id,
      uuid: r.uuid,
      content: r.content,
      status: r.status,
      source: r.source,
      estimatedMinutes: r.estimated_minutes,
      project: r.project,
      projectDisplay: r.project_display,
      createdAt: r.created_at,
      updatedAt: r.updated_at,
      staleDays: Math.floor((Date.now() - new Date(r.updated_at).getTime()) / 86400000),
      needsTicket: (r.estimated_minutes ?? 0) > 15,
    }));

    return NextResponse.json({
      staleThresholdDays: days,
      count: todos.length,
      todos,
    });
  } catch (err: any) {
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}
