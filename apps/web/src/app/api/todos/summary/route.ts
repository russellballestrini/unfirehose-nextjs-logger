import { NextResponse } from 'next/server';
import { getDb } from '@unfirehose/core/db/schema';

/* eslint-disable @typescript-eslint/no-explicit-any */

/**
 * GET /api/todos/summary
 *
 * Quick aggregate view for agents. One call to understand the full landscape.
 *
 * Returns:
 *   counts          — global pending/in_progress/completed/total
 *   totalMinutes    — sum of estimated_minutes for active todos
 *   unestimated     — count of active todos with no time estimate
 *   needsTicket     — count of active todos > 15m
 *   staleCount      — active todos not updated in 3+ days
 *   byProject       — per-project breakdown { project, display, pending, inProgress, minutes }
 *   bySource        — per-source breakdown { source, pending, inProgress }
 *   oldestPending   — the single oldest pending todo (likely forgotten)
 */
export async function GET() {
  try {
    const db = getDb();

    const counts = db.prepare(`
      SELECT
        COUNT(*) FILTER (WHERE status = 'pending') as pending,
        COUNT(*) FILTER (WHERE status = 'in_progress') as in_progress,
        COUNT(*) FILTER (WHERE status = 'completed') as completed,
        COUNT(*) as total
      FROM todos
    `).get() as any;

    const activeStats = db.prepare(`
      SELECT
        COALESCE(SUM(estimated_minutes), 0) as total_minutes,
        COUNT(*) FILTER (WHERE estimated_minutes IS NULL) as unestimated,
        COUNT(*) FILTER (WHERE estimated_minutes > 15) as needs_ticket,
        COUNT(*) FILTER (WHERE updated_at < datetime('now', '-3 days')) as stale
      FROM todos
      WHERE status IN ('pending', 'in_progress')
    `).get() as any;

    const byProject = db.prepare(`
      SELECT
        p.name as project,
        p.display_name as display,
        COUNT(*) FILTER (WHERE t.status = 'pending') as pending,
        COUNT(*) FILTER (WHERE t.status = 'in_progress') as in_progress,
        COALESCE(SUM(CASE WHEN t.status IN ('pending', 'in_progress') THEN t.estimated_minutes ELSE 0 END), 0) as minutes
      FROM todos t
      JOIN projects p ON t.project_id = p.id
      WHERE t.status IN ('pending', 'in_progress')
      GROUP BY p.id
      HAVING pending + in_progress > 0
      ORDER BY pending + in_progress DESC
    `).all() as any[];

    const bySource = db.prepare(`
      SELECT
        source,
        COUNT(*) FILTER (WHERE status = 'pending') as pending,
        COUNT(*) FILTER (WHERE status = 'in_progress') as in_progress
      FROM todos
      WHERE status IN ('pending', 'in_progress')
      GROUP BY source
      ORDER BY pending + in_progress DESC
    `).all() as any[];

    const oldestPending = db.prepare(`
      SELECT t.id, t.content, t.source, t.created_at, t.updated_at,
             p.name as project, p.display_name as project_display
      FROM todos t
      JOIN projects p ON t.project_id = p.id
      WHERE t.status = 'pending'
      ORDER BY t.updated_at ASC
      LIMIT 1
    `).get() as any;

    return NextResponse.json({
      counts: {
        pending: counts.pending,
        inProgress: counts.in_progress,
        completed: counts.completed,
        total: counts.total,
      },
      totalMinutes: activeStats.total_minutes,
      unestimated: activeStats.unestimated,
      needsTicket: activeStats.needs_ticket,
      staleCount: activeStats.stale,
      byProject,
      bySource,
      oldestPending: oldestPending ? {
        id: oldestPending.id,
        content: oldestPending.content,
        source: oldestPending.source,
        project: oldestPending.project,
        projectDisplay: oldestPending.project_display,
        createdAt: oldestPending.created_at,
        updatedAt: oldestPending.updated_at,
        staleDays: Math.floor((Date.now() - new Date(oldestPending.updated_at).getTime()) / 86400000),
      } : null,
    });
  } catch (err: any) {
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}
