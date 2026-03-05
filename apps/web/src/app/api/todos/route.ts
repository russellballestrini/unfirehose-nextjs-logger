import { NextRequest, NextResponse } from 'next/server';
import { getDb } from '@sexy-logger/core/db/schema';
import { uuidv7 } from '@sexy-logger/core/uuidv7';

/* eslint-disable @typescript-eslint/no-explicit-any */

export async function POST(request: NextRequest) {
  try {
    const db = getDb();
    const body = await request.json();
    const { content, projectId, projectName, sessionUuid, source, status: initialStatus } = body;

    if (!content?.trim()) {
      return NextResponse.json({ error: 'content required' }, { status: 400 });
    }

    // Resolve project and session from sessionUuid if provided
    let pid = projectId;
    let sid: number | null = null;

    if (!pid && projectName) {
      const proj = db.prepare('SELECT id FROM projects WHERE name = ?').get(projectName) as any;
      if (proj) pid = proj.id;
    }

    if (sessionUuid) {
      const sess = db.prepare(
        'SELECT id, project_id FROM sessions WHERE session_uuid = ?'
      ).get(sessionUuid) as any;
      if (sess) {
        sid = sess.id;
        if (!pid) pid = sess.project_id;
      }
    }

    if (!pid) {
      const first = db.prepare('SELECT id FROM projects ORDER BY id LIMIT 1').get() as any;
      pid = first?.id;
      if (!pid) return NextResponse.json({ error: 'no projects found' }, { status: 400 });
    }

    const todoStatus = initialStatus === 'in_progress' ? 'in_progress' : 'pending';

    const now = new Date().toISOString();
    const todoUuid = uuidv7();
    const result = db.prepare(`
      INSERT INTO todos (project_id, session_id, content, status, source, source_session_uuid, uuid, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(pid, sid, content.trim(), todoStatus, source ?? 'manual', sessionUuid ?? null, todoUuid, now, now);

    db.prepare(
      'INSERT INTO todo_events (todo_id, old_status, new_status, event_at) VALUES (?, NULL, ?, ?)'
    ).run(result.lastInsertRowid, todoStatus, now);

    return NextResponse.json({ ok: true, id: Number(result.lastInsertRowid), uuid: todoUuid });
  } catch (err: any) {
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}

export async function PATCH(request: NextRequest) {
  try {
    const db = getDb();
    const body = await request.json();
    const { id, estimatedMinutes, status } = body;
    if (!id) return NextResponse.json({ error: 'id required' }, { status: 400 });

    if (estimatedMinutes !== undefined) {
      db.prepare('UPDATE todos SET estimated_minutes = ?, updated_at = datetime(\'now\') WHERE id = ?')
        .run(estimatedMinutes, id);
    }
    if (status) {
      const completedAt = status === 'completed' ? "datetime('now')" : 'NULL';
      db.prepare(`UPDATE todos SET status = ?, updated_at = datetime('now'), completed_at = ${completedAt} WHERE id = ?`)
        .run(status, id);
    }

    return NextResponse.json({ ok: true });
  } catch (err: any) {
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}

export async function GET(request: NextRequest) {
  try {
    const db = getDb();
    const url = request.nextUrl;
    const project = url.searchParams.get('project');
    const status = url.searchParams.get('status');
    const source = url.searchParams.get('source');

    let query = `
      SELECT t.*, p.name as project_name, p.display_name as project_display, p.path as project_path,
             s.session_uuid, s.display_name as session_display
      FROM todos t
      JOIN projects p ON t.project_id = p.id
      LEFT JOIN sessions s ON t.session_id = s.id
      WHERE 1=1
    `;
    const params: any[] = [];

    if (project) {
      query += ' AND p.name = ?';
      params.push(project);
    }
    if (status) {
      const statuses = status.split(',');
      query += ` AND t.status IN (${statuses.map(() => '?').join(',')})`;
      params.push(...statuses);
    }
    if (source) {
      query += ' AND t.source = ?';
      params.push(source);
    }

    query += ` ORDER BY
      CASE t.status WHEN 'in_progress' THEN 0 WHEN 'pending' THEN 1 ELSE 2 END,
      t.updated_at DESC
      LIMIT 2000`;

    const todos = db.prepare(query).all(...params) as any[];

    // Group by project for overview
    const byProject: Record<string, { project: string; display: string; projectPath: string | null; todos: any[] }> = {};
    for (const todo of todos) {
      if (!byProject[todo.project_name]) {
        byProject[todo.project_name] = {
          project: todo.project_name,
          display: todo.project_display,
          projectPath: todo.project_path ?? null,
          todos: [],
        };
      }
      byProject[todo.project_name].todos.push({
        id: todo.id,
        uuid: todo.uuid,
        content: todo.content,
        status: todo.status,
        activeForm: todo.active_form,
        source: todo.source,
        externalId: todo.external_id,
        blockedBy: todo.blocked_by ? JSON.parse(todo.blocked_by) : [],
        sessionUuid: todo.session_uuid,
        sessionDisplay: todo.session_display,
        projectName: todo.project_name,
        createdAt: todo.created_at,
        updatedAt: todo.updated_at,
        completedAt: todo.completed_at,
        estimatedMinutes: todo.estimated_minutes,
      });
    }

    // Also get summary counts
    const counts = db.prepare(`
      SELECT
        COUNT(*) FILTER (WHERE status = 'pending') as pending,
        COUNT(*) FILTER (WHERE status = 'in_progress') as in_progress,
        COUNT(*) FILTER (WHERE status = 'completed') as completed,
        COUNT(*) as total
      FROM todos
    `).get() as any;

    return NextResponse.json({
      todos,
      byProject: Object.values(byProject),
      counts: {
        pending: counts?.pending ?? 0,
        inProgress: counts?.in_progress ?? 0,
        completed: counts?.completed ?? 0,
        total: counts?.total ?? 0,
      },
    });
  } catch (err: any) {
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}
