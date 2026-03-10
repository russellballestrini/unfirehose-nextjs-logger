import { readdir, readFile, stat, mkdir, appendFile } from 'fs/promises';
import { createReadStream } from 'fs';
import { createInterface } from 'readline';
import { execFile } from 'child_process';
import path from 'path';
import { homedir } from 'os';
import { getDb } from './schema';
import { claudePaths, decodeProjectName } from '../claude-paths';
import { uncloseaiPaths, decodeUncloseaiProjectName } from '../uncloseai-paths';
import { normalizeUncloseaiEntry, normalizeNativeEntry } from '../uncloseai-adapter';
import { fetchPaths, decodeFetchProjectName } from '../fetch-paths';
import { agntPaths, decodeAgntProjectName } from '../agnt-paths';
import { normalizeUnfirehoseEntry } from '../agnt-adapter';
import { sanitizePII } from '../pii';
import { generateSessionName } from '../session-name';
import { uuidv7 } from '../uuidv7';
import { isTriaged } from './triage';
import type { SessionsIndex } from '../types';

const CANONICAL_ROOT = path.join(homedir(), '.unfirehose', 'canonical');

// Poison pill: when an agent emits UNEOF, the orchestrator culls its deployment
export const AGENT_FINISHED_TOKEN = 'UNEOF';

function tmuxSendKeys(target: string, keys: string): void {
  execFile('tmux', ['send-keys', '-t', target, keys, 'Enter'], { timeout: 3000 }, () => {});
}

function tmuxKillWindow(target: string): void {
  // Delay kill to let /exit propagate, then kill the tmux window/session
  setTimeout(() => {
    execFile('tmux', ['kill-window', '-t', target], { timeout: 3000 }, () => {});
  }, 5000);
}

/**
 * Cull deployments for projects where UNEOF was detected during ingestion.
 * Sends /exit to each deployment's tmux window, then kills it.
 */
function cullUneofDeployments(db: ReturnType<typeof getDb>, projectIds: Set<number>) {
  const deployments = db.prepare(`
    SELECT id, tmux_session, tmux_window, project_id
    FROM agent_deployments
    WHERE status = 'running' AND project_id IN (${[...projectIds].map(() => '?').join(',')})
  `).all(...projectIds) as any[];

  for (const d of deployments) {
    const target = d.tmux_window ? `${d.tmux_session}:${d.tmux_window}` : d.tmux_session;
    console.log(`[uneof] Culling deployment ${d.id} — sending /exit to ${target}`);
    tmuxSendKeys(target, '/exit');
    tmuxKillWindow(target);
    db.prepare(
      "UPDATE agent_deployments SET status = 'completed', stopped_at = datetime('now') WHERE id = ?"
    ).run(d.id);
  }
}

/* eslint-disable @typescript-eslint/no-explicit-any */

export interface IngestResult {
  projectsAdded: number;
  sessionsAdded: number;
  messagesAdded: number;
  blocksAdded: number;
  filesScanned: number;
  alertsTriggered: number;
}

/**
 * Normalize a raw harness entry to unfirehose/1.0 canonical format.
 * Works for Claude Code, Fetch, and uncloseai entries.
 */
function toCanonical(entry: any, harness: string): any | null {
  if (!entry.type || !['user', 'assistant', 'system'].includes(entry.type)) return null;

  const canonical: any = {
    $schema: 'unfirehose/1.0',
    role: entry.type,
    id: entry.uuid ?? null,
    parentId: entry.parentUuid ?? null,
    timestamp: entry.timestamp ?? null,
    sidechain: entry.isSidechain ?? false,
    harness,
  };

  if (entry.message?.model) canonical.model = entry.message.model;
  if (entry.message?.stop_reason) canonical.stopReason = entry.message.stop_reason;
  if (entry.subtype) canonical.subtype = entry.subtype;
  if (entry.durationMs) canonical.durationMs = entry.durationMs;
  if (entry.sessionId) canonical.sessionId = entry.sessionId;

  // Normalize content blocks
  if (entry.message?.content && Array.isArray(entry.message.content)) {
    canonical.content = entry.message.content.map((block: any) => {
      switch (block.type) {
        case 'text':
          return { type: 'text', text: block.text };
        case 'thinking':
          return { type: 'reasoning', text: block.thinking, signature: block.thinking_signature };
        case 'tool_use':
          return { type: 'tool-call', toolCallId: block.id, toolName: block.name, input: block.input };
        case 'tool_result':
          return { type: 'tool-result', toolCallId: block.tool_use_id, output: block.content, isError: block.is_error };
        default:
          return block;
      }
    });
  } else if (entry.type === 'user' && typeof entry.message?.content === 'string') {
    canonical.content = [{ type: 'text', text: entry.message.content }];
  }

  // Normalize usage
  const usage = entry.message?.usage;
  if (usage) {
    canonical.usage = {
      inputTokens: usage.input_tokens ?? 0,
      outputTokens: usage.output_tokens ?? 0,
      inputTokenDetails: {
        cacheReadTokens: usage.cache_read_input_tokens ?? 0,
        cacheWriteTokens: usage.cache_creation_input_tokens ?? 0,
      },
    };
  }

  return canonical;
}

function getOrCreateProject(
  db: ReturnType<typeof getDb>,
  name: string,
  displayName: string,
  projectPath?: string
): number {
  const existing = db
    .prepare('SELECT id, path FROM projects WHERE name = ?')
    .get(name) as { id: number; path: string } | undefined;
  if (existing) {
    if (projectPath && (!existing.path || existing.path === '')) {
      db.prepare('UPDATE projects SET path = ? WHERE id = ?').run(projectPath, existing.id);
    }
    return existing.id;
  }

  const result = db
    .prepare(
      'INSERT INTO projects (name, display_name, path) VALUES (?, ?, ?)'
    )
    .run(name, displayName, projectPath ?? '');
  return result.lastInsertRowid as number;
}

function getOrCreateSession(
  db: ReturnType<typeof getDb>,
  sessionUuid: string,
  projectId: number,
  meta: {
    gitBranch?: string;
    firstPrompt?: string;
    cliVersion?: string;
    createdAt?: string;
    isSidechain?: boolean;
    harness?: string;
    delegatedFrom?: string;
  }
): number {
  const existing = db
    .prepare('SELECT id FROM sessions WHERE session_uuid = ?')
    .get(sessionUuid) as { id: number } | undefined;
  if (existing) {
    // Backfill harness/delegated_from if not set
    if (meta.harness || meta.delegatedFrom) {
      db.prepare(
        'UPDATE sessions SET harness = COALESCE(harness, ?), delegated_from = COALESCE(delegated_from, ?) WHERE id = ?'
      ).run(meta.harness ?? null, meta.delegatedFrom ?? null, existing.id);
    }
    return existing.id;
  }

  // Sanitize PII from first prompt before storage
  const firstPrompt = meta.firstPrompt
    ? sanitizePII(meta.firstPrompt).sanitized
    : null;
  const displayName = generateSessionName(firstPrompt, sessionUuid);

  const result = db
    .prepare(
      `INSERT INTO sessions (session_uuid, project_id, git_branch, first_prompt, cli_version, created_at, is_sidechain, display_name, harness, delegated_from)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      sessionUuid,
      projectId,
      meta.gitBranch ?? null,
      firstPrompt,
      meta.cliVersion ?? null,
      meta.createdAt ?? null,
      meta.isSidechain ? 1 : 0,
      displayName,
      meta.harness ?? null,
      meta.delegatedFrom ?? null
    );
  return result.lastInsertRowid as number;
}

function insertMessage(
  db: ReturnType<typeof getDb>,
  sessionId: number,
  entry: any
): number | null {
  const type = entry.type;
  if (!['user', 'assistant', 'system'].includes(type)) return null;

  const usage = entry.message?.usage;

  // Use INSERT OR IGNORE — the unique index on message_uuid handles dedup at DB level.
  // For entries without uuid, we still insert (null uuid doesn't trigger the unique constraint).
  const result = db
    .prepare(
      `INSERT OR IGNORE INTO messages (
        session_id, message_uuid, parent_uuid, type, subtype, timestamp,
        model, input_tokens, output_tokens, cache_read_tokens, cache_creation_tokens,
        duration_ms, is_sidechain
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      sessionId,
      entry.uuid ?? null,
      entry.parentUuid ?? null,
      type,
      entry.subtype ?? null,
      entry.timestamp ?? null,
      entry.message?.model ?? null,
      usage?.input_tokens ?? 0,
      usage?.output_tokens ?? 0,
      usage?.cache_read_input_tokens ?? 0,
      usage?.cache_creation_input_tokens ?? 0,
      entry.durationMs ?? null,
      entry.isSidechain ? 1 : 0
    );

  // changes === 0 means the row was ignored (duplicate uuid)
  if (result.changes === 0) return null;
  return result.lastInsertRowid as number;
}

function insertContentBlocks(
  db: ReturnType<typeof getDb>,
  messageId: number,
  content: any[]
) {
  if (!Array.isArray(content)) return 0;

  const stmt = db.prepare(
    `INSERT INTO content_blocks (message_id, position, block_type, text_content, tool_name, tool_input, tool_use_id, is_error)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  );
  const piiStmt = db.prepare(
    `INSERT INTO pii_replacements (original_hash, token, pii_type, message_id) VALUES (?, ?, ?, ?)`
  );

  let count = 0;
  for (let i = 0; i < content.length; i++) {
    const block = content[i];
    if (!block?.type) continue;

    let textContent: string | null = null;
    let toolName: string | null = null;
    let toolInput: string | null = null;
    let toolUseId: string | null = null;
    let isError = 0;

    switch (block.type) {
      case 'text':
        textContent = block.text ?? null;
        break;
      case 'thinking':
        textContent = block.thinking ?? null;
        break;
      case 'tool_use':
        toolName = block.name ?? null;
        toolInput = block.input ? JSON.stringify(block.input) : null;
        toolUseId = block.id ?? null;
        break;
      case 'tool_result':
        textContent =
          typeof block.content === 'string'
            ? block.content
            : JSON.stringify(block.content);
        toolUseId = block.tool_use_id ?? null;
        isError = block.is_error ? 1 : 0;
        break;
      default:
        textContent = JSON.stringify(block);
        break;
    }

    // Sanitize PII from text content before storage
    if (textContent) {
      const { sanitized, replacements } = sanitizePII(textContent);
      if (replacements.length > 0) {
        textContent = sanitized;
        for (const r of replacements) {
          piiStmt.run(r.originalHash, r.token, r.piiType, messageId);
        }
      }
    }

    stmt.run(messageId, i, block.type, textContent, toolName, toolInput, toolUseId, isError);
    count++;
  }
  return count;
}

function updateUsageMinutes(
  db: ReturnType<typeof getDb>,
  projectId: number,
  timestamp: string,
  usage: {
    inputTokens: number;
    outputTokens: number;
    cacheReadTokens: number;
    cacheCreationTokens: number;
  }
) {
  if (!timestamp) return;
  // Truncate to minute: "2026-03-03T14:30:45.123Z" -> "2026-03-03T14:30"
  const minute = timestamp.slice(0, 16);

  db.prepare(
    `INSERT INTO usage_minutes (minute, project_id, input_tokens, output_tokens, cache_read_tokens, cache_creation_tokens, message_count)
     VALUES (?, ?, ?, ?, ?, ?, 1)
     ON CONFLICT(minute, project_id) DO UPDATE SET
       input_tokens = input_tokens + excluded.input_tokens,
       output_tokens = output_tokens + excluded.output_tokens,
       cache_read_tokens = cache_read_tokens + excluded.cache_read_tokens,
       cache_creation_tokens = cache_creation_tokens + excluded.cache_creation_tokens,
       message_count = message_count + 1`
  ).run(
    minute,
    projectId,
    usage.inputTokens,
    usage.outputTokens,
    usage.cacheReadTokens,
    usage.cacheCreationTokens
  );
}

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

function extractTodosFromEntry(
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

    // Parse tool_result: "Task #N created successfully: <subject>"
    // This assigns external_id to the most recently created todo without one
    if (block.type === 'tool_result' && typeof block.content === 'string') {
      const taskMatch = block.content.match(/^Task #(\d+) created/);
      if (taskMatch) {
        const externalId = taskMatch[1];
        // Find the most recent todo in this session without an external_id
        db.prepare(`
          UPDATE todos SET external_id = ?
          WHERE id = (
            SELECT id FROM todos
            WHERE project_id = ? AND session_id = ? AND external_id IS NULL AND source = 'claude'
            ORDER BY id DESC LIMIT 1
          )
        `).run(externalId, projectId, sessionId);
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

/**
 * Backfill todos from already-ingested content_blocks.
 * Runs once when todos table is empty (i.e., todo extraction was added after initial ingestion).
 */
function backfillTodosFromContentBlocks(db: ReturnType<typeof getDb>) {
  console.log('[backfill] Backfilling todos from content_blocks...');

  // Process TaskCreate tool calls
  const taskCreates = db.prepare(`
    SELECT cb.tool_input, m.session_id, s.project_id, s.session_uuid
    FROM content_blocks cb
    JOIN messages m ON cb.message_id = m.id
    JOIN sessions s ON m.session_id = s.id
    WHERE cb.block_type = 'tool_use' AND cb.tool_name = 'TaskCreate'
    ORDER BY m.timestamp ASC
  `).all() as any[];

  // Group by session to assign sequential external_ids
  const sessionTaskCounters = new Map<number, number>();

  const backfillTx = db.transaction(() => {
    for (const row of taskCreates) {
      try {
        const input = typeof row.tool_input === 'string' ? JSON.parse(row.tool_input) : row.tool_input;
        if (!input) continue;

        const counter = (sessionTaskCounters.get(row.session_id) ?? 0) + 1;
        sessionTaskCounters.set(row.session_id, counter);

        upsertTodo(db, row.project_id, row.session_id, {
          externalId: String(counter),
          content: input.subject ?? input.description ?? '',
          status: 'pending',
          activeForm: input.activeForm,
          source: 'claude',
          sourceSessionUuid: row.session_uuid,
        });
      } catch { /* skip malformed */ }
    }

    // Process TaskUpdate tool calls (must run after TaskCreate)
    const taskUpdates = db.prepare(`
      SELECT cb.tool_input, m.session_id, s.project_id
      FROM content_blocks cb
      JOIN messages m ON cb.message_id = m.id
      JOIN sessions s ON m.session_id = s.id
      WHERE cb.block_type = 'tool_use' AND cb.tool_name = 'TaskUpdate'
      ORDER BY m.timestamp ASC
    `).all() as any[];

    for (const row of taskUpdates) {
      try {
        const input = typeof row.tool_input === 'string' ? JSON.parse(row.tool_input) : row.tool_input;
        if (!input?.taskId || !input?.status) continue;

        const taskId = String(input.taskId);
        const newStatus = input.status === 'deleted' ? 'completed' : input.status;

        const existing = db.prepare(
          'SELECT id, status FROM todos WHERE project_id = ? AND external_id = ? AND source = ?'
        ).get(row.project_id, taskId, 'claude') as { id: number; status: string } | undefined;

        if (existing && existing.status !== newStatus) {
          const now = new Date().toISOString();
          db.prepare(
            `UPDATE todos SET status = ?, updated_at = ?, completed_at = CASE WHEN ? IN ('completed', 'deleted') THEN ? ELSE completed_at END WHERE id = ?`
          ).run(newStatus, now, input.status, now, existing.id);
          db.prepare(
            'INSERT INTO todo_events (todo_id, old_status, new_status, event_at) VALUES (?, ?, ?, ?)'
          ).run(existing.id, existing.status, newStatus, now);
        }
      } catch { /* skip malformed */ }
    }

    // Process TodoWrite tool calls
    const todoWrites = db.prepare(`
      SELECT cb.tool_input, m.session_id, s.project_id, s.session_uuid
      FROM content_blocks cb
      JOIN messages m ON cb.message_id = m.id
      JOIN sessions s ON m.session_id = s.id
      WHERE cb.block_type = 'tool_use' AND cb.tool_name = 'TodoWrite'
      ORDER BY m.timestamp ASC
    `).all() as any[];

    for (const row of todoWrites) {
      try {
        const input = typeof row.tool_input === 'string' ? JSON.parse(row.tool_input) : row.tool_input;
        if (!input?.todos || !Array.isArray(input.todos)) continue;

        for (const todo of input.todos) {
          if (!todo.content) continue;
          upsertTodo(db, row.project_id, row.session_id, {
            content: todo.content,
            status: todo.status ?? 'pending',
            activeForm: todo.activeForm,
            source: 'claude',
            sourceSessionUuid: row.session_uuid,
          });
        }
      } catch { /* skip malformed */ }
    }

    // Process tool results containing task lists (TaskList results)
    const taskListResults = db.prepare(`
      SELECT cb.text_content, m.session_id, s.project_id, s.session_uuid
      FROM content_blocks cb
      JOIN messages m ON cb.message_id = m.id
      JOIN sessions s ON m.session_id = s.id
      WHERE cb.block_type = 'tool_result' AND cb.text_content LIKE '%"subject"%'
      ORDER BY m.timestamp ASC
      LIMIT 10000
    `).all() as any[];

    for (const row of taskListResults) {
      try {
        const resultData = typeof row.text_content === 'string' ? JSON.parse(row.text_content) : row.text_content;
        const tasks = resultData?.tasks ?? (Array.isArray(resultData) ? resultData : null);
        if (!tasks || !Array.isArray(tasks)) continue;

        for (const task of tasks) {
          if (!task.subject && !task.id) continue;
          upsertTodo(db, row.project_id, row.session_id, {
            externalId: task.id ? String(task.id) : undefined,
            content: task.subject ?? '',
            status: task.status ?? 'pending',
            blockedBy: Array.isArray(task.blockedBy) ? task.blockedBy.map(String) : undefined,
            source: 'claude',
            sourceSessionUuid: row.session_uuid,
          });
        }
      } catch { /* not JSON or malformed */ }
    }
  });

  backfillTx();

  const finalCount = (db.prepare('SELECT COUNT(*) as c FROM todos').get() as { c: number }).c;
  console.log(`[backfill] Backfilled ${finalCount} todos from content_blocks`);
}

function checkThresholds(db: ReturnType<typeof getDb>): number {
  const thresholds = db
    .prepare('SELECT * FROM alert_thresholds WHERE enabled = 1')
    .all() as Array<{
    id: number;
    window_minutes: number;
    metric: string;
    threshold_value: number;
  }>;

  let triggered = 0;
  const now = new Date();

  for (const t of thresholds) {
    const windowStart = new Date(now.getTime() - t.window_minutes * 60 * 1000);
    const windowStartStr = windowStart.toISOString().slice(0, 16);

    let actual = 0;
    if (t.metric === 'total_tokens') {
      const row = db
        .prepare(
          `SELECT COALESCE(SUM(input_tokens + output_tokens + cache_read_tokens + cache_creation_tokens), 0) as total
           FROM usage_minutes WHERE minute >= ?`
        )
        .get(windowStartStr) as { total: number };
      actual = row.total;
    } else {
      const col = t.metric; // input_tokens, output_tokens
      const row = db
        .prepare(
          `SELECT COALESCE(SUM(${col}), 0) as total FROM usage_minutes WHERE minute >= ?`
        )
        .get(windowStartStr) as { total: number };
      actual = row.total;
    }

    if (actual > t.threshold_value) {
      // Check if we already alerted in this window (don't spam)
      const recentAlert = db
        .prepare(
          `SELECT id FROM alerts
           WHERE alert_type = 'threshold_breach' AND window_minutes = ? AND metric = ?
           AND triggered_at >= datetime('now', '-' || ? || ' minutes')`
        )
        .get(t.window_minutes, t.metric, t.window_minutes) as
        | { id: number }
        | undefined;

      if (!recentAlert) {
        db.prepare(
          `INSERT INTO alerts (alert_type, window_minutes, metric, threshold_value, actual_value, details)
           VALUES ('threshold_breach', ?, ?, ?, ?, ?)`
        ).run(
          t.window_minutes,
          t.metric,
          t.threshold_value,
          actual,
          JSON.stringify({
            windowStart: windowStartStr,
            ratio: (actual / t.threshold_value).toFixed(2),
          })
        );
        triggered++;
      }
    }
  }

  return triggered;
}

async function ingestFetch(
  db: ReturnType<typeof getDb>
): Promise<Omit<IngestResult, 'alertsTriggered'>> {
  const result = {
    projectsAdded: 0,
    sessionsAdded: 0,
    messagesAdded: 0,
    blocksAdded: 0,
    filesScanned: 0,
  };

  if (!fetchPaths.root) return result;

  const projectDirs = await readdir(fetchPaths.root).catch(() => []);

  for (const slug of projectDirs) {
    const projDir = fetchPaths.projectDir(slug);
    const dirStat = await stat(projDir).catch(() => null);
    if (!dirStat?.isDirectory()) continue;

    const projectName = `fetch:${slug}`;
    const displayName = `[fetch] ${decodeFetchProjectName(slug)}`;

    let files: string[];
    try {
      files = (await readdir(projDir)).filter((f) => f.endsWith('.jsonl'));
    } catch {
      continue;
    }
    if (files.length === 0) continue;

    const projectId = getOrCreateProject(db, projectName, displayName);

    const prevCount = db
      .prepare('SELECT COUNT(*) as c FROM sessions WHERE project_id = ?')
      .get(projectId) as { c: number };
    if (prevCount.c === 0 && files.length > 0) result.projectsAdded++;

    for (const file of files) {
      const sessionUuid = file.replace('.jsonl', '');
      const filePath = fetchPaths.sessionFile(slug, sessionUuid);
      const fstat = await stat(filePath).catch(() => null);
      if (!fstat) continue;

      const offset = db
        .prepare('SELECT byte_offset FROM ingest_offsets WHERE file_path = ?')
        .get(filePath) as { byte_offset: number } | undefined;
      const startByte = offset?.byte_offset ?? 0;

      if (fstat.size <= startByte) continue;

      result.filesScanned++;

      const sessionId = getOrCreateSession(db, sessionUuid, projectId, {
        cliVersion: 'fetch',
        harness: 'fetch',
      });

      if (!offset) result.sessionsAdded++;

      // Fetch JSONL is already in Claude Code format — process directly
      const stream = createReadStream(filePath, {
        start: startByte,
        encoding: 'utf-8',
      });
      const rl = createInterface({ input: stream, crlfDelay: Infinity });

      const batchInsert = db.transaction((lines: string[]) => {
        for (const line of lines) {
          if (!line.trim()) continue;
          try {
            const entry = JSON.parse(line);
            const messageId = insertMessage(db, sessionId, entry);
            if (messageId === null) continue;

            result.messagesAdded++;

            const content =
              entry.message?.content ??
              (entry.type === 'user' && typeof entry.message?.content === 'string'
                ? [{ type: 'text', text: entry.message.content }]
                : []);
            if (Array.isArray(content)) {
              result.blocksAdded += insertContentBlocks(db, messageId, content);
            }

            // Extract todos from TaskCreate/TaskUpdate/TodoWrite tool calls
            extractTodosFromEntry(db, projectId, sessionId, entry, sessionUuid);

            const usage = entry.message?.usage;
            if (usage && entry.timestamp) {
              updateUsageMinutes(db, projectId, entry.timestamp, {
                inputTokens: usage.input_tokens ?? 0,
                outputTokens: usage.output_tokens ?? 0,
                cacheReadTokens: usage.cache_read_input_tokens ?? 0,
                cacheCreationTokens: usage.cache_creation_input_tokens ?? 0,
              });
            }
          } catch {
            // skip malformed lines
          }
        }
      });

      const batch: string[] = [];
      for await (const line of rl) {
        batch.push(line);
        if (batch.length >= 500) {
          batchInsert(batch.splice(0));
        }
      }
      if (batch.length > 0) {
        batchInsert(batch);
      }

      db.prepare(
        `INSERT INTO ingest_offsets (file_path, byte_offset, last_ingested)
         VALUES (?, ?, datetime('now'))
         ON CONFLICT(file_path) DO UPDATE SET
           byte_offset = excluded.byte_offset,
           last_ingested = excluded.last_ingested`
      ).run(filePath, fstat.size);

      db.prepare(
        'UPDATE sessions SET updated_at = ? WHERE session_uuid = ?'
      ).run(new Date().toISOString(), sessionUuid);
    }
  }

  return result;
}

async function ingestUncloseai(
  db: ReturnType<typeof getDb>
): Promise<Omit<IngestResult, 'alertsTriggered'>> {
  const result = {
    projectsAdded: 0,
    sessionsAdded: 0,
    messagesAdded: 0,
    blocksAdded: 0,
    filesScanned: 0,
  };

  const projectDirs = await readdir(uncloseaiPaths.sessions).catch(() => []);

  for (const cwdSlug of projectDirs) {
    const projDir = uncloseaiPaths.projectDir(cwdSlug);
    const dirStat = await stat(projDir).catch(() => null);
    if (!dirStat?.isDirectory()) continue;

    const projectName = `uncloseai:${cwdSlug}`;
    const displayName = `[uncloseai] ${decodeUncloseaiProjectName(cwdSlug)}`;

    let files: string[];
    try {
      files = (await readdir(projDir)).filter((f) => f.endsWith('.jsonl'));
    } catch {
      continue;
    }
    if (files.length === 0) continue;

    const projectId = getOrCreateProject(db, projectName, displayName);

    const prevCount = db
      .prepare('SELECT COUNT(*) as c FROM sessions WHERE project_id = ?')
      .get(projectId) as { c: number };
    if (prevCount.c === 0 && files.length > 0) result.projectsAdded++;

    for (const file of files) {
      const sessionUuid = file.replace('.jsonl', '');
      const filePath = uncloseaiPaths.sessionFile(cwdSlug, sessionUuid);
      const fstat = await stat(filePath).catch(() => null);
      if (!fstat) continue;

      const offset = db
        .prepare('SELECT byte_offset FROM ingest_offsets WHERE file_path = ?')
        .get(filePath) as { byte_offset: number } | undefined;
      const startByte = offset?.byte_offset ?? 0;

      if (fstat.size <= startByte) continue;

      result.filesScanned++;

      const sessionId = getOrCreateSession(db, sessionUuid, projectId, {
        cliVersion: 'uncloseai-cli',
        harness: 'uncloseai',
      });

      if (!offset) result.sessionsAdded++;

      const stream = createReadStream(filePath, {
        start: startByte,
        encoding: 'utf-8',
      });
      const rl = createInterface({ input: stream, crlfDelay: Infinity });

      // Buffer canonical entries for async write after sync transaction
      const canonicalBuffer: any[] = [];

      const batchInsert = db.transaction((lines: string[]) => {
        for (const line of lines) {
          if (!line.trim()) continue;
          try {
            const raw = JSON.parse(line);

            // Native unfirehose/1.0 format (new) vs legacy event format
            const isNative = raw.$schema === 'unfirehose/1.0';
            let normalized: any;

            if (isNative) {
              // Capture metadata from session header
              if (raw.type === 'session') {
                db.prepare(
                  'UPDATE sessions SET first_prompt = COALESCE(first_prompt, ?) WHERE id = ?'
                ).run(raw.firstPrompt ?? null, sessionId);
                if (raw.cwd) {
                  db.prepare(
                    "UPDATE projects SET path = COALESCE(NULLIF(path, ''), ?) WHERE id = ?"
                  ).run(raw.cwd, projectId);
                }
                continue;
              }
              normalized = normalizeNativeEntry(raw);
            } else {
              // Legacy event format — capture metadata from session_start
              if (raw.type === 'session_start') {
                db.prepare(
                  'UPDATE sessions SET first_prompt = COALESCE(first_prompt, ?) WHERE id = ?'
                ).run(raw.prompt ?? null, sessionId);
                if (raw.cwd) {
                  db.prepare(
                    "UPDATE projects SET path = COALESCE(NULLIF(path, ''), ?) WHERE id = ?"
                  ).run(raw.cwd, projectId);
                }
              }
              normalized = normalizeUncloseaiEntry(raw);
            }
            if (!normalized) continue;

            // Generate canonical event only for legacy (non-native) entries
            if (!isNative) {
              const canonical = toCanonical(normalized, 'uncloseai');
              if (canonical) canonicalBuffer.push(canonical);
            }

            const messageId = insertMessage(db, sessionId, normalized);
            if (messageId === null) continue;

            result.messagesAdded++;

            const content = normalized.message?.content ?? [];
            if (Array.isArray(content)) {
              result.blocksAdded += insertContentBlocks(
                db,
                messageId,
                content
              );
            }

            // Extract todos from TaskCreate/TaskUpdate/TodoWrite tool calls
            extractTodosFromEntry(db, projectId, sessionId, normalized, sessionUuid);
          } catch {
            // skip malformed lines
          }
        }
      });

      const batch: string[] = [];
      for await (const line of rl) {
        batch.push(line);
        if (batch.length >= 500) {
          batchInsert(batch.splice(0));
        }
      }
      if (batch.length > 0) {
        batchInsert(batch);
      }

      // Write canonical JSONL for non-compliant harness
      if (canonicalBuffer.length > 0) {
        const canonicalLines = canonicalBuffer.map(e => JSON.stringify(e)).join('\n') + '\n';
        const canonDir = path.join(CANONICAL_ROOT, 'uncloseai', cwdSlug);
        await mkdir(canonDir, { recursive: true });
        await appendFile(path.join(canonDir, `${sessionUuid}.jsonl`), canonicalLines, 'utf-8');
      }

      db.prepare(
        `INSERT INTO ingest_offsets (file_path, byte_offset, last_ingested)
         VALUES (?, ?, datetime('now'))
         ON CONFLICT(file_path) DO UPDATE SET
           byte_offset = excluded.byte_offset,
           last_ingested = excluded.last_ingested`
      ).run(filePath, fstat.size);

      db.prepare(
        'UPDATE sessions SET updated_at = ? WHERE session_uuid = ?'
      ).run(new Date().toISOString(), sessionUuid);
    }
  }

  return result;
}

/**
 * Ingest native unfirehose/1.0 JSONL from agnt.
 * agnt is a Tier 1 adopter — writes unfirehose/1.0 directly.
 * The adapter normalizes unfirehose/1.0 → Claude Code ingest shape.
 */
async function ingestAgnt(
  db: ReturnType<typeof getDb>
): Promise<Omit<IngestResult, 'alertsTriggered'>> {
  const result = {
    projectsAdded: 0,
    sessionsAdded: 0,
    messagesAdded: 0,
    blocksAdded: 0,
    filesScanned: 0,
  };

  if (!agntPaths.root) return result;

  const projectDirs = await readdir(agntPaths.root).catch(() => []);

  for (const slug of projectDirs) {
    const projDir = agntPaths.projectDir(slug);
    const dirStat = await stat(projDir).catch(() => null);
    if (!dirStat?.isDirectory()) continue;

    const projectName = `agnt:${slug}`;
    const displayName = `[agnt] ${decodeAgntProjectName(slug)}`;

    let files: string[];
    try {
      files = (await readdir(projDir)).filter((f) => f.endsWith('.jsonl'));
    } catch {
      continue;
    }
    if (files.length === 0) continue;

    const projectId = getOrCreateProject(db, projectName, displayName);

    const prevCount = db
      .prepare('SELECT COUNT(*) as c FROM sessions WHERE project_id = ?')
      .get(projectId) as { c: number };
    if (prevCount.c === 0 && files.length > 0) result.projectsAdded++;

    for (const file of files) {
      const sessionUuid = file.replace('.jsonl', '');
      const filePath = agntPaths.sessionFile(slug, sessionUuid);
      const fstat = await stat(filePath).catch(() => null);
      if (!fstat) continue;

      const offset = db
        .prepare('SELECT byte_offset FROM ingest_offsets WHERE file_path = ?')
        .get(filePath) as { byte_offset: number } | undefined;
      const startByte = offset?.byte_offset ?? 0;

      if (fstat.size <= startByte) continue;

      result.filesScanned++;

      const sessionId = getOrCreateSession(db, sessionUuid, projectId, {
        cliVersion: 'agnt',
        harness: 'agnt',
      });

      if (!offset) result.sessionsAdded++;

      const stream = createReadStream(filePath, {
        start: startByte,
        encoding: 'utf-8',
      });
      const rl = createInterface({ input: stream, crlfDelay: Infinity });

      const batchInsert = db.transaction((lines: string[]) => {
        for (const line of lines) {
          if (!line.trim()) continue;
          try {
            const raw = JSON.parse(line);
            // Normalize unfirehose/1.0 → Claude Code ingest format
            const entry = normalizeUnfirehoseEntry(raw);
            if (!entry) continue; // Skip session envelopes, training events, etc.

            const messageId = insertMessage(db, sessionId, entry);
            if (messageId === null) continue;

            result.messagesAdded++;

            const content = entry.message?.content ?? [];
            if (Array.isArray(content)) {
              result.blocksAdded += insertContentBlocks(db, messageId, content);
            }

            // Extract todos
            extractTodosFromEntry(db, projectId, sessionId, entry, sessionUuid);

            const usage = entry.message?.usage;
            if (usage && entry.timestamp) {
              updateUsageMinutes(db, projectId, entry.timestamp, {
                inputTokens: usage.input_tokens ?? 0,
                outputTokens: usage.output_tokens ?? 0,
                cacheReadTokens: usage.cache_read_input_tokens ?? 0,
                cacheCreationTokens: usage.cache_creation_input_tokens ?? 0,
              });
            }
          } catch {
            // skip malformed lines
          }
        }
      });

      const batch: string[] = [];
      for await (const line of rl) {
        batch.push(line);
        if (batch.length >= 500) {
          batchInsert(batch.splice(0));
        }
      }
      if (batch.length > 0) {
        batchInsert(batch);
      }

      db.prepare(
        `INSERT INTO ingest_offsets (file_path, byte_offset, last_ingested)
         VALUES (?, ?, datetime('now'))
         ON CONFLICT(file_path) DO UPDATE SET
           byte_offset = excluded.byte_offset,
           last_ingested = excluded.last_ingested`
      ).run(filePath, fstat.size);

      db.prepare(
        'UPDATE sessions SET updated_at = ? WHERE session_uuid = ?'
      ).run(new Date().toISOString(), sessionUuid);
    }
  }

  return result;
}

export async function ingestAll(): Promise<IngestResult> {
  const db = getDb();
  const result: IngestResult = {
    projectsAdded: 0,
    sessionsAdded: 0,
    messagesAdded: 0,
    blocksAdded: 0,
    filesScanned: 0,
    alertsTriggered: 0,
  };

  // Track projects where UNEOF was detected — cull after ingestion completes
  const uneofProjects = new Set<number>();

  const projectDirs = await readdir(claudePaths.projects).catch(() => []);

  for (const dir of projectDirs) {
    const projDir = claudePaths.projectDir(dir);
    const dirStat = await stat(projDir).catch(() => null);
    if (!dirStat?.isDirectory()) continue;

    let projectPath = '';
    let sessionMeta: Array<{
      sessionId: string;
      firstPrompt?: string;
      gitBranch?: string;
      createdAt?: string;
      isSidechain?: boolean;
    }> = [];

    // Read sessions index if available
    try {
      const indexRaw = await readFile(claudePaths.sessionsIndex(dir), 'utf-8');
      const index: SessionsIndex = JSON.parse(indexRaw);
      projectPath = index.originalPath ?? '';
      sessionMeta = index.entries.map((e) => ({
        sessionId: e.sessionId,
        firstPrompt: e.firstPrompt,
        gitBranch: e.gitBranch,
        createdAt: e.created,
        isSidechain: e.isSidechain,
      }));
    } catch {
      // No index — will scan below
    }

    // Also scan for JSONL files not in the sessions index
    try {
      const indexedIds = new Set(sessionMeta.map((m) => m.sessionId));
      const files = await readdir(projDir);
      for (const f of files) {
        if (!f.endsWith('.jsonl')) continue;
        const sid = f.replace('.jsonl', '');
        if (!indexedIds.has(sid)) {
          sessionMeta.push({ sessionId: sid });
        }
      }
    } catch {
      if (sessionMeta.length === 0) continue;
    }

    if (sessionMeta.length === 0) continue;

    const projectId = getOrCreateProject(
      db,
      dir,
      decodeProjectName(dir),
      projectPath
    );

    // Check if project was new
    const prevCount = db
      .prepare('SELECT COUNT(*) as c FROM sessions WHERE project_id = ?')
      .get(projectId) as { c: number };
    if (prevCount.c === 0 && sessionMeta.length > 0) result.projectsAdded++;

    for (const meta of sessionMeta) {
      const filePath = claudePaths.sessionFile(dir, meta.sessionId);
      const fstat = await stat(filePath).catch(() => null);
      if (!fstat) continue;

      // Check ingestion offset
      const offset = db
        .prepare('SELECT byte_offset FROM ingest_offsets WHERE file_path = ?')
        .get(filePath) as { byte_offset: number } | undefined;
      const startByte = offset?.byte_offset ?? 0;

      if (fstat.size <= startByte) continue; // nothing new

      result.filesScanned++;

      const sessionId = getOrCreateSession(db, meta.sessionId, projectId, {
        gitBranch: meta.gitBranch,
        firstPrompt: meta.firstPrompt,
        createdAt: meta.createdAt,
        isSidechain: meta.isSidechain,
        harness: 'claude-code',
      });

      if (!offset) result.sessionsAdded++;

      // Stream new lines from the file
      const stream = createReadStream(filePath, {
        start: startByte,
        encoding: 'utf-8',
      });
      const rl = createInterface({ input: stream, crlfDelay: Infinity });

      // Track delegation info discovered during ingestion
      let detectedDelegatedFrom: string | null = null;
      let detectedUneof = false;

      // Batch insert in a transaction for speed
      const batchInsert = db.transaction(
        (lines: string[]) => {
          for (const line of lines) {
            if (!line.trim()) continue;
            try {
              const entry = JSON.parse(line);

              // Detect delegation: check for UNFIREHOSE_PARENT_SESSION in env or explicit field
              if (!detectedDelegatedFrom) {
                if (entry.delegatedFrom) {
                  detectedDelegatedFrom = entry.delegatedFrom;
                } else if (entry.type === 'user' && entry.message?.content) {
                  // Check if system prompt or first message references parent session
                  const textContent = Array.isArray(entry.message.content)
                    ? entry.message.content.map((b: any) => b.text ?? '').join(' ')
                    : String(entry.message.content);
                  const parentMatch = textContent.match(/UNFIREHOSE_PARENT_SESSION[=: ]+([a-f0-9-]{36})/i);
                  if (parentMatch) {
                    detectedDelegatedFrom = parentMatch[1];
                  }
                }
              }

              // Detect UNEOF poison pill in assistant output
              if (!detectedUneof && entry.type === 'assistant' && entry.message?.content) {
                const blocks = Array.isArray(entry.message.content) ? entry.message.content : [];
                for (const b of blocks) {
                  if (b.type === 'text' && typeof b.text === 'string' && b.text.includes(AGENT_FINISHED_TOKEN)) {
                    detectedUneof = true;
                    break;
                  }
                }
              }

              const messageId = insertMessage(db, sessionId, entry);
              if (messageId === null) continue; // skipped (duplicate or non-message type)

              result.messagesAdded++;

              // Insert content blocks
              const content =
                entry.message?.content ??
                (entry.type === 'user' && typeof entry.message?.content === 'string'
                  ? [{ type: 'text', text: entry.message.content }]
                  : []);
              if (Array.isArray(content)) {
                result.blocksAdded += insertContentBlocks(db, messageId, content);
              }

              // Update usage minutes for assistant messages with token data
              // Skip usage rollups for delegated sessions (parent already counted)
              const usage = entry.message?.usage;
              if (usage && entry.timestamp && !detectedDelegatedFrom) {
                updateUsageMinutes(db, projectId, entry.timestamp, {
                  inputTokens: usage.input_tokens ?? 0,
                  outputTokens: usage.output_tokens ?? 0,
                  cacheReadTokens: usage.cache_read_input_tokens ?? 0,
                  cacheCreationTokens: usage.cache_creation_input_tokens ?? 0,
                });
              }

              // Extract todos from this entry
              extractTodosFromEntry(db, projectId, sessionId, entry, meta.sessionId);
            } catch {
              // skip malformed lines
            }
          }
        }
      );

      const batch: string[] = [];
      for await (const line of rl) {
        batch.push(line);
        if (batch.length >= 500) {
          batchInsert(batch.splice(0));
        }
      }
      if (batch.length > 0) {
        batchInsert(batch);
      }

      // Link delegation if detected during ingestion
      if (detectedDelegatedFrom) {
        db.prepare(
          'UPDATE sessions SET delegated_from = ?, is_sidechain = 1 WHERE session_uuid = ? AND delegated_from IS NULL'
        ).run(detectedDelegatedFrom, meta.sessionId);
      }

      // UNEOF: agent signalled completion — queue cull for this project
      if (detectedUneof) {
        uneofProjects.add(projectId);
      }

      // Update ingestion offset
      db.prepare(
        `INSERT INTO ingest_offsets (file_path, byte_offset, last_ingested)
         VALUES (?, ?, datetime('now'))
         ON CONFLICT(file_path) DO UPDATE SET
           byte_offset = excluded.byte_offset,
           last_ingested = excluded.last_ingested`
      ).run(filePath, fstat.size);

      // Update session modified timestamp
      db.prepare(
        'UPDATE sessions SET updated_at = ? WHERE session_uuid = ?'
      ).run(new Date().toISOString(), meta.sessionId);
    }
  }

  // Ingest uncloseai-cli sessions
  const ucResult = await ingestUncloseai(db);
  result.projectsAdded += ucResult.projectsAdded;
  result.sessionsAdded += ucResult.sessionsAdded;
  result.messagesAdded += ucResult.messagesAdded;
  result.blocksAdded += ucResult.blocksAdded;
  result.filesScanned += ucResult.filesScanned;

  // Ingest Fetch sessions (if FETCH_JSONL_DIR is configured)
  if (fetchPaths.root) {
    const fetchResult = await ingestFetch(db);
    result.projectsAdded += fetchResult.projectsAdded;
    result.sessionsAdded += fetchResult.sessionsAdded;
    result.messagesAdded += fetchResult.messagesAdded;
    result.blocksAdded += fetchResult.blocksAdded;
    result.filesScanned += fetchResult.filesScanned;
  }

  // Ingest agnt sessions (native unfirehose/1.0)
  const agntResult = await ingestAgnt(db);
  result.projectsAdded += agntResult.projectsAdded;
  result.sessionsAdded += agntResult.sessionsAdded;
  result.messagesAdded += agntResult.messagesAdded;
  result.blocksAdded += agntResult.blocksAdded;
  result.filesScanned += agntResult.filesScanned;

  // Backfill display_name for sessions without one OR with preamble names
  const needsName = db.prepare(
    `SELECT id, first_prompt, session_uuid FROM sessions
     WHERE display_name IS NULL
        OR display_name = '(blackops session)'
        OR display_name LIKE 'Agent Blackops%'
        OR display_name LIKE '[Request interrupted%'`
  ).all() as Array<{ id: number; first_prompt: string | null; session_uuid: string }>;
  if (needsName.length > 0) {
    const updateName = db.prepare('UPDATE sessions SET display_name = ? WHERE id = ?');
    // Try to find a real user prompt if first_prompt is a preamble
    const findRealPrompt = db.prepare(`
      SELECT cb.text_content FROM messages m
      JOIN content_blocks cb ON cb.message_id = m.id AND cb.block_type = 'text'
      WHERE m.session_id = ? AND m.type = 'user'
        AND cb.text_content NOT LIKE '%blackops%'
        AND cb.text_content NOT LIKE '%Request interrupted%'
        AND cb.text_content NOT LIKE '%shadow clone%'
        AND LENGTH(cb.text_content) > 15
      ORDER BY m.timestamp
      LIMIT 1
    `);
    const backfill = db.transaction(() => {
      for (const row of needsName) {
        let name = generateSessionName(row.first_prompt, row.session_uuid);
        // If name fell back to UUID, try finding a real prompt from content_blocks
        if (name === row.session_uuid.slice(0, 8)) {
          const real = findRealPrompt.get(row.id) as { text_content: string } | undefined;
          if (real?.text_content) {
            name = generateSessionName(real.text_content, row.session_uuid);
          }
        }
        updateName.run(name, row.id);
      }
    });
    backfill();
  }

  // Backfill todos from existing content_blocks if todos table is empty
  const todoCount = (db.prepare('SELECT COUNT(*) as c FROM todos').get() as { c: number }).c;
  if (todoCount === 0) {
    backfillTodosFromContentBlocks(db);
  }

  // Backfill UUIDv7 for existing todos that don't have one
  const nullUuids = db.prepare('SELECT id, created_at FROM todos WHERE uuid IS NULL').all() as Array<{ id: number; created_at: string }>;
  if (nullUuids.length > 0) {
    const updateUuid = db.prepare('UPDATE todos SET uuid = ? WHERE id = ?');
    const uuidBackfill = db.transaction(() => {
      for (const row of nullUuids) {
        const ts = row.created_at ? new Date(row.created_at).getTime() : Date.now();
        updateUuid.run(uuidv7(ts), row.id);
      }
    });
    uuidBackfill();
    console.log(`[backfill] Assigned UUIDv7 to ${nullUuids.length} todos`);
  }

  // Backfill last_message_at from actual message timestamps
  const nullLastMsg = db.prepare(`
    SELECT s.id FROM sessions s WHERE s.last_message_at IS NULL
    AND EXISTS (SELECT 1 FROM messages m WHERE m.session_id = s.id AND m.timestamp IS NOT NULL)
  `).all() as Array<{ id: number }>;
  if (nullLastMsg.length > 0) {
    const updateLastMsg = db.prepare(`
      UPDATE sessions SET last_message_at = (
        SELECT MAX(m.timestamp) FROM messages m WHERE m.session_id = ?
      ) WHERE id = ?
    `);
    const backfillLastMsg = db.transaction(() => {
      for (const row of nullLastMsg) {
        updateLastMsg.run(row.id, row.id);
      }
    });
    backfillLastMsg();
    console.log(`[backfill] Set last_message_at for ${nullLastMsg.length} sessions`);
  }

  // Heuristic delegation detection: find sessions spawned by Agent tool calls
  // in other sessions (same project, child started within 30s of Agent tool_use)
  const unlinkedSessions = db.prepare(`
    SELECT s.id, s.session_uuid, s.project_id, s.created_at, s.first_prompt
    FROM sessions s
    WHERE s.delegated_from IS NULL
      AND s.harness = 'claude-code'
      AND s.created_at IS NOT NULL
  `).all() as Array<{ id: number; session_uuid: string; project_id: number; created_at: string; first_prompt: string | null }>;

  if (unlinkedSessions.length > 0) {
    const findParentAgent = db.prepare(`
      SELECT s.session_uuid
      FROM content_blocks cb
      JOIN messages m ON cb.message_id = m.id
      JOIN sessions s ON m.session_id = s.id
      WHERE cb.block_type = 'tool_use'
        AND cb.tool_name = 'Agent'
        AND s.project_id = ?
        AND s.session_uuid != ?
        AND m.timestamp BETWEEN datetime(?, '-30 seconds') AND datetime(?, '+30 seconds')
      LIMIT 1
    `);

    const linkDelegation = db.transaction(() => {
      for (const sess of unlinkedSessions) {
        if (!sess.created_at) continue;
        const parent = findParentAgent.get(
          sess.project_id, sess.session_uuid, sess.created_at, sess.created_at
        ) as { session_uuid: string } | undefined;
        if (parent) {
          db.prepare(
            'UPDATE sessions SET delegated_from = ? WHERE id = ? AND delegated_from IS NULL'
          ).run(parent.session_uuid, sess.id);
        }
      }
    });
    linkDelegation();
  }

  // Backfill harness for sessions without one
  db.prepare(`
    UPDATE sessions SET harness = 'claude-code'
    WHERE harness IS NULL
      AND session_uuid IN (SELECT REPLACE(file_path, '.jsonl', '') FROM ingest_offsets WHERE file_path LIKE '%/.claude/projects/%')
  `).run();

  // Check alert thresholds
  result.alertsTriggered = checkThresholds(db);

  // Fire UNEOF cull for any projects where agent signalled completion
  if (uneofProjects.size > 0) {
    cullUneofDeployments(db, uneofProjects);
  }

  return result;
}

export function getRecentAlerts(limit = 20, offset = 0) {
  const db = getDb();
  return db
    .prepare(
      `SELECT * FROM alerts ORDER BY triggered_at DESC LIMIT ? OFFSET ?`
    )
    .all(limit, offset);
}

export function getAlertsCount() {
  const db = getDb();
  return (db.prepare('SELECT COUNT(*) as c FROM alerts').get() as { c: number }).c;
}

export function getUnacknowledgedAlerts() {
  const db = getDb();
  return db
    .prepare(
      `SELECT * FROM alerts WHERE acknowledged = 0 ORDER BY triggered_at DESC`
    )
    .all();
}

export function acknowledgeAlert(id: number) {
  const db = getDb();
  db.prepare('UPDATE alerts SET acknowledged = 1 WHERE id = ?').run(id);
}

export function getUsageTimeline(minutes = 60) {
  const db = getDb();

  // Bucket size: per-minute for <=24h, per-hour for <=14d, per-day for 28d+/lifetime
  // substr(minute, 1, 16) = per-minute (2025-03-03T12:34)
  // substr(minute, 1, 13) = per-hour   (2025-03-03T12)
  // substr(minute, 1, 10) = per-day    (2025-03-03)
  const bucket = minutes <= 1440 ? 16 : minutes <= 20160 ? 13 : 10;

  const query = `SELECT substr(minute, 1, ${bucket}) as minute,
              SUM(input_tokens) as input_tokens,
              SUM(output_tokens) as output_tokens,
              SUM(cache_read_tokens) as cache_read_tokens,
              SUM(cache_creation_tokens) as cache_creation_tokens,
              SUM(message_count) as message_count
       FROM usage_minutes
       ${minutes > 0 ? 'WHERE minute >= ?' : ''}
       GROUP BY substr(minute, 1, ${bucket})
       ORDER BY minute`;

  if (minutes === 0) {
    return db.prepare(query).all();
  }

  const windowStart = new Date(Date.now() - minutes * 60 * 1000)
    .toISOString()
    .slice(0, 16);

  return db.prepare(query).all(windowStart);
}

export function getUsageByProject(minutes = 60) {
  const db = getDb();

  if (minutes === 0) {
    return db
      .prepare(
        `SELECT p.name, p.display_name,
                SUM(um.input_tokens) as input_tokens,
                SUM(um.output_tokens) as output_tokens,
                SUM(um.cache_read_tokens) as cache_read_tokens,
                SUM(um.message_count) as message_count
         FROM usage_minutes um
         JOIN projects p ON p.id = um.project_id
         GROUP BY p.id
         ORDER BY SUM(um.input_tokens + um.output_tokens) DESC`
      )
      .all();
  }

  const windowStart = new Date(Date.now() - minutes * 60 * 1000)
    .toISOString()
    .slice(0, 16);

  return db
    .prepare(
      `SELECT p.name, p.display_name,
              SUM(um.input_tokens) as input_tokens,
              SUM(um.output_tokens) as output_tokens,
              SUM(um.cache_read_tokens) as cache_read_tokens,
              SUM(um.message_count) as message_count
       FROM usage_minutes um
       JOIN projects p ON p.id = um.project_id
       WHERE um.minute >= ?
       GROUP BY p.id
       ORDER BY SUM(um.input_tokens + um.output_tokens) DESC`
    )
    .all(windowStart);
}

export function getDbStats() {
  const db = getDb();
  const projects = db
    .prepare('SELECT COUNT(*) as c FROM projects')
    .get() as { c: number };
  const sessions = db
    .prepare('SELECT COUNT(*) as c FROM sessions')
    .get() as { c: number };
  const messages = db
    .prepare('SELECT COUNT(*) as c FROM messages')
    .get() as { c: number };
  const blocks = db
    .prepare('SELECT COUNT(*) as c FROM content_blocks')
    .get() as { c: number };
  const thinkingBlocks = db
    .prepare("SELECT COUNT(*) as c FROM content_blocks WHERE block_type = 'thinking'")
    .get() as { c: number };
  const totalTokens = db
    .prepare(
      'SELECT COALESCE(SUM(input_tokens + output_tokens + cache_read_tokens + cache_creation_tokens), 0) as total FROM messages'
    )
    .get() as { total: number };
  const alerts = db
    .prepare('SELECT COUNT(*) as c FROM alerts')
    .get() as { c: number };

  return {
    projects: projects.c,
    sessions: sessions.c,
    messages: messages.c,
    contentBlocks: blocks.c,
    thinkingBlocks: thinkingBlocks.c,
    totalTokensStored: totalTokens.total,
    alerts: alerts.c,
  };
}

export function getProjectActivity(days = 30) {
  const db = getDb();
  return db.prepare(`
    SELECT
      p.name,
      p.display_name,
      COUNT(CASE WHEN m.type = 'user' THEN 1 END) as user_messages,
      COUNT(CASE WHEN m.type = 'assistant' THEN 1 END) as assistant_messages,
      COUNT(DISTINCT s.session_uuid) as session_count,
      COUNT(DISTINCT DATE(m.timestamp)) as active_days,
      MAX(m.timestamp) as last_activity,
      SUM(m.input_tokens) as total_input,
      SUM(m.output_tokens) as total_output,
      SUM(m.cache_read_tokens) as total_cache_read,
      SUM(m.cache_creation_tokens) as total_cache_write
    FROM messages m
    JOIN sessions s ON m.session_id = s.id
    JOIN projects p ON s.project_id = p.id
    WHERE m.timestamp > datetime('now', '-' || ? || ' days')
    GROUP BY p.id
    ORDER BY MAX(m.timestamp) DESC
  `).all(days);
}

export function getProjectRecentPrompts(projectName: string, limit = 5) {
  const db = getDb();
  return db.prepare(`
    SELECT
      cb.text_content as prompt,
      m.timestamp,
      s.session_uuid,
      (
        SELECT cb2.text_content
        FROM messages m2
        JOIN content_blocks cb2 ON cb2.message_id = m2.id
        WHERE m2.session_id = m.session_id
          AND m2.type = 'assistant'
          AND m2.id = (
            SELECT MIN(m3.id) FROM messages m3
            WHERE m3.session_id = m.session_id
              AND m3.type = 'assistant'
              AND m3.id > m.id
          )
          AND cb2.block_type = 'text'
          AND cb2.text_content IS NOT NULL
        ORDER BY cb2.position ASC
        LIMIT 1
      ) as response
    FROM content_blocks cb
    JOIN messages m ON cb.message_id = m.id
    JOIN sessions s ON m.session_id = s.id
    JOIN projects p ON s.project_id = p.id
    WHERE p.name = ?
      AND m.type = 'user'
      AND cb.block_type = 'text'
      AND cb.text_content IS NOT NULL
      AND LENGTH(cb.text_content) > 20
      AND cb.text_content NOT LIKE '%[Request interrupted%'
      AND cb.text_content NOT LIKE '%<system%'
      AND cb.text_content NOT LIKE '{"type"%'
      AND cb.text_content NOT LIKE '[Image:%'
      AND cb.text_content NOT LIKE 'Continue from where you left off%'
      AND m.timestamp > datetime('now', '-30 days')
    ORDER BY m.timestamp DESC
    LIMIT ?
  `).all(projectName, limit) as Array<{ prompt: string; timestamp: string; session_uuid: string; response: string | null }>;
}

export function getAlertThresholds() {
  const db = getDb();
  return db.prepare('SELECT * FROM alert_thresholds ORDER BY window_minutes, metric').all();
}

export function updateAlertThreshold(
  id: number,
  value: number,
  enabled: boolean
) {
  const db = getDb();
  db.prepare(
    'UPDATE alert_thresholds SET threshold_value = ?, enabled = ? WHERE id = ?'
  ).run(value, enabled ? 1 : 0, id);
}

// === Alert Detail Queries ===

export function getAlertById(id: number) {
  const db = getDb();
  return db.prepare('SELECT * FROM alerts WHERE id = ?').get(id) as {
    id: number;
    triggered_at: string;
    alert_type: string;
    window_minutes: number;
    metric: string;
    threshold_value: number;
    actual_value: number;
    project_name: string | null;
    details: string | null;
    acknowledged: number;
  } | undefined;
}

export function getUsageByProjectInWindow(windowStart: string, windowEnd: string) {
  const db = getDb();
  return db.prepare(`
    SELECT p.name, p.display_name,
           SUM(um.input_tokens) as input_tokens,
           SUM(um.output_tokens) as output_tokens,
           SUM(um.cache_read_tokens) as cache_read_tokens,
           SUM(um.cache_creation_tokens) as cache_creation_tokens,
           SUM(um.message_count) as message_count
    FROM usage_minutes um
    JOIN projects p ON p.id = um.project_id
    WHERE um.minute >= ? AND um.minute <= ?
    GROUP BY p.id
    ORDER BY SUM(um.input_tokens + um.output_tokens) DESC
  `).all(windowStart, windowEnd) as Array<{
    name: string;
    display_name: string;
    input_tokens: number;
    output_tokens: number;
    cache_read_tokens: number;
    cache_creation_tokens: number;
    message_count: number;
  }>;
}

export function getModelBreakdownInWindow(windowStart: string, windowEnd: string) {
  const db = getDb();
  return db.prepare(`
    SELECT m.model,
           COUNT(*) as message_count,
           SUM(m.input_tokens) as input_tokens,
           SUM(m.output_tokens) as output_tokens,
           SUM(m.cache_read_tokens) as cache_read_tokens,
           SUM(m.cache_creation_tokens) as cache_creation_tokens
    FROM messages m
    WHERE m.timestamp >= ? AND m.timestamp <= ?
      AND m.type = 'assistant'
    GROUP BY m.model
    ORDER BY SUM(m.input_tokens + m.output_tokens) DESC
  `).all(windowStart, windowEnd) as Array<{
    model: string | null;
    message_count: number;
    input_tokens: number;
    output_tokens: number;
    cache_read_tokens: number;
    cache_creation_tokens: number;
  }>;
}

export function getActiveSessionsInWindow(windowStart: string, windowEnd: string) {
  const db = getDb();
  return db.prepare(`
    SELECT s.session_uuid, p.name as project_name, p.display_name,
           s.git_branch, s.first_prompt,
           COUNT(m.id) as message_count,
           SUM(m.input_tokens) as input_tokens,
           SUM(m.output_tokens) as output_tokens
    FROM messages m
    JOIN sessions s ON m.session_id = s.id
    JOIN projects p ON s.project_id = p.id
    WHERE m.timestamp >= ? AND m.timestamp <= ?
    GROUP BY s.id
    ORDER BY SUM(m.input_tokens + m.output_tokens) DESC
  `).all(windowStart, windowEnd) as Array<{
    session_uuid: string;
    project_name: string;
    display_name: string;
    git_branch: string | null;
    first_prompt: string | null;
    message_count: number;
    input_tokens: number;
    output_tokens: number;
  }>;
}

export function getThinkingBlocksInWindow(windowStart: string, windowEnd: string) {
  const db = getDb();
  return db.prepare(`
    SELECT cb.text_content, LENGTH(cb.text_content) as char_count,
           m.id as message_id, m.timestamp, m.model,
           s.session_uuid, p.name as project_name, p.display_name
    FROM content_blocks cb
    JOIN messages m ON cb.message_id = m.id
    JOIN sessions s ON m.session_id = s.id
    JOIN projects p ON s.project_id = p.id
    WHERE cb.block_type = 'thinking'
      AND m.timestamp >= ? AND m.timestamp <= ?
    ORDER BY m.timestamp DESC
  `).all(windowStart, windowEnd) as Array<{
    text_content: string;
    char_count: number;
    message_id: number;
    timestamp: string;
    model: string | null;
    session_uuid: string;
    project_name: string;
    display_name: string;
  }>;
}

export function getTimelineInWindow(windowStart: string, windowEnd: string) {
  const db = getDb();
  return db.prepare(`
    SELECT minute,
           SUM(input_tokens) as input_tokens,
           SUM(output_tokens) as output_tokens,
           SUM(cache_read_tokens) as cache_read_tokens,
           SUM(cache_creation_tokens) as cache_creation_tokens,
           SUM(message_count) as message_count
    FROM usage_minutes
    WHERE minute >= ? AND minute <= ?
    GROUP BY minute
    ORDER BY minute
  `).all(windowStart, windowEnd) as Array<{
    minute: string;
    input_tokens: number;
    output_tokens: number;
    cache_read_tokens: number;
    cache_creation_tokens: number;
    message_count: number;
  }>;
}

// === Settings ===

export function getSetting(key: string): string | null {
  const db = getDb();
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key) as { value: string } | undefined;
  return row?.value ?? null;
}

export function setSetting(key: string, value: string) {
  const db = getDb();
  db.prepare(
    `INSERT INTO settings (key, value, updated_at) VALUES (?, ?, datetime('now'))
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`
  ).run(key, value);
}

export function getAllSettings(): Record<string, string> {
  const db = getDb();
  const rows = db.prepare('SELECT key, value FROM settings').all() as { key: string; value: string }[];
  const result: Record<string, string> = {};
  for (const r of rows) result[r.key] = r.value;
  return result;
}

export function deleteSetting(key: string) {
  const db = getDb();
  db.prepare('DELETE FROM settings WHERE key = ?').run(key);
}

// Plan-based threshold multipliers
const PLAN_THRESHOLDS: Record<string, Record<string, number>> = {
  // Free: conservative, single-agent light usage
  free:    { '1:output_tokens': 50000,  '1:input_tokens': 500000,   '5:output_tokens': 200000,  '5:input_tokens': 2000000,   '5:total_tokens': 2500000,   '15:total_tokens': 5000000,   '60:total_tokens': 15000000  },
  // Starter $14/mo: individual, a few agents
  starter: { '1:output_tokens': 100000, '1:input_tokens': 1000000,  '5:output_tokens': 400000,  '5:input_tokens': 4000000,   '5:total_tokens': 5000000,   '15:total_tokens': 10000000,  '60:total_tokens': 30000000  },
  // Pro $69/mo: power user, multiple concurrent agents
  pro:     { '1:output_tokens': 175000, '1:input_tokens': 1750000,  '5:output_tokens': 700000,  '5:input_tokens': 7000000,   '5:total_tokens': 8750000,   '15:total_tokens': 17500000,  '60:total_tokens': 52500000  },
  // Max $200/mo: heavy multi-agent, 20+ concurrent
  max:     { '1:output_tokens': 250000, '1:input_tokens': 2500000,  '5:output_tokens': 1000000, '5:input_tokens': 10000000,  '5:total_tokens': 12500000,  '15:total_tokens': 25000000,  '60:total_tokens': 75000000  },
  // Ultra $420/mo: maximum capacity, fleet operations
  ultra:   { '1:output_tokens': 500000, '1:input_tokens': 5000000,  '5:output_tokens': 2000000, '5:input_tokens': 20000000,  '5:total_tokens': 25000000,  '15:total_tokens': 50000000,  '60:total_tokens': 150000000 },
};

export function applyPlanThresholds(plan: string) {
  const db = getDb();
  const thresholds = PLAN_THRESHOLDS[plan];
  if (!thresholds) return;

  const update = db.prepare(
    'UPDATE alert_thresholds SET threshold_value = ? WHERE window_minutes = ? AND metric = ?'
  );

  db.transaction(() => {
    for (const [key, value] of Object.entries(thresholds)) {
      const [win, metric] = key.split(':');
      update.run(value, Number(win), metric);
    }
  })();

  setSetting('anthropic_plan', plan);
}

// === Posts (jsonblog.org schema) ===

export function createPost(opts: {
  title: string;
  description?: string;
  source?: string;
  content?: string;
  url?: string;
}): number {
  const db = getDb();
  const uuid = crypto.randomUUID();
  const result = db.prepare(
    `INSERT INTO posts (post_uuid, title, description, source, content, url)
     VALUES (?, ?, ?, ?, ?, ?)`
  ).run(
    uuid,
    opts.title,
    opts.description ?? null,
    opts.source ?? null,
    opts.content ?? null,
    opts.url ?? null,
  );
  return result.lastInsertRowid as number;
}

export function getPosts(limit = 50, offset = 0) {
  const db = getDb();
  return db.prepare(
    'SELECT * FROM posts ORDER BY created_at DESC LIMIT ? OFFSET ?'
  ).all(limit, offset) as PostRow[];
}

export function getPost(id: number) {
  const db = getDb();
  return db.prepare('SELECT * FROM posts WHERE id = ?').get(id) as PostRow | undefined;
}

export function deletePost(id: number) {
  const db = getDb();
  db.prepare('DELETE FROM posts WHERE id = ?').run(id);
}

export interface PostRow {
  id: number;
  post_uuid: string;
  title: string;
  description: string | null;
  source: string | null;
  content: string | null;
  url: string | null;
  created_at: string;
  updated_at: string;
}

export function getUserPromptsInWindow(windowStart: string, windowEnd: string) {
  const db = getDb();
  return db.prepare(`
    SELECT cb.text_content as prompt,
           m.timestamp,
           s.session_uuid,
           p.name as project_name,
           p.display_name
    FROM content_blocks cb
    JOIN messages m ON cb.message_id = m.id
    JOIN sessions s ON m.session_id = s.id
    JOIN projects p ON s.project_id = p.id
    WHERE m.type = 'user'
      AND cb.block_type = 'text'
      AND cb.text_content IS NOT NULL
      AND LENGTH(cb.text_content) > 10
      AND cb.text_content NOT LIKE '%<system%'
      AND cb.text_content NOT LIKE '{"type"%'
      AND m.timestamp >= ? AND m.timestamp <= ?
    ORDER BY m.timestamp DESC
  `).all(windowStart, windowEnd) as Array<{
    prompt: string;
    timestamp: string;
    session_uuid: string;
    project_name: string;
    display_name: string;
  }>;
}

export interface CloudIngestResult {
  accepted: number;
  errors: number;
}

export function ingestJsonlLines(
  db: ReturnType<typeof getDb>,
  lines: string[],
  projectName: string,
  sessionUuid: string
): CloudIngestResult {
  const result: CloudIngestResult = { accepted: 0, errors: 0 };

  const projectId = getOrCreateProject(db, projectName, projectName);
  const sessionId = getOrCreateSession(db, sessionUuid, projectId, {
    harness: 'cloud-ingest',
  });

  const batchInsert = db.transaction((batch: string[]) => {
    for (const line of batch) {
      if (!line.trim()) continue;
      try {
        const entry = JSON.parse(line);
        const messageId = insertMessage(db, sessionId, entry);
        if (messageId === null) {
          result.errors++;
          continue;
        }
        result.accepted++;

        const content =
          entry.message?.content ??
          (entry.type === 'user' && typeof entry.message?.content === 'string'
            ? [{ type: 'text', text: entry.message.content }]
            : []);
        if (Array.isArray(content)) {
          insertContentBlocks(db, messageId, content);
        }

        const usage = entry.message?.usage;
        if (usage && entry.timestamp) {
          updateUsageMinutes(db, projectId, entry.timestamp, {
            inputTokens: usage.input_tokens ?? 0,
            outputTokens: usage.output_tokens ?? 0,
            cacheReadTokens: usage.cache_read_input_tokens ?? 0,
            cacheCreationTokens: usage.cache_creation_input_tokens ?? 0,
          });
        }

        extractTodosFromEntry(db, projectId, sessionId, entry, sessionUuid);
      } catch {
        result.errors++;
      }
    }
  });

  batchInsert(lines);
  return result;
}
