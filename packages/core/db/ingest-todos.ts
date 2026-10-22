// Todo extraction from harness JSONL entries (TodoWrite, TaskCreate,
// TaskUpdate and task-list tool results). Extracted from ingest.ts.
import type { getDb } from './schema';
import { uuidv7 } from '../uuidv7';
import { isTriaged } from './triage';

/* eslint-disable @typescript-eslint/no-explicit-any */

// --- Todo extraction from JSONL entries ---

function upsertTodo(
  db: ReturnType<typeof getDb>,
  projectId: number,
  sessionId: number,
  todo: {
    content: string;
    status: string;
    activeForm?: string;
    externalId?: string;
    source?: string;
    sourceSessionUuid?: string;
    blockedBy?: string[];
  }
) {
  const now = new Date().toISOString();
  const source = todo.source ?? 'claude';

  // Terminal statuses are sticky — ingest can never reopen a closed todo.
  // This prevents re-ingestion from overwriting manual triage decisions.
  const TERMINAL_STATUSES = ['completed', 'obsolete', 'deleted'];

  // Check triage file — if this todo was previously closed, skip re-creation
  const projectRow = db.prepare('SELECT name FROM projects WHERE id = ?').get(projectId) as { name: string } | undefined;
  const projectName = projectRow?.name ?? '';
  if (projectName && isTriaged(projectName, todo.content)) {
    return; // Already triaged in a previous DB lifecycle — don't recreate
  }

  if (todo.externalId) {
    // TaskCreate/TaskUpdate style: key on project + external_id
    const existing = db.prepare(
      'SELECT id, status FROM todos WHERE project_id = ? AND external_id = ? AND source = ?'
    ).get(projectId, todo.externalId, source) as { id: number; status: string } | undefined;

    if (existing) {
      if (existing.status !== todo.status && !TERMINAL_STATUSES.includes(existing.status)) {
        db.prepare(
          'UPDATE todos SET status = ?, active_form = ?, blocked_by = ?, updated_at = ?, completed_at = CASE WHEN ? = \'completed\' THEN ? ELSE completed_at END WHERE id = ?'
        ).run(todo.status, todo.activeForm ?? null, todo.blockedBy ? JSON.stringify(todo.blockedBy) : null, now, todo.status, now, existing.id);
        db.prepare(
          'INSERT INTO todo_events (todo_id, old_status, new_status, event_at) VALUES (?, ?, ?, ?)'
        ).run(existing.id, existing.status, todo.status, now);
      }
    } else {
      const todoUuid = uuidv7();
      const r = db.prepare(
        `INSERT INTO todos (project_id, session_id, external_id, content, status, active_form, source, source_session_uuid, blocked_by, uuid, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(projectId, sessionId, todo.externalId, todo.content, todo.status, todo.activeForm ?? null, source, todo.sourceSessionUuid ?? null, todo.blockedBy ? JSON.stringify(todo.blockedBy) : null, todoUuid, now, now);
      db.prepare(
        'INSERT INTO todo_events (todo_id, old_status, new_status, event_at) VALUES (?, NULL, ?, ?)'
      ).run(r.lastInsertRowid, todo.status, now);
    }
  } else {
    // Legacy TodoWrite style: key on project + session + content
    const existing = db.prepare(
      'SELECT id, status FROM todos WHERE project_id = ? AND session_id = ? AND content = ? AND source = ?'
    ).get(projectId, sessionId, todo.content, source) as { id: number; status: string } | undefined;

    if (existing) {
      if (existing.status !== todo.status && !TERMINAL_STATUSES.includes(existing.status)) {
        db.prepare(
          'UPDATE todos SET status = ?, active_form = ?, updated_at = ?, completed_at = CASE WHEN ? = \'completed\' THEN ? ELSE completed_at END WHERE id = ?'
        ).run(todo.status, todo.activeForm ?? null, now, todo.status, now, existing.id);
        db.prepare(
          'INSERT INTO todo_events (todo_id, old_status, new_status, event_at) VALUES (?, ?, ?, ?)'
        ).run(existing.id, existing.status, todo.status, now);
      }
    } else {
      const todoUuid = uuidv7();
      const r = db.prepare(
        `INSERT INTO todos (project_id, session_id, content, status, active_form, source, source_session_uuid, uuid, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(projectId, sessionId, todo.content, todo.status, todo.activeForm ?? null, source, todo.sourceSessionUuid ?? null, todoUuid, now, now);
      db.prepare(
        'INSERT INTO todo_events (todo_id, old_status, new_status, event_at) VALUES (?, NULL, ?, ?)'
      ).run(r.lastInsertRowid, todo.status, now);
    }
  }
}

function isSessionClosed(
  db: ReturnType<typeof getDb>,
  sessionId: number
): boolean {
  const row = db.prepare('SELECT status FROM sessions WHERE id = ?').get(sessionId) as { status: string | null } | undefined;
  return row?.status === 'closed';
}

export function extractTodosFromEntry(
  db: ReturnType<typeof getDb>,
  projectId: number,
  sessionId: number,
  entry: any,
  sessionUuid: string
) {
  // Skip todo extraction for closed sessions — their todos are already triaged
  if (isSessionClosed(db, sessionId)) return;
  // 1. UserEntry.todos snapshot (legacy TodoWrite format)
  if (entry.todos && Array.isArray(entry.todos)) {
    for (const todo of entry.todos) {
      if (!todo.content) continue;
      upsertTodo(db, projectId, sessionId, {
        content: todo.content,
        status: todo.status ?? 'pending',
        activeForm: todo.activeForm,
        source: 'claude',
        sourceSessionUuid: sessionUuid,
      });
    }
  }

  // 2. Tool calls and results: TaskCreate, TaskUpdate, TodoWrite
  const content = entry.message?.content;
  if (!Array.isArray(content)) return;

  for (const block of content) {
    if (block.type === 'tool_use') {
      if (block.name === 'TaskCreate' && block.input) {
        upsertTodo(db, projectId, sessionId, {
          content: block.input.subject ?? block.input.description ?? '',
          status: 'pending',
          activeForm: block.input.activeForm,
          source: 'claude',
          sourceSessionUuid: sessionUuid,
        });
      }

      if (block.name === 'TaskUpdate' && block.input?.taskId) {
        const taskId = String(block.input.taskId);
        if (block.input.status) {
          const existing = db.prepare(
            'SELECT id, status FROM todos WHERE project_id = ? AND external_id = ? AND source = ?'
          ).get(projectId, taskId, 'claude') as { id: number; status: string } | undefined;
          if (existing && existing.status !== block.input.status) {
            const now = new Date().toISOString();
            const newStatus = block.input.status === 'deleted' ? 'completed' : block.input.status;
            db.prepare(
              `UPDATE todos SET status = ?, updated_at = ?, completed_at = CASE WHEN ? IN ('completed', 'deleted') THEN ? ELSE completed_at END WHERE id = ?`
            ).run(newStatus, now, block.input.status, now, existing.id);
            db.prepare(
              'INSERT INTO todo_events (todo_id, old_status, new_status, event_at) VALUES (?, ?, ?, ?)'
            ).run(existing.id, existing.status, newStatus, now);
          }
        }
      }

      if (block.name === 'TodoWrite' && block.input?.todos) {
        for (const todo of block.input.todos) {
          if (!todo.content) continue;
          upsertTodo(db, projectId, sessionId, {
            content: todo.content,
            status: todo.status ?? 'pending',
            activeForm: todo.activeForm,
            source: 'claude',
            sourceSessionUuid: sessionUuid,
          });
        }
      }
    }

    // Parse tool_result: "Task #N created successfully: <subject>".
    //
    // A TaskCreate call carries no id — the harness assigns one and reports
    // it back here, and every later TaskUpdate names a todo by it. So this
    // is the only place the two are connected, and connecting them to the
    // wrong todo closes the wrong todo later.
    //
    // The result names its subject, so match on that first. It is only
    // ambiguous for two todos with identical text, where either answer is
    // as good.
    if (block.type === 'tool_result' && typeof block.content === 'string') {
      // The subject is optional: some results are just "Task #7 created".
      const taskMatch = block.content.match(/^Task #(\d+) created(?:[^:]*:\s*(.*))?$/);
      if (taskMatch) {
        const externalId = taskMatch[1];
        const subject = (taskMatch[2] ?? '').trim();
        const bySubject = subject
          ? db.prepare(`
              SELECT id FROM todos
              WHERE project_id = ? AND session_id = ? AND external_id IS NULL
                AND source = 'claude' AND content = ?
              ORDER BY id ASC LIMIT 1
            `).get(projectId, sessionId, subject) as { id: number } | undefined
          : undefined;

        if (bySubject) {
          db.prepare('UPDATE todos SET external_id = ? WHERE id = ?').run(externalId, bySubject.id);
        } else {
          // No subject to match on. Results arrive in the order their calls
          // were made, so the oldest unnumbered todo is this one — taking
          // the newest instead numbered a batch of TaskCreates backwards.
          db.prepare(`
            UPDATE todos SET external_id = ?
            WHERE id = (
              SELECT id FROM todos
              WHERE project_id = ? AND session_id = ? AND external_id IS NULL AND source = 'claude'
              ORDER BY id ASC LIMIT 1
            )
          `).run(externalId, projectId, sessionId);
        }
      }
    }
  }

  // 3. Tool results with task lists (toolUseResult.tasks)
  for (const block of content) {
    if (block.type !== 'tool_result') continue;
    try {
      const resultData = typeof block.content === 'string' ? JSON.parse(block.content) : block.content;
      if (resultData?.tasks && Array.isArray(resultData.tasks)) {
        for (const task of resultData.tasks) {
          if (!task.subject && !task.id) continue;
          upsertTodo(db, projectId, sessionId, {
            externalId: task.id ? String(task.id) : undefined,
            content: task.subject ?? '',
            status: task.status ?? 'pending',
            blockedBy: Array.isArray(task.blockedBy) ? task.blockedBy.map(String) : undefined,
            source: 'claude',
            sourceSessionUuid: sessionUuid,
          });
        }
      }
    } catch {
      // not JSON, skip
    }
  }
}
