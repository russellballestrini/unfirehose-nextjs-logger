import Database from 'better-sqlite3';

/**
 * The schema. One definition, applied everywhere a database is created:
 * the live one, a tenant's, and every in-memory database the tests build.
 *
 * It lives outside schema.ts because tests routinely mock that module to
 * hand a route a scratch database — `vi.mock('@unturf/unfirehose/db/schema')`
 * replaces the whole module, taking the migration with it. A fixture cannot
 * both build a database and be the thing stubbed out, so the DDL sits here
 * where nothing has a reason to mock it.
 */
export function migrate(db: Database.Database) {
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
    -- Columns description/source/content/created_at added later via addColumn migration
    -- to match the jsonblog feed (apps/web/src/app/api/blog/blah.json) and the /blog UI.
    CREATE TABLE IF NOT EXISTS posts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      post_uuid TEXT UNIQUE NOT NULL,
      post_type TEXT NOT NULL DEFAULT 'status',
      title TEXT,
      content_text TEXT,
      description TEXT,
      source TEXT,
      content TEXT,
      tags TEXT,
      url TEXT,
      in_reply_to TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      published_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS idx_posts_published ON posts(published_at);
    CREATE INDEX IF NOT EXISTS idx_posts_created ON posts(created_at);
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

    -- Archived tool-results: Claude Code spills large tool outputs to
    -- projects/<p>/<session>/tool-results/<tool_use_id>.txt and keeps only the
    -- path in the transcript. Those files are swept at cleanupPeriodDays (30d
    -- default), so an archived message outlives its own payload. We copy the
    -- bytes into the same content-addressed store as todo_attachments.
    -- rel_path, not tool_use_id, is the identity: a single tool call can spill a
    -- whole directory (multi-page PDF renders land as pdf-<uuid>/page-NN.jpg),
    -- so many rows legitimately share one tool_use_id.
    CREATE TABLE IF NOT EXISTS tool_results (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_uuid TEXT NOT NULL,
      tool_use_id TEXT NOT NULL,
      rel_path TEXT NOT NULL,
      mime_type TEXT NOT NULL,
      size_bytes INTEGER NOT NULL,
      hash TEXT NOT NULL,
      source_path TEXT NOT NULL,
      archived_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(session_uuid, rel_path)
    );
    CREATE INDEX IF NOT EXISTS idx_tool_results_hash ON tool_results(hash);
    CREATE INDEX IF NOT EXISTS idx_tool_results_tool_use ON tool_results(tool_use_id);

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

    -- Cold-tier mesh snapshots: 15-min smoothed aggregates of mesh_snapshots
    -- past the 28-day hot retention boundary. Worker rollup folds 60 × 15s
    -- samples per bucket into one row here using gaussian-weighted smoothing
    -- across [previous 15m, current bucket, next 3 future buckets] for visual
    -- continuity at the rollup boundary. Also stores per-bucket range stats
    -- so charts can paint min/max bands if desired.
    CREATE TABLE IF NOT EXISTS mesh_snapshots_15m (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      timestamp TEXT NOT NULL,             -- 15min bucket start (UTC, aligned to :00/:15/:30/:45)
      hostname TEXT NOT NULL,
      cpu_cores INTEGER,
      load_avg_1 REAL,                     -- smoothed mean
      load_avg_5 REAL,
      load_avg_15 REAL,
      mem_total_gb REAL,
      mem_used_gb REAL,                    -- smoothed mean
      power_watts REAL,                    -- smoothed mean
      gpu_power_watts REAL,
      gpu_util REAL,                       -- smoothed mean
      gpu_mem_used_mb REAL,
      gpu_mem_total_mb REAL,
      power_source TEXT,
      claude_processes INTEGER DEFAULT 0,  -- peak concurrency (MAX of bucket samples)
      sample_count INTEGER NOT NULL,       -- # of 15s rows folded (≤60)
      load_avg_1_max REAL,                 -- per-bucket range stats for optional banding
      power_watts_max REAL,
      gpu_util_max REAL,
      mem_used_gb_max REAL
    );
    CREATE INDEX IF NOT EXISTS idx_mesh_snapshots_15m_host_ts ON mesh_snapshots_15m(hostname, timestamp);
    CREATE INDEX IF NOT EXISTS idx_mesh_snapshots_15m_ts ON mesh_snapshots_15m(timestamp);

    -- Real-user web-vitals (TTFB, FCP, LCP, INP, CLS) reported by VitalsReporter
    -- client component. Used to triangulate server-time vs perceived slowness.
    CREATE TABLE IF NOT EXISTS web_vitals (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ts INTEGER NOT NULL,                  -- Date.now() at insert
      pathname TEXT NOT NULL,               -- window.location.pathname
      metric TEXT NOT NULL,                 -- TTFB | FCP | LCP | INP | CLS
      value REAL NOT NULL,                  -- ms for time-based, unitless for CLS
      rating TEXT NOT NULL,                 -- good | needs-improvement | poor
      session_id TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_web_vitals_path_metric_ts ON web_vitals(pathname, metric, ts);

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
    -- Covering index for /api/tokens dailyByHarness: adds timestamp + excludes synthetic.
    -- Partial-WHERE matches our filter exactly so SQLite can use this for per-session aggregations
    -- without touching the messages heap (and without the synthetic rows polluting the scan).
    CREATE INDEX IF NOT EXISTS idx_messages_session_model_ts ON messages(session_id, model, timestamp, input_tokens, output_tokens, cache_read_tokens, cache_creation_tokens)
      WHERE model IS NOT NULL AND model != '<synthetic>';

    -- Speed up content_blocks preview fetch (message_id + block_type filter + position sort)
    CREATE INDEX IF NOT EXISTS idx_content_blocks_msg_type_pos ON content_blocks(message_id, block_type, position);

    -- Covering index for /api/thinking preceding-prompt lookup: per-session user-message walk
    -- ordered by timestamp. Without this SQLite picks idx_content_blocks_type_message and scans
    -- every text block in the DB per session — ~400ms per session × N sessions per page.
    CREATE INDEX IF NOT EXISTS idx_messages_session_type_ts ON messages(session_id, type, timestamp);
  `);

  // tool_results shipped briefly with UNIQUE(session_uuid, tool_use_id) and a
  // flat `filename`. That constraint rejects every page after the first when a
  // tool spills a directory, so the table is rebuilt onto (session_uuid,
  // rel_path). Rows are carried over; mime_type backfills as octet-stream and
  // corrects itself on the next ingest pass.
  const toolResultCols = db.prepare('PRAGMA table_info(tool_results)').all() as { name: string }[];
  if (toolResultCols.length > 0 && !toolResultCols.some((c) => c.name === 'rel_path')) {
    db.exec(`
      ALTER TABLE tool_results RENAME TO tool_results_legacy;
      CREATE TABLE tool_results (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_uuid TEXT NOT NULL,
        tool_use_id TEXT NOT NULL,
        rel_path TEXT NOT NULL,
        mime_type TEXT NOT NULL,
        size_bytes INTEGER NOT NULL,
        hash TEXT NOT NULL,
        source_path TEXT NOT NULL,
        archived_at TEXT NOT NULL DEFAULT (datetime('now')),
        UNIQUE(session_uuid, rel_path)
      );
      INSERT INTO tool_results
        (session_uuid, tool_use_id, rel_path, mime_type, size_bytes, hash, source_path, archived_at)
        SELECT session_uuid, tool_use_id, filename, 'application/octet-stream',
               size_bytes, hash, source_path, archived_at
        FROM tool_results_legacy;
      DROP TABLE tool_results_legacy;
    `);
  }

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
  // Project identity — survives renames. See docs/architecture/project-identity.md
  addColumn('projects', 'root_commit_hash', 'TEXT');   // git rev-list --max-parents=0 HEAD — stable across renames/clones
  addColumn('projects', 'origin_url', 'TEXT');         // git remote get-url origin — fork tiebreaker
  addColumn('projects', 'remotes_json', 'TEXT');       // JSON array of all remote URLs (for mirror matching)
  addColumn('projects', 'last_cwd_seen', 'TEXT');      // most recent cwd observed during ingest
  addColumn('todos', 'estimated_minutes', 'INTEGER');
  addColumn('todos', 'uuid', 'TEXT');
  // posts: jsonblog feed columns (existing DBs may have only content_text).
  // SQLite forbids non-constant defaults on ALTER ADD COLUMN, so created_at is
  // added without a default and backfilled from published_at below.
  addColumn('posts', 'description', 'TEXT');
  addColumn('posts', 'source', 'TEXT');
  addColumn('posts', 'content', 'TEXT');
  addColumn('posts', 'created_at', 'TEXT');
  db.exec(`UPDATE posts SET created_at = COALESCE(created_at, published_at) WHERE created_at IS NULL;`);
  addColumn('agent_deployments', 'tmux_window', 'TEXT');
  addColumn('mesh_snapshots', 'gpu_util', 'REAL');
  addColumn('mesh_snapshots', 'gpu_mem_used_mb', 'REAL');
  addColumn('mesh_snapshots', 'gpu_mem_total_mb', 'REAL');
  // Agent processes beyond claude. claude_processes stays as it was so older
  // rows and readers keep their meaning; these carry every harness, because a
  // node running five uncloseai-cli agents used to graph as a flat zero.
  //   agent_processes — total across harnesses (what the chart plots)
  //   harness_counts  — JSON {"claude":2,"uncloseai":5} (what the tooltip breaks down)
  addColumn('mesh_snapshots', 'agent_processes', 'INTEGER');
  addColumn('mesh_snapshots', 'harness_counts', 'TEXT');
  addColumn('mesh_snapshots_15m', 'agent_processes', 'INTEGER');
  addColumn('mesh_snapshots_15m', 'harness_counts', 'TEXT');
  addColumn('training_runs', 'uuid', 'TEXT');
  addColumn('training_runs', 'deleted_at', 'TEXT');
  addColumn('training_runs', 'source_path', 'TEXT');
  addColumn('training_runs', 'source_host', 'TEXT');
  // Self-host attribution: endpoint + provider replace model-name regex matching.
  // endpoint = full URL of the inference API the message hit (when harness logs it).
  // provider = "anthropic" | "openai" | "google" | "local" | "openrouter" | "hf-inference" | ...
  addColumn('messages', 'endpoint', 'TEXT');
  addColumn('messages', 'provider', 'TEXT');
  // The invoice, when the gateway states one. Tokens times list price is a
  // MODEL of the bill and it drifts: on 2026-09-02 ours read $13.95 for a day
  // of Gemini against a real OpenRouter bill near $7, because 10.9M of 17.9M
  // prompt tokens were served from cache and billed at a tenth. The response's
  // own cached_tokens said 0 on every one of those calls, so the discount was
  // unreconstructable from token counts alone. NULL means unpriced, never
  // free — an aggregator that quotes its own price is the only source that
  // cannot disagree with it.
  addColumn('messages', 'observed_cost_usd', 'REAL');
  // One-time backfill: harness tells us provider with high confidence even when
  // the message row pre-dates endpoint/provider ingestion.
  //
  // claude-code and arborist always call Anthropic, so that inference holds.
  //
  // uncloseai does NOT imply local. This backfill used to stamp provider='local'
  // on every uncloseai message, which confused "our harness served it" with
  // "our GPU served it" — uncloseai-cli routes to OpenRouter and Nous as well
  // as to our own boxes. `stealth/ox-alpha` is the proof: 4,206 messages all
  // marked local, running the whole time on OpenRouter and Nous Portal. Cost
  // code that trusted the column billed cloud inference as electricity.
  //
  // We now leave it NULL — unknown — and decide self-hosting from model
  // identity and endpoint instead (see pricing.ts `isSelfHosted`). Rows already
  // stamped by earlier runs stay put; nothing downstream trusts the column
  // alone any more.
  db.exec(`
    UPDATE messages
       SET provider = 'anthropic'
     WHERE provider IS NULL
       AND session_id IN (SELECT id FROM sessions WHERE harness IN ('claude-code', 'arborist'));
  `);
  // Index for /api/dashboard's per-endpoint cost grouping.
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_messages_endpoint ON messages(endpoint) WHERE endpoint IS NOT NULL;
    CREATE INDEX IF NOT EXISTS idx_messages_provider ON messages(provider) WHERE provider IS NOT NULL;
  `);

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

  // Project aliases — many encoded JSONL dir names can refer to one project.
  // Renaming ~/git/foo → ~/git/bar produces a new encoded name, which we map to the existing
  // project_id via root_commit_hash + origin_url match. See docs/architecture/project-identity.md.
  db.exec(`
    CREATE TABLE IF NOT EXISTS project_aliases (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      project_id      INTEGER NOT NULL REFERENCES projects(id),
      encoded_name    TEXT NOT NULL UNIQUE,    -- e.g. -home-fox-git-aborist
      cwd             TEXT,                     -- filesystem path at first sight
      harness_prefix  TEXT NOT NULL DEFAULT '', -- '' for base claude, else 'arborist', 'uncloseai', 'fetch', etc.
      first_seen      TEXT NOT NULL DEFAULT (datetime('now')),
      last_seen       TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_project_aliases_project ON project_aliases(project_id);
    CREATE INDEX IF NOT EXISTS idx_projects_root_hash ON projects(root_commit_hash) WHERE root_commit_hash IS NOT NULL;
  `);

  // Providence cache — Merkle-keyed answer cache for Reverse RAG & codebase queries.
  //
  // CACHE KEY INPUTS (all hashed together — a difference in any field = cache miss):
  //   document_root    — Merkle root of document content, or git/hg commit hash
  //   question_hash    — SHA-256 of normalized question text
  //   model_id         — canonical model identifier
  //   model_revision   — exact weights revision / HuggingFace commit hash
  //   quantization     — fp16 | bf16 | fp8 | int8 | int4 | q4_k_m etc.
  //   conversation_hash — SHA-256 of the full normalized OpenAI messages array
  //                       [{role, content}, ...] — all turns including system, prior assistant
  //                       & user messages that led to this answer. Not stored — voyeur protocol.
  //                       A single-turn Q&A and a 6-turn conversation arriving at the same
  //                       final question produce different answers and different cache keys.
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
      conversation_hash   TEXT,
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

  // Model price ledger, synced from public oracles by apps/worker and by
  // `make pricing`. Append-only: a price is never updated in place.
  //
  // One OPEN row (effective_to IS NULL) per (source, model_id) is the current
  // price. When a sync sees a different number it closes that row and opens a
  // new one, so the price in force at any past instant is a range lookup and a
  // June token is billed at June's price. An unchanged price gets last_seen_at
  // bumped — "still true on this date" — which is how a gap in observation
  // stays distinguishable from a price that held. A model that vanishes
  // upstream is stamped delisted_at; its last price stays in force for history.
  //
  // We keep every oracle rather than collapsing to a winner, because the
  // right price depends on where a call actually went: OpenRouter list price
  // for a direct Anthropic call, Nous resale price for traffic routed through
  // Nous Portal — and because several books agreeing is the only check we
  // have that any one of them is right.
  //
  // Prices are stored per MILLION tokens — the unit our cost math uses.
  // Upstream serves $/token or $/M depending on the feed; conversion happens
  // once, at sync.
  db.exec(`
    CREATE TABLE IF NOT EXISTS model_price_ledger (
      id             INTEGER PRIMARY KEY AUTOINCREMENT,
      source         TEXT NOT NULL,           -- openrouter | modelsdev | litellm | llmprices | nous
      model_id       TEXT NOT NULL,           -- upstream id, e.g. anthropic/claude-opus-5
      display_name   TEXT,
      input          REAL NOT NULL DEFAULT 0, -- $ per 1M prompt tokens
      output         REAL NOT NULL DEFAULT 0,
      cache_read     REAL NOT NULL DEFAULT 0,
      cache_write    REAL NOT NULL DEFAULT 0,
      context_len    INTEGER,
      released_on    TEXT,                    -- YYYY-MM-DD when the feed reports it
      effective_from INTEGER NOT NULL,        -- unix s, first observed at this price
      effective_to   INTEGER,                 -- unix s, superseded; NULL = current
      last_seen_at   INTEGER NOT NULL,        -- unix s, newest sync that confirmed it
      delisted_at    INTEGER,                 -- unix s, upstream stopped listing it
      run_id         INTEGER                  -- pricing_sync_runs.id that opened the row
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_price_ledger_open
      ON model_price_ledger(source, model_id) WHERE effective_to IS NULL;
    CREATE INDEX IF NOT EXISTS idx_price_ledger_model
      ON model_price_ledger(model_id, source, effective_from);

    -- The register. One row per sync attempt per source, success or not.
    -- A day with no row is a day the book was not checked.
    CREATE TABLE IF NOT EXISTS pricing_sync_runs (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      source      TEXT NOT NULL,
      trigger     TEXT NOT NULL,              -- worker | make | api | unpriced | bootstrap
      started_at  INTEGER NOT NULL,           -- unix s
      finished_at INTEGER,
      ok          INTEGER NOT NULL DEFAULT 0,
      models      INTEGER NOT NULL DEFAULT 0, -- rows the feed returned
      added       INTEGER NOT NULL DEFAULT 0, -- ids seen for the first time
      changed     INTEGER NOT NULL DEFAULT 0, -- rows closed and reopened at a new price
      unchanged   INTEGER NOT NULL DEFAULT 0,
      delisted    INTEGER NOT NULL DEFAULT 0,
      error       TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_pricing_sync_runs_started ON pricing_sync_runs(started_at);
  `);

  // 4006 created model_pricing as a plain table with one mutable row per
  // (source, model_id). Fold it into the ledger — each row becomes an open
  // ledger row first observed at its fetched_at, which is the only date we
  // have — then replace the table with a view over the ledger's open rows so
  // every existing reader keeps working against one source of truth.
  const priceTable = db
    .prepare("SELECT type FROM sqlite_master WHERE name = 'model_pricing'")
    .get() as { type: string } | undefined;
  if (priceTable?.type === 'table') {
    db.transaction(() => {
      db.exec(`
        INSERT INTO model_price_ledger
          (source, model_id, display_name, input, output, cache_read, cache_write,
           context_len, effective_from, effective_to, last_seen_at)
        SELECT p.source, p.model_id, p.display_name, p.input, p.output, p.cache_read,
               p.cache_write, p.context_len, p.fetched_at, NULL, p.fetched_at
          FROM model_pricing p
         WHERE NOT EXISTS (
           SELECT 1 FROM model_price_ledger l
            WHERE l.source = p.source AND l.model_id = p.model_id AND l.effective_to IS NULL
         );
        DROP TABLE model_pricing;
      `);
    })();
  }
  db.exec(`
    CREATE VIEW IF NOT EXISTS model_pricing AS
      SELECT source, model_id, display_name, input, output, cache_read, cache_write,
             context_len, released_on, effective_from, last_seen_at AS fetched_at,
             delisted_at, id AS ledger_id
        FROM model_price_ledger
       WHERE effective_to IS NULL;
  `);

  // Rate-limit events, extracted from harness output at ingest.
  //
  // Providers throttle us constantly and the evidence only ever existed as
  // prose inside content_blocks — 20,053 blocks mention 429 or rate_limit and
  // none of them were queryable. "How often are we throttled, by whom, when"
  // had no answer, which is the wrong state for a system whose cost strategy
  // is routing work between providers.
  //
  // Keyed on the block so re-ingesting a file cannot double-count an event.
  db.exec(`
    CREATE TABLE IF NOT EXISTS rate_limit_events (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      block_id      INTEGER UNIQUE,        -- content_blocks.id, null for synthetic
      message_id    INTEGER,
      session_id    INTEGER,
      project_id    INTEGER,
      timestamp     TEXT NOT NULL,
      kind          TEXT NOT NULL,         -- rate_limit | concurrency | quota | overloaded
      target        TEXT NOT NULL DEFAULT 'inference', -- inference | web | service
      provider      TEXT,                  -- who throttled us, when known
      upstream      TEXT,                  -- the provider that actually refused; null = harness never said
      operation     TEXT,                  -- vision | chat | embed, when named
      model         TEXT,
      http_status   INTEGER,
      retry_after_s INTEGER,
      rule          TEXT NOT NULL,         -- which detector fired
      detail        TEXT NOT NULL,
      created_at    INTEGER NOT NULL DEFAULT (unixepoch())
    );
    CREATE INDEX IF NOT EXISTS idx_rle_timestamp ON rate_limit_events(timestamp);
    CREATE INDEX IF NOT EXISTS idx_rle_provider  ON rate_limit_events(provider);
    CREATE INDEX IF NOT EXISTS idx_rle_kind      ON rate_limit_events(kind);
    CREATE INDEX IF NOT EXISTS idx_rle_target    ON rate_limit_events(target);
    CREATE INDEX IF NOT EXISTS idx_rle_upstream  ON rate_limit_events(upstream);
    CREATE INDEX IF NOT EXISTS idx_rle_project   ON rate_limit_events(project_id);
    CREATE INDEX IF NOT EXISTS idx_rle_session   ON rate_limit_events(session_id);
  `);

  // Vendor status pages, polled by the worker (see status-pages.ts). Raw
  // polls for 28 days, then one row per hour carrying the worst light.
  db.exec(`
    CREATE TABLE IF NOT EXISTS status_polls (
      id             INTEGER PRIMARY KEY AUTOINCREMENT,
      timestamp      TEXT NOT NULL,
      target_id      TEXT NOT NULL,
      indicator      TEXT NOT NULL,        -- none | minor | major | unknown | unreachable | blocked_by_robots
      description    TEXT NOT NULL,
      http_status    INTEGER,
      latency_ms     INTEGER,
      incidents_json TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_status_polls_target_ts ON status_polls(target_id, timestamp);
    CREATE TABLE IF NOT EXISTS status_polls_hourly (
      hour            TEXT NOT NULL,       -- YYYY-MM-DDTHH
      target_id       TEXT NOT NULL,
      worst_indicator TEXT NOT NULL,
      polls           INTEGER NOT NULL,
      unreachable     INTEGER NOT NULL,
      PRIMARY KEY (hour, target_id)
    );
  `);

  // vLLM prefix-cache counters, sampled per inference node.
  //
  // Stored as the counters vLLM reports rather than as a rate, because a hit
  // rate is a property of a window: the lifetime ratio says nothing about
  // whether caching is working now. Rates are computed by differencing two
  // samples — see vllm-metrics.cacheHitRate.
  db.exec(`
    CREATE TABLE IF NOT EXISTS vllm_cache_samples (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      timestamp     TEXT NOT NULL DEFAULT (datetime('now')),
      hostname      TEXT NOT NULL,
      model         TEXT NOT NULL,
      queries       REAL NOT NULL,          -- cumulative prompt tokens looked up
      hits          REAL NOT NULL,          -- cumulative tokens served from cache
      kv_usage      REAL,                   -- gauge 0..1, instantaneous
      kv_size_tokens INTEGER,
      prefix_caching INTEGER                -- vLLM's own on/off report
    );
    CREATE INDEX IF NOT EXISTS idx_vllm_cache_ts    ON vllm_cache_samples(timestamp);
    CREATE INDEX IF NOT EXISTS idx_vllm_cache_host  ON vllm_cache_samples(hostname, model, timestamp);
  `);

  // UUIDv7 unique index — try/catch since it may already exist
  try { db.exec('CREATE UNIQUE INDEX idx_todos_uuid ON todos(uuid) WHERE uuid IS NOT NULL'); } catch { /* exists */ }

  // Seed default alert thresholds.
  //
  // Rows exist for every (window, metric) pair we know how to check. Only
  // billable tokens (uncached input, output) at 15 and 60 minutes start
  // enabled: total_tokens is ~90% cache reads at 10% price, so a total_tokens
  // alert tracks context churn rather than spend and fires every window.
  // Values here are plan-tier guesses; calibrateAlertThresholds() replaces
  // them with 1.5x our own observed p95 once there is history to read.
  const count = db.prepare('SELECT COUNT(*) as c FROM alert_thresholds').get() as { c: number };
  const insert = db.prepare(
    'INSERT OR IGNORE INTO alert_thresholds (window_minutes, metric, threshold_value, enabled) VALUES (?, ?, ?, ?)'
  );
  const seedRows = db.transaction(() => {
    // Per-minute (tuned for Max plan, ~$6-8k/mo equivalent, 20+ agents)
    insert.run(1,  'output_tokens', 250000,    0);
    insert.run(1,  'input_tokens',  2500000,   0);
    // 5-minute windows
    insert.run(5,  'output_tokens', 1000000,   0);
    insert.run(5,  'input_tokens',  10000000,  0);
    insert.run(5,  'total_tokens',  12500000,  0);
    // 15-minute windows
    insert.run(15, 'output_tokens', 2500000,   1);
    insert.run(15, 'input_tokens',  25000000,  1);
    insert.run(15, 'total_tokens',  25000000,  0);
    // Hourly
    insert.run(60, 'output_tokens', 7500000,   1);
    insert.run(60, 'input_tokens',  75000000,  1);
    insert.run(60, 'total_tokens',  75000000,  0);
  });
  seedRows();
  if (count.c > 0) {
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

  // One-time: move existing installs onto the billable-metrics default. A
  // settings flag guards it so a human who later re-enables total_tokens is
  // not overruled on every boot.
  const flag = db.prepare("SELECT value FROM settings WHERE key = 'alert_defaults_v2'").get();
  if (!flag) {
    db.transaction(() => {
      db.prepare(
        `UPDATE alert_thresholds SET enabled = CASE
           WHEN metric IN ('input_tokens', 'output_tokens') AND window_minutes IN (15, 60) THEN 1
           ELSE 0 END`
      ).run();
      db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('alert_defaults_v2', '1')").run();
    })();
  }
}
