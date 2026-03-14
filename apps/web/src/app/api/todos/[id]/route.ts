import { NextRequest } from 'next/server';
import { getDb } from '@unturf/unfirehose/db/schema';

/* eslint-disable @typescript-eslint/no-explicit-any */

export async function GET(_request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const todoId = parseInt(id, 10);
  if (isNaN(todoId)) {
    return Response.json({ error: 'Invalid todo ID' }, { status: 400 });
  }

  const db = getDb();

  const todo = db.prepare(`
    SELECT t.*, p.name as project_name, p.display_name as project_display, p.path as project_path,
           s.session_uuid, s.display_name as session_display, s.git_branch, s.first_prompt
    FROM todos t
    LEFT JOIN projects p ON t.project_id = p.id
    LEFT JOIN sessions s ON t.session_id = s.id
    WHERE t.id = ?
  `).get(todoId) as any;

  if (!todo) {
    return Response.json({ error: 'Todo not found' }, { status: 404 });
  }

  // Attachments
  const attachments = db.prepare('SELECT * FROM todo_attachments WHERE todo_id = ?').all(todoId) as any[];

  // Deployment history
  let deployments: any[] = [];
  try {
    const allDeps = db.prepare(
      "SELECT * FROM agent_deployments ORDER BY started_at DESC"
    ).all() as any[];
    deployments = allDeps.filter((d: any) => {
      const ids: number[] = JSON.parse(d.todo_ids || '[]');
      return ids.includes(todoId);
    }).map((d: any) => ({
      id: d.id,
      tmuxSession: d.tmux_session,
      tmuxWindow: d.tmux_window,
      status: d.status,
      startedAt: d.started_at,
      stoppedAt: d.stopped_at,
    }));
  } catch { /* table may not exist */ }

  // Session token usage if we have a session
  let sessionTokens = null;
  if (todo.session_id) {
    const tokens = db.prepare(`
      SELECT SUM(input_tokens) as input, SUM(output_tokens) as output,
             SUM(cache_read_tokens) as cache_read, SUM(cache_creation_tokens) as cache_write,
             COUNT(*) as message_count
      FROM messages WHERE session_id = ?
    `).get(todo.session_id) as any;
    if (tokens) {
      sessionTokens = {
        input: tokens.input || 0,
        output: tokens.output || 0,
        cacheRead: tokens.cache_read || 0,
        cacheWrite: tokens.cache_write || 0,
        messageCount: tokens.message_count || 0,
      };
    }
  }

  // Recent sessions for this project (useful when todo has no direct session link)
  let recentSessions: any[] = [];
  if (todo.project_id) {
    recentSessions = db.prepare(`
      SELECT s.session_uuid, s.display_name, s.git_branch, s.first_prompt,
             s.created_at, s.last_message_at,
             SUM(m.input_tokens) as input_tokens, SUM(m.output_tokens) as output_tokens,
             COUNT(m.id) as message_count
      FROM sessions s
      LEFT JOIN messages m ON m.session_id = s.id
      WHERE s.project_id = ?
      GROUP BY s.id
      ORDER BY s.last_message_at DESC
      LIMIT 5
    `).all(todo.project_id) as any[];
  }

  // Dependencies (blocked_by)
  let blockedByTodos: any[] = [];
  if (todo.blocked_by) {
    const blockedIds: string[] = JSON.parse(todo.blocked_by);
    if (blockedIds.length > 0) {
      const placeholders = blockedIds.map(() => '?').join(',');
      blockedByTodos = db.prepare(
        `SELECT id, uuid, content, status FROM todos WHERE uuid IN (${placeholders}) OR id IN (${placeholders})`
      ).all(...blockedIds, ...blockedIds) as any[];
    }
  }

  return Response.json({
    id: todo.id,
    uuid: todo.uuid,
    content: todo.content,
    status: todo.status,
    activeForm: todo.active_form,
    source: todo.source,
    externalId: todo.external_id,
    estimatedMinutes: todo.estimated_minutes,
    blockedBy: todo.blocked_by ? JSON.parse(todo.blocked_by) : [],
    blockedByTodos,
    createdAt: todo.created_at,
    updatedAt: todo.updated_at,
    completedAt: todo.completed_at,
    project: {
      name: todo.project_name,
      display: todo.project_display,
      path: todo.project_path,
    },
    session: todo.session_uuid ? {
      uuid: todo.session_uuid,
      display: todo.session_display,
      gitBranch: todo.git_branch,
      firstPrompt: todo.first_prompt,
    } : null,
    sessionTokens,
    recentSessions: recentSessions.map((s: any) => ({
      uuid: s.session_uuid,
      display: s.display_name,
      gitBranch: s.git_branch,
      firstPrompt: s.first_prompt,
      createdAt: s.created_at,
      lastActivity: s.last_message_at,
      inputTokens: s.input_tokens || 0,
      outputTokens: s.output_tokens || 0,
      messageCount: s.message_count || 0,
    })),
    attachments: attachments.map((a: any) => ({
      id: a.id,
      filename: a.filename,
      mimeType: a.mime_type,
      sizeBytes: a.size_bytes,
      hash: a.hash,
      createdAt: a.created_at,
    })),
    deployments,
  });
}
