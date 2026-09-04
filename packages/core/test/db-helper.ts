import Database from 'better-sqlite3';
import { applyBasePragmas } from '../db/pragmas';
import { migrate } from '../db/migrate';

/**
 * A fresh in-memory database carrying the real schema.
 *
 * This used to be 326 lines of hand-copied DDL claiming to mirror the
 * migration, plus a restatement of the default alert thresholds. Drift was
 * the only possible outcome: two copies of a schema with no mechanism tying
 * them together diverge on the first migration that lands in only one, and a
 * test running against a stale fixture reads as "the route is broken" when
 * the route is fine.
 *
 * So this calls the migration instead of restating it. A new column reaches
 * the tests the moment it reaches the schema, and this file has nothing left
 * to keep in sync.
 */
export function createTestDb(): Database.Database {
  const db = new Database(':memory:');
  applyBasePragmas(db);
  migrate(db);
  return db;
}

/** Insert a test project and return its id */
export function seedProject(db: Database.Database, name = 'test-project', displayName = 'test-project'): number {
  return db.prepare('INSERT INTO projects (name, display_name, path) VALUES (?, ?, ?)').run(name, displayName, '/test/path').lastInsertRowid as number;
}

/** Insert a test session and return its id */
export function seedSession(db: Database.Database, projectId: number, uuid = 'test-session-uuid'): number {
  return db.prepare("INSERT INTO sessions (session_uuid, project_id, created_at) VALUES (?, ?, datetime('now'))").run(uuid, projectId).lastInsertRowid as number;
}

/** Insert a test message and return its id */
export function seedMessage(
  db: Database.Database,
  sessionId: number,
  opts: {
    type?: string;
    uuid?: string;
    timestamp?: string;
    model?: string;
    inputTokens?: number;
    outputTokens?: number;
    cacheReadTokens?: number;
    cacheCreationTokens?: number;
  } = {}
): number {
  return db.prepare(
    `INSERT INTO messages (session_id, message_uuid, type, timestamp, model, input_tokens, output_tokens, cache_read_tokens, cache_creation_tokens)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    sessionId,
    opts.uuid ?? null,
    opts.type ?? 'assistant',
    opts.timestamp ?? new Date().toISOString(),
    opts.model ?? 'claude-opus-4-6-20260301',
    opts.inputTokens ?? 0,
    opts.outputTokens ?? 0,
    opts.cacheReadTokens ?? 0,
    opts.cacheCreationTokens ?? 0,
  ).lastInsertRowid as number;
}

/** Insert a content block */
export function seedContentBlock(
  db: Database.Database,
  messageId: number,
  opts: {
    position?: number;
    blockType?: string;
    textContent?: string;
    toolName?: string;
    toolInput?: string;
    toolUseId?: string;
    isError?: number;
  } = {}
): number {
  return db.prepare(
    `INSERT INTO content_blocks (message_id, position, block_type, text_content, tool_name, tool_input, tool_use_id, is_error)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    messageId,
    opts.position ?? 0,
    opts.blockType ?? 'text',
    opts.textContent ?? null,
    opts.toolName ?? null,
    opts.toolInput ?? null,
    opts.toolUseId ?? null,
    opts.isError ?? 0,
  ).lastInsertRowid as number;
}

/** Insert a usage_minutes row */
export function seedUsageMinute(
  db: Database.Database,
  projectId: number,
  minute: string,
  opts: { input?: number; output?: number; cacheRead?: number; cacheCreation?: number; count?: number } = {}
) {
  db.prepare(
    `INSERT INTO usage_minutes (minute, project_id, input_tokens, output_tokens, cache_read_tokens, cache_creation_tokens, message_count)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).run(minute, projectId, opts.input ?? 0, opts.output ?? 0, opts.cacheRead ?? 0, opts.cacheCreation ?? 0, opts.count ?? 1);
}

/** Insert a test alert */
export function seedAlert(
  db: Database.Database,
  opts: {
    alertType?: string;
    windowMinutes?: number;
    metric?: string;
    thresholdValue?: number;
    actualValue?: number;
    projectName?: string;
    details?: string;
    acknowledged?: number;
    triggeredAt?: string;
  } = {}
): number {
  return db.prepare(
    `INSERT INTO alerts (alert_type, window_minutes, metric, threshold_value, actual_value, project_name, details, acknowledged, triggered_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, COALESCE(?, datetime('now')))`
  ).run(
    opts.alertType ?? 'threshold_breach',
    opts.windowMinutes ?? 5,
    opts.metric ?? 'output_tokens',
    opts.thresholdValue ?? 200000,
    opts.actualValue ?? 300000,
    opts.projectName ?? null,
    opts.details ?? '{}',
    opts.acknowledged ?? 0,
    opts.triggeredAt ?? null,
  ).lastInsertRowid as number;
}

/** Insert a todo row */
export function seedTodo(
  db: Database.Database,
  projectId: number,
  content: string,
  opts: {
    uuid?: string;
    sessionId?: number;
    externalId?: string;
    status?: string;
    activeForm?: string;
    source?: string;
    sourceSessionUuid?: string;
    blockedBy?: string;
    estimatedMinutes?: number;
    completedAt?: string;
  } = {}
): number {
  return db.prepare(
    `INSERT INTO todos (uuid, project_id, session_id, external_id, content, status, active_form, source, source_session_uuid, blocked_by, estimated_minutes, completed_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    opts.uuid ?? null,
    projectId,
    opts.sessionId ?? null,
    opts.externalId ?? null,
    content,
    opts.status ?? 'pending',
    opts.activeForm ?? null,
    opts.source ?? 'claude',
    opts.sourceSessionUuid ?? null,
    opts.blockedBy ?? null,
    opts.estimatedMinutes ?? null,
    opts.completedAt ?? null,
  ).lastInsertRowid as number;
}
