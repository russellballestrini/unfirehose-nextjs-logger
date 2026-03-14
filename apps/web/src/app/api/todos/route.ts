import { NextRequest, NextResponse } from 'next/server';
import { getDb } from '@unturf/unfirehose/db/schema';
import { uuidv7 } from '@unturf/unfirehose/uuidv7';
import { recordTriage } from '@unturf/unfirehose/db/triage';
import { execFile } from 'child_process';
import { readFile, stat } from 'fs/promises';
import { claudePaths } from '@unturf/unfirehose/claude-paths';
import type { SessionsIndex } from '@unturf/unfirehose/types';

function execAsync(cmd: string, args: string[], opts: { timeout: number }): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, opts, (err, stdout, stderr) => {
      if (err) reject(Object.assign(err, { stderr }));
      else resolve({ stdout, stderr });
    });
  });
}

/* eslint-disable @typescript-eslint/no-explicit-any */

async function resolveProjectPath(projectName: string): Promise<string> {
  // Try sessions index first
  try {
    const raw = await readFile(claudePaths.sessionsIndex(projectName), 'utf-8');
    const index: SessionsIndex = JSON.parse(raw);
    if (index.originalPath) return index.originalPath;
  } catch { /* no index */ }

  // Fall back to deriving from encoded name
  const parts = projectName.replace(/^-/, '').split('-');
  const gitIdx = parts.lastIndexOf('git');
  if (gitIdx < 0 || gitIdx >= parts.length - 1) return '';
  const prefix = '/' + parts.slice(0, gitIdx + 1).join('/');
  const projectParts = parts.slice(gitIdx + 1);

  const dashJoined = prefix + '/' + projectParts.join('-');
  try { if ((await stat(dashJoined)).isDirectory()) return dashJoined; } catch {}

  // Try replacing dashes with dots for domain-style names (www-makepostsell-com → www.makepostsell.com)
  const tlds = ['com', 'net', 'org', 'io', 'dev', 'ai', 'app'];
  const last = projectParts[projectParts.length - 1];
  if (projectParts.length >= 2 && tlds.includes(last)) {
    // Try all dots: www.makepostsell.com
    const allDots = prefix + '/' + projectParts.join('.');
    try { if ((await stat(allDots)).isDirectory()) return allDots; } catch {}
    // Try only last dash as dot: www-makepostsell.com
    const lastDot = prefix + '/' + projectParts.slice(0, -1).join('-') + '.' + last;
    try { if ((await stat(lastDot)).isDirectory()) return lastDot; } catch {}
  }
  return '';
}

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
    const { id, estimatedMinutes, status, content } = body;
    if (!id) return NextResponse.json({ error: 'id required' }, { status: 400 });

    if (content !== undefined) {
      db.prepare('UPDATE todos SET content = ?, updated_at = datetime(\'now\') WHERE id = ?')
        .run(content, id);
    }
    if (estimatedMinutes !== undefined) {
      db.prepare('UPDATE todos SET estimated_minutes = ?, updated_at = datetime(\'now\') WHERE id = ?')
        .run(estimatedMinutes, id);
    }
    if (status) {
      const completedAt = status === 'completed' ? "datetime('now')" : 'NULL';
      db.prepare(`UPDATE todos SET status = ?, updated_at = datetime('now'), completed_at = ${completedAt} WHERE id = ?`)
        .run(status, id);

      // Record terminal statuses to triage file so they survive DB rebuilds
      if (['completed', 'obsolete', 'deleted'].includes(status)) {
        const row = db.prepare(
          'SELECT t.content, p.name as project_name FROM todos t JOIN projects p ON t.project_id = p.id WHERE t.id = ?'
        ).get(id) as any;
        if (row?.project_name) {
          recordTriage(row.project_name, row.content, status);
        }
      }

      // Auto-cull: when a todo completes, check if its deployment is finished
      if (status === 'completed') {
        try { cullFinishedDeployments(db, id); } catch { /* table may not exist */ }
      }
    }

    return NextResponse.json({ ok: true });
  } catch (err: any) {
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}

export async function DELETE(request: NextRequest) {
  try {
    const db = getDb();
    const body = await request.json();
    const { id, ids } = body;

    const todoIds: number[] = ids ?? (id ? [id] : []);
    if (todoIds.length === 0) return NextResponse.json({ error: 'id or ids required' }, { status: 400 });
    if (todoIds.length > 500) return NextResponse.json({ error: 'max 500 ids per batch' }, { status: 400 });

    const now = new Date().toISOString();
    let deleted = 0;

    const triageEntries: Array<{ project: string; content: string; status: string }> = [];

    const tx = db.transaction(() => {
      for (const tid of todoIds) {
        const old = db.prepare(
          'SELECT t.status, t.content, p.name as project_name FROM todos t JOIN projects p ON t.project_id = p.id WHERE t.id = ?'
        ).get(tid) as any;
        if (!old) continue;

        db.prepare('UPDATE todos SET status = ?, updated_at = ?, completed_at = COALESCE(completed_at, ?) WHERE id = ?')
          .run('deleted', now, now, tid);

        db.prepare('INSERT INTO todo_events (todo_id, old_status, new_status, event_at) VALUES (?, ?, ?, ?)')
          .run(tid, old.status, 'deleted', now);

        if (old.project_name) {
          triageEntries.push({ project: old.project_name, content: old.content, status: 'deleted' });
        }
        deleted++;
      }
    });
    tx();

    // Write triage file outside transaction
    if (triageEntries.length > 0) {
      const { recordTriageBatch } = await import('@unturf/unfirehose/db/triage');
      recordTriageBatch(triageEntries);
    }

    return NextResponse.json({ ok: true, deleted });
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
      WHERE t.status != 'deleted'
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

    // Build map of todo_id → deployment info (including all statuses for lifecycle tracking)
    interface DeploymentInfo { tmuxSession: string; tmuxWindow: string | null; status: string; startedAt: string | null; stoppedAt: string | null; }
    const deploymentMap = new Map<number, DeploymentInfo>();
    try {
      const deployments = db.prepare(
        "SELECT tmux_session, tmux_window, todo_ids, status, started_at, stopped_at FROM agent_deployments ORDER BY started_at DESC"
      ).all() as any[];
      for (const d of deployments) {
        const ids: number[] = JSON.parse(d.todo_ids || '[]');
        for (const tid of ids) {
          // Keep the most recent deployment per todo
          if (!deploymentMap.has(tid)) {
            deploymentMap.set(tid, {
              tmuxSession: d.tmux_session,
              tmuxWindow: d.tmux_window,
              status: d.status,
              startedAt: d.started_at,
              stoppedAt: d.stopped_at,
            });
          }
        }
      }
    } catch { /* table may not exist */ }

    // Load all attachments
    const attachments = db.prepare('SELECT * FROM todo_attachments ORDER BY created_at').all() as any[];
    const attachmentsByTodo = new Map<number, any[]>();
    for (const a of attachments) {
      if (!attachmentsByTodo.has(a.todo_id)) attachmentsByTodo.set(a.todo_id, []);
      attachmentsByTodo.get(a.todo_id)!.push({
        id: a.id,
        filename: a.filename,
        mimeType: a.mime_type,
        sizeBytes: a.size_bytes,
        hash: a.hash,
        createdAt: a.created_at,
      });
    }

    // Group by project for overview
    const byProject: Record<string, { project: string; display: string; projectPath: string | null; todos: any[] }> = {};
    for (const todo of todos) {
      if (!byProject[todo.project_name]) {
        byProject[todo.project_name] = {
          project: todo.project_name,
          display: todo.project_display,
          projectPath: todo.project_path || null,
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
        tmuxSession: deploymentMap.get(todo.id)?.tmuxSession ?? null,
        deployment: deploymentMap.get(todo.id) ?? null,
        attachments: attachmentsByTodo.get(todo.id) ?? [],
      });
    }

    // Also get summary counts
    const counts = db.prepare(`
      SELECT
        COUNT(*) FILTER (WHERE status = 'pending') as pending,
        COUNT(*) FILTER (WHERE status = 'in_progress') as in_progress,
        COUNT(*) FILTER (WHERE status = 'completed') as completed,
        COUNT(*) FILTER (WHERE status != 'deleted') as total
      FROM todos
    `).get() as any;

    // Resolve missing project paths from sessions index / filesystem
    const groups = Object.values(byProject);
    await Promise.all(groups.map(async (g) => {
      if (!g.projectPath) {
        g.projectPath = await resolveProjectPath(g.project) || null;
      }
    }));

    return NextResponse.json({
      todos,
      byProject: groups,
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

/**
 * When a todo is marked completed, check running deployments.
 * Two cull strategies:
 *  1. Deployment-specific: all todos in the deployment's todo_ids are done
 *  2. Project-wide: the completed todo's project has zero remaining open todos
 *     → kill ALL deployments for that project
 */
function cullFinishedDeployments(db: ReturnType<typeof getDb>, completedTodoId: number) {
  // Get the project for this todo
  const todo = db.prepare('SELECT project_id FROM todos WHERE id = ?').get(completedTodoId) as any;
  if (!todo) return;

  const deployments = db.prepare(`
    SELECT id, tmux_session, tmux_window, todo_ids, project_id
    FROM agent_deployments
    WHERE status = 'running'
  `).all() as any[];

  if (deployments.length === 0) return;

  // Check if the project has zero remaining open todos
  const projectRemaining = (db.prepare(`
    SELECT COUNT(*) as c FROM todos
    WHERE project_id = ? AND status NOT IN ('completed', 'deleted')
  `).get(todo.project_id) as any).c;

  for (const d of deployments) {
    let shouldCull = false;

    // Strategy 1: deployment-specific — all its tracked todos are done
    const todoIds: number[] = JSON.parse(d.todo_ids);
    if (todoIds.includes(completedTodoId)) {
      const remaining = todoIds.length > 0
        ? (db.prepare(`
            SELECT COUNT(*) as c FROM todos
            WHERE id IN (${todoIds.map(() => '?').join(',')})
              AND status NOT IN ('completed', 'deleted')
          `).get(...todoIds) as any).c
        : 0;
      if (remaining === 0) shouldCull = true;
    }

    // Strategy 2: project-wide — no open todos left for this project
    if (!shouldCull && d.project_id === todo.project_id && projectRemaining === 0) {
      shouldCull = true;
    }

    if (shouldCull) {
      db.prepare(
        "UPDATE agent_deployments SET status = 'completed', stopped_at = datetime('now') WHERE id = ?"
      ).run(d.id);

      // Send /exit to Claude in the specific window, then kill the window
      const target = d.tmux_window ? `${d.tmux_session}:${d.tmux_window}` : d.tmux_session;
      execAsync('tmux', ['send-keys', '-t', target, '/exit', 'Enter'], { timeout: 3000 })
        .catch(() => { /* window may already be gone */ });
      setTimeout(() => {
        execAsync('tmux', ['kill-window', '-t', target], { timeout: 3000 })
          .catch(() => {});
      }, 5000);
    }
  }
}
