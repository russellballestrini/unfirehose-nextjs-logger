import Database from 'better-sqlite3';

/**
 * Creates a fresh in-memory SQLite DB with the full schema applied.
 * Mirrors the exact migration from src/lib/db/schema.ts.
 */
export function createTestDb(): Database.Database {
  const db = new Database(':memory:');
  db.pragma('journal_mode = WAL');
  db.pragma('synchronous = NORMAL');
  db.pragma('foreign_keys = ON');

  db.exec(`
    CREATE TABLE IF NOT EXISTS projects (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT UNIQUE NOT NULL,
      display_name TEXT NOT NULL,
      path TEXT,
      first_seen TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS sessions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_uuid TEXT UNIQUE NOT NULL,
      project_id INTEGER NOT NULL REFERENCES projects(id),
      git_branch TEXT,
      first_prompt TEXT,
      cli_version TEXT,
      created_at TEXT,
      updated_at TEXT,
      is_sidechain INTEGER DEFAULT 0,
      display_name TEXT,
      status TEXT DEFAULT 'active',
      closed_at TEXT,
      last_message_at TEXT,
      delegated_from TEXT,
      harness TEXT
    );

    CREATE TABLE IF NOT EXISTS messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id INTEGER NOT NULL REFERENCES sessions(id),
      message_uuid TEXT,
      parent_uuid TEXT,
      type TEXT NOT NULL,
      subtype TEXT,
      timestamp TEXT,
      model TEXT,
      input_tokens INTEGER DEFAULT 0,
      output_tokens INTEGER DEFAULT 0,
      cache_read_tokens INTEGER DEFAULT 0,
      cache_creation_tokens INTEGER DEFAULT 0,
      duration_ms INTEGER,
      is_sidechain INTEGER DEFAULT 0,
      ingested_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS content_blocks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      message_id INTEGER NOT NULL REFERENCES messages(id),
      position INTEGER NOT NULL,
      block_type TEXT NOT NULL,
      text_content TEXT,
      tool_name TEXT,
      tool_input TEXT,
      tool_use_id TEXT,
      is_error INTEGER DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS usage_minutes (
      minute TEXT NOT NULL,
      project_id INTEGER REFERENCES projects(id),
      input_tokens INTEGER DEFAULT 0,
      output_tokens INTEGER DEFAULT 0,
      cache_read_tokens INTEGER DEFAULT 0,
      cache_creation_tokens INTEGER DEFAULT 0,
      message_count INTEGER DEFAULT 0,
      PRIMARY KEY (minute, project_id)
    );

    CREATE TABLE IF NOT EXISTS alerts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      triggered_at TEXT NOT NULL DEFAULT (datetime('now')),
      alert_type TEXT NOT NULL,
      window_minutes INTEGER NOT NULL,
      metric TEXT NOT NULL,
      threshold_value REAL NOT NULL,
      actual_value REAL NOT NULL,
      project_name TEXT,
      details TEXT,
      acknowledged INTEGER DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS ingest_offsets (
      file_path TEXT PRIMARY KEY,
      byte_offset INTEGER NOT NULL DEFAULT 0,
      last_ingested TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS alert_thresholds (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      window_minutes INTEGER NOT NULL,
      metric TEXT NOT NULL,
      threshold_value REAL NOT NULL,
      enabled INTEGER DEFAULT 1,
      UNIQUE(window_minutes, metric)
    );

    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS posts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      post_uuid TEXT UNIQUE NOT NULL,
      post_type TEXT NOT NULL DEFAULT 'status',
      title TEXT,
      content_text TEXT NOT NULL,
      tags TEXT,
      url TEXT,
      in_reply_to TEXT,
      published_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS pii_replacements (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      original_hash TEXT NOT NULL,
      token TEXT NOT NULL,
      pii_type TEXT NOT NULL,
      message_id INTEGER REFERENCES messages(id),
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS todos (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      uuid TEXT,
      project_id INTEGER NOT NULL REFERENCES projects(id),
      session_id INTEGER REFERENCES sessions(id),
      external_id TEXT,
      content TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      active_form TEXT,
      source TEXT NOT NULL DEFAULT 'claude',
      source_session_uuid TEXT,
      blocked_by TEXT,
      estimated_minutes INTEGER,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      completed_at TEXT
    );

    CREATE TABLE IF NOT EXISTS todo_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      todo_id INTEGER NOT NULL REFERENCES todos(id),
      old_status TEXT,
      new_status TEXT NOT NULL,
      message_id INTEGER REFERENCES messages(id),
      event_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS todo_attachments (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      todo_id INTEGER NOT NULL REFERENCES todos(id),
      filename TEXT NOT NULL,
      mime_type TEXT NOT NULL,
      size_bytes INTEGER NOT NULL,
      hash TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_todo_attachments_todo ON todo_attachments(todo_id);
    CREATE INDEX IF NOT EXISTS idx_todo_attachments_hash ON todo_attachments(hash);

    CREATE TABLE IF NOT EXISTS agent_deployments (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      tmux_session TEXT NOT NULL,
      tmux_window TEXT,
      project_id INTEGER NOT NULL REFERENCES projects(id),
      todo_ids TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'running',
      started_at TEXT NOT NULL DEFAULT (datetime('now')),
      stopped_at TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_agent_deployments_status ON agent_deployments(status);

    CREATE TABLE IF NOT EXISTS agent_actions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      project_name TEXT NOT NULL,
      action TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      trigger_type TEXT NOT NULL DEFAULT 'manual',
      request_context TEXT,
      result TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      completed_at TEXT
    );

    CREATE TABLE IF NOT EXISTS mesh_snapshots (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      timestamp TEXT NOT NULL DEFAULT (datetime('now')),
      hostname TEXT NOT NULL,
      cpu_cores INTEGER,
      load_avg_1 REAL,
      load_avg_5 REAL,
      load_avg_15 REAL,
      mem_total_gb REAL,
      mem_used_gb REAL,
      power_watts REAL,
      gpu_power_watts REAL,
      gpu_util REAL,
      gpu_mem_used_mb REAL,
      gpu_mem_total_mb REAL,
      power_source TEXT,
      claude_processes INTEGER DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS training_runs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      run_id TEXT UNIQUE NOT NULL,
      model TEXT NOT NULL,
      config TEXT,
      status TEXT NOT NULL DEFAULT 'running',
      started_at TEXT NOT NULL,
      ended_at TEXT,
      final_loss REAL,
      wall_ms INTEGER,
      source TEXT,
      uuid TEXT,
      deleted_at TEXT,
      source_path TEXT,
      source_host TEXT
    );

    CREATE TABLE IF NOT EXISTS training_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      run_id TEXT NOT NULL REFERENCES training_runs(run_id),
      event_type TEXT NOT NULL,
      step INTEGER NOT NULL,
      loss REAL,
      lr REAL,
      text_content TEXT,
      checkpoint_path TEXT,
      size_bytes INTEGER,
      eval_name TEXT,
      eval_score REAL,
      ts TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS project_visibility (
      project_id INTEGER PRIMARY KEY REFERENCES projects(id),
      visibility TEXT NOT NULL DEFAULT 'private',
      auto_detected TEXT,
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    -- Indexes
    CREATE INDEX IF NOT EXISTS idx_messages_session ON messages(session_id);
    CREATE INDEX IF NOT EXISTS idx_messages_timestamp ON messages(timestamp);
    CREATE INDEX IF NOT EXISTS idx_messages_type ON messages(type);
    CREATE INDEX IF NOT EXISTS idx_messages_model ON messages(model);
    CREATE INDEX IF NOT EXISTS idx_content_blocks_message ON content_blocks(message_id);
    CREATE INDEX IF NOT EXISTS idx_content_blocks_type ON content_blocks(block_type);
    CREATE INDEX IF NOT EXISTS idx_usage_minutes_minute ON usage_minutes(minute);
    CREATE INDEX IF NOT EXISTS idx_alerts_triggered ON alerts(triggered_at);
    CREATE INDEX IF NOT EXISTS idx_sessions_project ON sessions(project_id);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_messages_uuid_unique ON messages(message_uuid) WHERE message_uuid IS NOT NULL;
    CREATE INDEX IF NOT EXISTS idx_posts_published ON posts(published_at);
    CREATE INDEX IF NOT EXISTS idx_posts_type ON posts(post_type);
    CREATE INDEX IF NOT EXISTS idx_pii_message ON pii_replacements(message_id);
    CREATE INDEX IF NOT EXISTS idx_todos_project ON todos(project_id);
    CREATE INDEX IF NOT EXISTS idx_todos_status ON todos(status);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_todos_uuid ON todos(uuid) WHERE uuid IS NOT NULL;
    CREATE INDEX IF NOT EXISTS idx_todo_events_todo ON todo_events(todo_id);
  `);

  // Seed default alert thresholds
  const insert = db.prepare(
    'INSERT INTO alert_thresholds (window_minutes, metric, threshold_value) VALUES (?, ?, ?)'
  );
  const seed = db.transaction(() => {
    insert.run(1, 'output_tokens', 250000);
    insert.run(1, 'input_tokens', 2500000);
    insert.run(5, 'output_tokens', 1000000);
    insert.run(5, 'input_tokens', 10000000);
    insert.run(5, 'total_tokens', 12500000);
    insert.run(15, 'total_tokens', 25000000);
    insert.run(60, 'total_tokens', 75000000);
  });
  seed();

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
