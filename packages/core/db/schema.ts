import Database from 'better-sqlite3';
import path from 'path';
import { homedir } from 'os';
import { mkdirSync } from 'fs';

const UNFIREHOSE_DIR = path.join(homedir(), '.unfirehose');
const DB_PATH = path.join(UNFIREHOSE_DIR, 'unfirehose.db');

// Exported for other modules that need the base directory
export { UNFIREHOSE_DIR };

let _db: Database.Database | null = null;

export function getDb(): Database.Database {
  if (process.env.MULTI_TENANT === 'true') {
    throw new Error('Use getTenantDb() in multi-tenant mode');
  }
  if (_db) return _db;

  mkdirSync(UNFIREHOSE_DIR, { recursive: true });
  _db = new Database(DB_PATH);
  _db.pragma('journal_mode = WAL');
  _db.pragma('synchronous = NORMAL');
  _db.pragma('foreign_keys = ON');

  migrate(_db);
  return _db;
}

export function migrateTenantDb(db: Database.Database) {
  migrate(db);
}

function migrate(db: Database.Database) {
  db.exec(`
    -- Projects: one row per unique project directory
    CREATE TABLE IF NOT EXISTS projects (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT UNIQUE NOT NULL,          -- encoded dir name e.g. -home-fox-git-unsandbox-com
      display_name TEXT NOT NULL,
      path TEXT,                          -- original filesystem path
      first_seen TEXT NOT NULL DEFAULT (datetime('now'))
    );

    -- Sessions: one row per unique session UUID
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
      delegated_from TEXT,
      harness TEXT
    );

    -- Messages: one row per JSONL entry (user/assistant/system)
    -- This is the core training data table
    CREATE TABLE IF NOT EXISTS messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id INTEGER NOT NULL REFERENCES sessions(id),
      message_uuid TEXT,
      parent_uuid TEXT,
      type TEXT NOT NULL,                 -- user, assistant, system
      subtype TEXT,                       -- for system entries (turn_duration, etc.)
      timestamp TEXT,
      model TEXT,
      -- token usage (assistant messages only)
      input_tokens INTEGER DEFAULT 0,
      output_tokens INTEGER DEFAULT 0,
      cache_read_tokens INTEGER DEFAULT 0,
      cache_creation_tokens INTEGER DEFAULT 0,
      -- system message fields
      duration_ms INTEGER,
      is_sidechain INTEGER DEFAULT 0,
      -- ingestion metadata
      ingested_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    -- Content blocks: normalized from message.content arrays
    -- Separating blocks enables querying thinking/tools/text independently
    CREATE TABLE IF NOT EXISTS content_blocks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      message_id INTEGER NOT NULL REFERENCES messages(id),
      position INTEGER NOT NULL,          -- order within the content array
      block_type TEXT NOT NULL,           -- text, thinking, tool_use, tool_result
      text_content TEXT,                  -- text or thinking content
      tool_name TEXT,                     -- for tool_use blocks
      tool_input TEXT,                    -- JSON string of tool input
      tool_use_id TEXT,                   -- tool_use id or tool_result reference
      is_error INTEGER DEFAULT 0          -- for tool_result blocks
    );

    -- Per-minute token usage rollups for spike detection
    -- Pre-computed so threshold checks are instant
    CREATE TABLE IF NOT EXISTS usage_minutes (
      minute TEXT NOT NULL,               -- YYYY-MM-DDTHH:MM
      project_id INTEGER REFERENCES projects(id),
      input_tokens INTEGER DEFAULT 0,
      output_tokens INTEGER DEFAULT 0,
      cache_read_tokens INTEGER DEFAULT 0,
      cache_creation_tokens INTEGER DEFAULT 0,
      message_count INTEGER DEFAULT 0,
      PRIMARY KEY (minute, project_id)
    );

    -- Usage alerts log
    CREATE TABLE IF NOT EXISTS alerts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      triggered_at TEXT NOT NULL DEFAULT (datetime('now')),
      alert_type TEXT NOT NULL,           -- rate_spike, threshold_breach, sustained_high
      window_minutes INTEGER NOT NULL,    -- 1, 5, 15, 60
      metric TEXT NOT NULL,               -- input_tokens, output_tokens, total_tokens, cost_usd
      threshold_value REAL NOT NULL,
      actual_value REAL NOT NULL,
      project_name TEXT,                  -- null = global
      details TEXT,                       -- JSON with extra context
      acknowledged INTEGER DEFAULT 0
    );

    -- Ingestion tracking: byte offsets per file so we never re-read
    CREATE TABLE IF NOT EXISTS ingest_offsets (
      file_path TEXT PRIMARY KEY,
      byte_offset INTEGER NOT NULL DEFAULT 0,
      last_ingested TEXT NOT NULL DEFAULT (datetime('now'))
    );

    -- Alert thresholds configuration
    CREATE TABLE IF NOT EXISTS alert_thresholds (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      window_minutes INTEGER NOT NULL,    -- 1, 5, 15, 60
      metric TEXT NOT NULL,               -- input_tokens, output_tokens, total_tokens
      threshold_value REAL NOT NULL,
      enabled INTEGER DEFAULT 1,
      UNIQUE(window_minutes, metric)
    );

    -- App settings: key-value store for plan, integrations, preferences
    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    -- Blog posts (jsonblog.org schema)
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

    CREATE INDEX IF NOT EXISTS idx_posts_published ON posts(published_at);
    CREATE INDEX IF NOT EXISTS idx_posts_type ON posts(post_type);

    -- PII replacement audit log (stores hashes, never raw PII)
    CREATE TABLE IF NOT EXISTS pii_replacements (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      original_hash TEXT NOT NULL,
      token TEXT NOT NULL,
      pii_type TEXT NOT NULL,
      message_id INTEGER REFERENCES messages(id),
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_pii_message ON pii_replacements(message_id);

    -- Cross-session todo tracking (from TodoWrite, TaskCreate/TaskUpdate, Fetch tasks)
    CREATE TABLE IF NOT EXISTS todos (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      project_id INTEGER NOT NULL REFERENCES projects(id),
      session_id INTEGER REFERENCES sessions(id),
      external_id TEXT,
      content TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      active_form TEXT,
      source TEXT NOT NULL DEFAULT 'claude',
      source_session_uuid TEXT,
      blocked_by TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      completed_at TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_todos_project ON todos(project_id);
    CREATE INDEX IF NOT EXISTS idx_todos_status ON todos(status);

    CREATE TABLE IF NOT EXISTS todo_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      todo_id INTEGER NOT NULL REFERENCES todos(id),
      old_status TEXT,
      new_status TEXT NOT NULL,
      message_id INTEGER REFERENCES messages(id),
      event_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_todo_events_todo ON todo_events(todo_id);

    -- Todo attachments: content-addressed files at ~/.unfirehose/attachments/{hash}
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

    -- Agent deployments: tracks tmux sessions spawned by mega deploy
    CREATE TABLE IF NOT EXISTS agent_deployments (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      tmux_session TEXT NOT NULL,
      tmux_window TEXT,                    -- window within the session (per-claude instance)
      project_id INTEGER NOT NULL REFERENCES projects(id),
      todo_ids TEXT NOT NULL,              -- JSON array of todo IDs assigned
      status TEXT NOT NULL DEFAULT 'running', -- running, completed, failed, culled
      started_at TEXT NOT NULL DEFAULT (datetime('now')),
      stopped_at TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_agent_deployments_status ON agent_deployments(status);

    -- Agent actions: dispatch commands to projects (status, finish, unblock)
    CREATE TABLE IF NOT EXISTS agent_actions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      project_name TEXT NOT NULL,
      action TEXT NOT NULL,                -- 'status' | 'finish' | 'blockers'
      status TEXT NOT NULL DEFAULT 'pending', -- 'pending' | 'running' | 'done' | 'failed'
      trigger_type TEXT NOT NULL DEFAULT 'manual', -- 'manual' | 'auto'
      request_context TEXT,                -- JSON: git state, prompt context at dispatch time
      result TEXT,                         -- JSON: action output (summary, commit hash, blockers list)
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      completed_at TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_agent_actions_project ON agent_actions(project_name, created_at);
    CREATE INDEX IF NOT EXISTS idx_agent_actions_status ON agent_actions(status);

    -- Project visibility for scrobbling
    CREATE TABLE IF NOT EXISTS project_visibility (
      project_id INTEGER PRIMARY KEY REFERENCES projects(id),
      visibility TEXT NOT NULL DEFAULT 'private',
      auto_detected TEXT,
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    -- Mesh node snapshots for time-series charts (watts, load, ISP cost)
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
    CREATE INDEX IF NOT EXISTS idx_mesh_snapshots_ts ON mesh_snapshots(timestamp);
    CREATE INDEX IF NOT EXISTS idx_mesh_snapshots_host ON mesh_snapshots(hostname, timestamp);

    -- Training runs: one row per training run
    CREATE TABLE IF NOT EXISTS training_runs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      run_id TEXT UNIQUE NOT NULL,
      model TEXT NOT NULL,
      config TEXT,                          -- JSON training config
      status TEXT NOT NULL DEFAULT 'running', -- running, completed, failed
      started_at TEXT NOT NULL,
      ended_at TEXT,
      final_loss REAL,
      wall_ms INTEGER,
      source TEXT                           -- adapter that produced this (http, stdout, jsonl, wandb)
    );
    CREATE INDEX IF NOT EXISTS idx_training_runs_status ON training_runs(status);

    -- Training events: loss, samples, checkpoints, evals
    CREATE TABLE IF NOT EXISTS training_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      run_id TEXT NOT NULL REFERENCES training_runs(run_id),
      event_type TEXT NOT NULL,             -- loss, sample, checkpoint, eval
      step INTEGER NOT NULL,
      loss REAL,
      lr REAL,
      text_content TEXT,                    -- sample text
      checkpoint_path TEXT,
      size_bytes INTEGER,
      eval_name TEXT,
      eval_score REAL,
      ts TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_training_events_run ON training_events(run_id, step);
    CREATE INDEX IF NOT EXISTS idx_training_events_type ON training_events(event_type);

    -- Indexes for fast queries
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

    -- Covering index for token aggregation queries (tokens page, dashboard)
    CREATE INDEX IF NOT EXISTS idx_messages_model_tokens ON messages(model, timestamp)
      WHERE model IS NOT NULL;
    -- Speed up content_blocks lookups by type + message
    CREATE INDEX IF NOT EXISTS idx_content_blocks_type_message ON content_blocks(block_type, message_id);
    -- Speed up harness-based token aggregation (tokens page)
    CREATE INDEX IF NOT EXISTS idx_sessions_id_harness ON sessions(id, harness);
    -- Speed up tool_use queries with tool_name
    CREATE INDEX IF NOT EXISTS idx_content_blocks_tool ON content_blocks(block_type, tool_name, message_id)
      WHERE block_type = 'tool_use';

    -- Covering index for /api/logs: type filter + timestamp sort without temp B-tree
    CREATE INDEX IF NOT EXISTS idx_messages_type_timestamp ON messages(type, timestamp DESC);

    -- Covering index for /api/tokens: token aggregation by session+model
    CREATE INDEX IF NOT EXISTS idx_messages_session_model_tokens ON messages(session_id, model, input_tokens, output_tokens, cache_read_tokens, cache_creation_tokens)
      WHERE model IS NOT NULL;

    -- Speed up content_blocks preview fetch (message_id + block_type filter + position sort)
    CREATE INDEX IF NOT EXISTS idx_content_blocks_msg_type_pos ON content_blocks(message_id, block_type, position);
  `);

  // Schema migrations: add columns to existing tables
  const addColumn = (table: string, col: string, def: string) => {
    try { db.exec(`ALTER TABLE ${table} ADD COLUMN ${col} ${def}`); } catch { /* column already exists */ }
  };
  addColumn('sessions', 'display_name', 'TEXT');
  addColumn('sessions', 'status', "TEXT DEFAULT 'active'");
  addColumn('sessions', 'closed_at', 'TEXT');
  addColumn('sessions', 'last_message_at', 'TEXT');
  addColumn('sessions', 'delegated_from', 'TEXT');  // parent session UUID for cross-harness dedup
  addColumn('sessions', 'harness', 'TEXT');          // originating harness (claude-code, fetch, uncloseai, hermes, agnt)
  addColumn('todos', 'estimated_minutes', 'INTEGER');
  addColumn('todos', 'uuid', 'TEXT');
  addColumn('agent_deployments', 'tmux_window', 'TEXT');
  addColumn('mesh_snapshots', 'gpu_util', 'REAL');
  addColumn('mesh_snapshots', 'gpu_mem_used_mb', 'REAL');
  addColumn('mesh_snapshots', 'gpu_mem_total_mb', 'REAL');
  addColumn('training_runs', 'uuid', 'TEXT');
  addColumn('training_runs', 'deleted_at', 'TEXT');
  addColumn('training_runs', 'source_path', 'TEXT');
  addColumn('training_runs', 'source_host', 'TEXT');

  // Session nicknames — user-defined labels for tmux/unsandbox sessions
  db.exec(`
    CREATE TABLE IF NOT EXISTS session_nicknames (
      session_id   TEXT PRIMARY KEY,
      nickname     TEXT NOT NULL DEFAULT '',
      host         TEXT NOT NULL DEFAULT '',
      service_name TEXT NOT NULL DEFAULT '',
      updated_at   TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);

  // Providence cache — Merkle-keyed answer cache for Reverse RAG & codebase queries.
  //
  // CACHE KEY INPUTS (all hashed together — a difference in any field = cache miss):
  //   document_root    — Merkle root of document content, or git/hg commit hash
  //   question_hash    — SHA-256 of normalized question text
  //   model_id         — canonical model identifier
  //   model_revision   — exact weights revision / HuggingFace commit hash
  //   quantization     — fp16 | bf16 | fp8 | int8 | int4 | q4_k_m etc.
  //   system_prompt_hash — SHA-256 of the system prompt (not stored — voyeur protocol)
  //   seed             — RNG seed if set (null = non-deterministic, excluded from key)
  //
  // METADATA ONLY (stored for research/audit, not part of cache key):
  //   base_uri         — inference endpoint URI
  //   temperature      — sampling temperature
  //   top_p            — nucleus sampling cutoff
  //   top_k            — top-k sampling
  //   repetition_penalty, frequency_penalty, presence_penalty
  //   max_tokens       — output length cap
  //   context_window   — model's context limit
  //   backend          — vllm | llama.cpp | ollama | transformers | tgi
  //   node_id          — mesh node that served the request
  //   inference_ms     — wall-clock inference time
  //
  // POLYGLOT PROOF FIELDS (proxy.unturf.com/pkg/polyglot):
  //   chain_tip, token_root, code_hash, privacy_mode, signature, public_key,
  //   poly_session_id, turn_number
  db.exec(`
    CREATE TABLE IF NOT EXISTS providence_cache (
      id                  INTEGER PRIMARY KEY AUTOINCREMENT,

      -- cache key (computed by caller — see /api/providence/lookup)
      cache_key           TEXT NOT NULL UNIQUE,

      -- tier 1: key inputs (stored for inspection & re-keying)
      document_root       TEXT NOT NULL,
      document_uri        TEXT NOT NULL,
      question_hash       TEXT NOT NULL,
      question_text       TEXT NOT NULL,
      model_id            TEXT NOT NULL DEFAULT '',
      model_revision      TEXT,
      quantization        TEXT,
      system_prompt_hash  TEXT,
      seed                INTEGER,

      -- answer
      answer_text         TEXT NOT NULL,
      merkle_proof        TEXT NOT NULL DEFAULT '[]',

      -- tier 2: metadata (not in key)
      base_uri            TEXT NOT NULL DEFAULT '',
      temperature         REAL,
      top_p               REAL,
      top_k               INTEGER,
      repetition_penalty  REAL,
      frequency_penalty   REAL,
      presence_penalty    REAL,
      max_tokens          INTEGER,
      context_window      INTEGER,
      backend             TEXT,
      node_id             TEXT,
      inference_ms        INTEGER,

      -- source context
      source_type         TEXT NOT NULL DEFAULT 'web',
      git_commit          TEXT,

      -- polyglot proof fields
      chain_tip           TEXT,
      token_root          TEXT,
      code_hash           TEXT,
      privacy_mode        TEXT NOT NULL DEFAULT 'transparent',
      signature           TEXT,
      public_key          TEXT,
      poly_session_id     TEXT,
      turn_number         INTEGER,

      -- bookkeeping
      created_at          INTEGER NOT NULL DEFAULT (unixepoch()),
      hit_count           INTEGER NOT NULL DEFAULT 0,
      last_hit_at         INTEGER
    );
    CREATE INDEX IF NOT EXISTS idx_providence_root     ON providence_cache(document_root);
    CREATE INDEX IF NOT EXISTS idx_providence_uri      ON providence_cache(document_uri);
    CREATE INDEX IF NOT EXISTS idx_providence_key      ON providence_cache(cache_key);
    CREATE INDEX IF NOT EXISTS idx_providence_git      ON providence_cache(git_commit) WHERE git_commit IS NOT NULL;
    CREATE INDEX IF NOT EXISTS idx_providence_model    ON providence_cache(model_id);
    CREATE INDEX IF NOT EXISTS idx_providence_session  ON providence_cache(poly_session_id) WHERE poly_session_id IS NOT NULL;
    CREATE INDEX IF NOT EXISTS idx_providence_backend  ON providence_cache(backend) WHERE backend IS NOT NULL;
    CREATE INDEX IF NOT EXISTS idx_providence_node     ON providence_cache(node_id) WHERE node_id IS NOT NULL;
  `);

  // UUIDv7 unique index — try/catch since it may already exist
  try { db.exec('CREATE UNIQUE INDEX idx_todos_uuid ON todos(uuid) WHERE uuid IS NOT NULL'); } catch { /* exists */ }

  // Seed default alert thresholds if empty
  const count = db.prepare('SELECT COUNT(*) as c FROM alert_thresholds').get() as { c: number };
  if (count.c === 0) {
    const insert = db.prepare(
      'INSERT INTO alert_thresholds (window_minutes, metric, threshold_value) VALUES (?, ?, ?)'
    );
    const defaults = db.transaction(() => {
      // Per-minute thresholds (tuned for Max plan, ~$6-8k/mo equivalent, 20+ agents)
      insert.run(1, 'output_tokens', 250000);        // 250K output/min = truly burning
      insert.run(1, 'input_tokens', 2500000);         // 2.5M input/min = massive context load
      // 5-minute windows
      insert.run(5, 'output_tokens', 1000000);        // 1M output in 5 min
      insert.run(5, 'input_tokens', 10000000);         // 10M input in 5 min
      insert.run(5, 'total_tokens', 12500000);         // 12.5M total in 5 min
      // 15-minute windows
      insert.run(15, 'total_tokens', 25000000);        // 25M total in 15 min
      // Hourly
      insert.run(60, 'total_tokens', 75000000);       // 75M total per hour
    });
    defaults();
  } else {
    // Migration: bump thresholds from v1 defaults (too aggressive for Max plan)
    const v1Bump = db.transaction(() => {
      const bump = (win: number, metric: string, oldVal: number, newVal: number) => {
        db.prepare(
          'UPDATE alert_thresholds SET threshold_value = ? WHERE window_minutes = ? AND metric = ? AND threshold_value = ?'
        ).run(newVal, win, metric, oldVal);
      };
      bump(1, 'output_tokens', 50000, 250000);
      bump(1, 'input_tokens', 500000, 2500000);
      bump(5, 'output_tokens', 200000, 1000000);
      bump(5, 'input_tokens', 2000000, 10000000);
      bump(5, 'total_tokens', 2500000, 12500000);
      bump(15, 'total_tokens', 5000000, 25000000);
      bump(60, 'total_tokens', 15000000, 75000000);
    });
    v1Bump();
  }
}
