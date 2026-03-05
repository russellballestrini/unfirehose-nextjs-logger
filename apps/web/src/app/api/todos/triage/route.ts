import { NextRequest, NextResponse } from 'next/server';
import { getDb } from '@unfirehose/core/db/schema';

/* eslint-disable @typescript-eslint/no-explicit-any */

/**
 * GET /api/todos/triage?project=X
 *
 * Todos grouped by originating session with session context for quick triage.
 * Each session group includes: mission summary (first user prompt), session age,
 * todo count, and the todos themselves.
 *
 * This is the primary endpoint for the BLACKOPS triage protocol:
 * - Check session age (staleDays)
 * - Read session mission (firstPrompt)
 * - Decide: trash the whole batch or keep individual items
 *
 * Query params:
 *   project  — required, project name
 *   status   — filter (default: pending,in_progress)
 *   limit    — max sessions to return (default 20)
 */
export async function GET(request: NextRequest) {
  try {
    const db = getDb();
    const url = request.nextUrl;
    const project = url.searchParams.get('project');
    const statusFilter = url.searchParams.get('status') ?? 'pending,in_progress';
    const limit = Math.min(parseInt(url.searchParams.get('limit') ?? '20'), 100);

    if (!project) {
      return NextResponse.json({ error: 'project param required' }, { status: 400 });
    }

    const statuses = statusFilter.split(',');
    const statusPlaceholders = statuses.map(() => '?').join(',');

    // Get todos grouped by session
    const todos = db.prepare(`
      SELECT t.id, t.uuid, t.content, t.status, t.source, t.estimated_minutes,
             t.blocked_by, t.created_at, t.updated_at, t.external_id,
             s.session_uuid, s.display_name as session_display,
             s.first_prompt, s.created_at as session_created, s.updated_at as session_updated
      FROM todos t
      JOIN projects p ON t.project_id = p.id
      LEFT JOIN sessions s ON t.session_id = s.id
      WHERE p.name = ? AND t.status IN (${statusPlaceholders})
      ORDER BY t.updated_at DESC
    `).all(project, ...statuses) as any[];

    // Group by session
    const sessionMap: Record<string, {
      sessionUuid: string | null;
      sessionDisplay: string | null;
      firstPrompt: string | null;
      sessionCreated: string | null;
      sessionUpdated: string | null;
      staleDays: number;
      todos: any[];
    }> = {};

    for (const t of todos) {
      const key = t.session_uuid ?? '_orphan';
      if (!sessionMap[key]) {
        const sessionAge = t.session_updated
          ? Math.floor((Date.now() - new Date(t.session_updated).getTime()) / 86400000)
          : 999;
        sessionMap[key] = {
          sessionUuid: t.session_uuid,
          sessionDisplay: t.session_display,
          firstPrompt: t.first_prompt?.slice(0, 300) ?? null,
          sessionCreated: t.session_created,
          sessionUpdated: t.session_updated,
          staleDays: sessionAge,
          todos: [],
        };
      }
      sessionMap[key].todos.push({
        id: t.id,
        uuid: t.uuid,
        content: t.content,
        status: t.status,
        source: t.source,
        estimatedMinutes: t.estimated_minutes,
        blockedBy: t.blocked_by ? JSON.parse(t.blocked_by) : [],
        externalId: t.external_id,
        createdAt: t.created_at,
        updatedAt: t.updated_at,
        staleDays: Math.floor((Date.now() - new Date(t.updated_at).getTime()) / 86400000),
      });
    }

    // Sort sessions by stalest first (most likely to trash)
    const sessions = Object.values(sessionMap)
      .sort((a, b) => b.staleDays - a.staleDays)
      .slice(0, limit);

    return NextResponse.json({
      project,
      sessionCount: sessions.length,
      todoCount: todos.length,
      sessions,
    });
  } catch (err: any) {
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}
