# Database Schema & Index Reference

SQLite database at `~/.claude/sexy_logger.db`. WAL mode, foreign keys enforced.

Schema defined in `packages/core/db/schema.ts`.

## Table Sizes (as of 2026-03-05)

| Table | Rows | Purpose |
|---|---|---|
| messages | 159K | Core training data — every JSONL entry |
| content_blocks | 150K | Normalized content (text, thinking, tool_use, tool_result) |
| usage_minutes | 14K | Pre-computed per-minute token rollups |
| pii_replacements | 25K | PII redaction audit log |
| todo_events | 2.7K | Todo status change history |
| todos | 1.3K | Cross-session todo tracking |
| sessions | 465 | One per Claude Code session UUID |
| ingest_offsets | 465 | Byte offset tracking per JSONL file |
| projects | 47 | One per unique project directory |
| project_visibility | 37 | Scrobble visibility (public/private) |
| agent_deployments | 25 | Tmux agent tracking |
| alerts | 15 | Usage spike alerts |
| alert_thresholds | 7 | Configurable threshold rules |
| settings | 3 | Key-value app config |
| posts | 0 | Blog posts (jsonblog.org schema) |

## Entity Relationships

```
projects (47)
├── sessions (465)              project_id → projects.id
│   ├── messages (159K)         session_id → sessions.id
│   │   ├── content_blocks (150K)   message_id → messages.id
│   │   └── pii_replacements (25K)  message_id → messages.id
│   └── todos (1.3K)           session_id → sessions.id (nullable)
│       └── todo_events (2.7K) todo_id → todos.id
├── todos (1.3K)               project_id → projects.id
├── usage_minutes (14K)        project_id → projects.id (nullable)
├── agent_deployments (25)     project_id → projects.id
└── project_visibility (37)    project_id → projects.id (PK)
```

### Foreign Key Map

| Child Table | Column | Parent Table | Column | Nullable |
|---|---|---|---|---|
| sessions | project_id | projects | id | no |
| messages | session_id | sessions | id | no |
| content_blocks | message_id | messages | id | no |
| pii_replacements | message_id | messages | id | yes |
| todos | project_id | projects | id | no |
| todos | session_id | sessions | id | yes |
| todo_events | todo_id | todos | id | no |
| todo_events | message_id | messages | id | yes |
| usage_minutes | project_id | projects | id | yes |
| agent_deployments | project_id | projects | id | no |
| project_visibility | project_id | projects | id | no (PK) |

## Tables

### projects

One row per unique project directory. Created during ingestion.

| Column | Type | Notes |
|---|---|---|
| id | INTEGER PK | autoincrement |
| name | TEXT UNIQUE | encoded dir: `-home-fox-git-unsandbox-com` |
| display_name | TEXT | human-readable name |
| path | TEXT | original filesystem path |
| first_seen | TEXT | datetime default now |

### sessions

One row per Claude Code session UUID.

| Column | Type | Notes |
|---|---|---|
| id | INTEGER PK | autoincrement |
| session_uuid | TEXT UNIQUE | Claude Code session ID |
| project_id | INTEGER FK | → projects.id |
| git_branch | TEXT | branch at session start |
| first_prompt | TEXT | first user message |
| cli_version | TEXT | Claude CLI version |
| created_at | TEXT | session start time |
| updated_at | TEXT | last activity time |
| is_sidechain | INTEGER | 0 or 1 |
| display_name | TEXT | human-readable label (migration) |
| status | TEXT | `active` or `closed` (migration) |
| closed_at | TEXT | when session was closed (migration) |
| last_message_at | TEXT | timestamp of newest message (migration) |

### messages

One row per JSONL entry. The core training data table.

| Column | Type | Notes |
|---|---|---|
| id | INTEGER PK | autoincrement |
| session_id | INTEGER FK | → sessions.id |
| message_uuid | TEXT | unique within session, nullable |
| parent_uuid | TEXT | conversation tree parent |
| type | TEXT | `user`, `assistant`, `system` |
| subtype | TEXT | system entries: `turn_duration`, etc. |
| timestamp | TEXT | ISO 8601 |
| model | TEXT | `claude-opus-4-6`, etc. |
| input_tokens | INTEGER | assistant messages only |
| output_tokens | INTEGER | assistant messages only |
| cache_read_tokens | INTEGER | prompt cache hits |
| cache_creation_tokens | INTEGER | prompt cache writes |
| duration_ms | INTEGER | system turn duration |
| is_sidechain | INTEGER | 0 or 1 |
| ingested_at | TEXT | datetime default now |

**Note:** `input_tokens` in the Anthropic API is exclusive of cache tokens. Cache tokens are tracked separately in `cache_read_tokens` and `cache_creation_tokens`.

### content_blocks

Normalized from `message.content` arrays. Enables independent querying of thinking, tools, and text.

| Column | Type | Notes |
|---|---|---|
| id | INTEGER PK | autoincrement |
| message_id | INTEGER FK | → messages.id |
| position | INTEGER | order within content array |
| block_type | TEXT | `text`, `thinking`, `tool_use`, `tool_result` |
| text_content | TEXT | text or thinking content |
| tool_name | TEXT | for tool_use blocks |
| tool_input | TEXT | JSON string of tool input |
| tool_use_id | TEXT | tool_use id or tool_result ref |
| is_error | INTEGER | for tool_result blocks |

### todos

Cross-session todo tracking. Extracted from Claude Code, Fetch, and uncloseai JSONL during ingestion.

| Column | Type | Notes |
|---|---|---|
| id | INTEGER PK | autoincrement |
| uuid | TEXT | UUIDv7, unique where not null (migration) |
| project_id | INTEGER FK | → projects.id |
| session_id | INTEGER FK | → sessions.id (nullable) |
| external_id | TEXT | external reference ID |
| content | TEXT | todo description |
| status | TEXT | `pending`, `in_progress`, `completed` |
| active_form | TEXT | latest wording of the todo |
| source | TEXT | `claude`, `fetch`, `manual`, etc. |
| source_session_uuid | TEXT | originating session |
| blocked_by | TEXT | blocking reference |
| estimated_minutes | INTEGER | time estimate (migration) |
| created_at | TEXT | datetime default now |
| updated_at | TEXT | datetime default now |
| completed_at | TEXT | when completed |

### todo_events

Audit log of todo status changes.

| Column | Type | Notes |
|---|---|---|
| id | INTEGER PK | autoincrement |
| todo_id | INTEGER FK | → todos.id |
| old_status | TEXT | previous status |
| new_status | TEXT | new status |
| message_id | INTEGER FK | → messages.id (nullable) |
| event_at | TEXT | datetime default now |

### usage_minutes

Pre-computed per-minute token rollups for spike detection. Composite PK on `(minute, project_id)`.

| Column | Type | Notes |
|---|---|---|
| minute | TEXT PK | `YYYY-MM-DDTHH:MM` |
| project_id | INTEGER PK/FK | → projects.id (nullable) |
| input_tokens | INTEGER | |
| output_tokens | INTEGER | |
| cache_read_tokens | INTEGER | |
| cache_creation_tokens | INTEGER | |
| message_count | INTEGER | |

### alerts

Usage spike alert log.

| Column | Type | Notes |
|---|---|---|
| id | INTEGER PK | autoincrement |
| triggered_at | TEXT | datetime default now |
| alert_type | TEXT | `rate_spike`, `threshold_breach`, `sustained_high` |
| window_minutes | INTEGER | 1, 5, 15, 60 |
| metric | TEXT | `input_tokens`, `output_tokens`, `total_tokens`, `cost_usd` |
| threshold_value | REAL | configured threshold |
| actual_value | REAL | measured value |
| project_name | TEXT | null = global |
| details | TEXT | JSON context |
| acknowledged | INTEGER | 0 or 1 |

### alert_thresholds

Configurable threshold rules. UNIQUE on `(window_minutes, metric)`.

| Column | Type | Notes |
|---|---|---|
| id | INTEGER PK | autoincrement |
| window_minutes | INTEGER | 1, 5, 15, 60 |
| metric | TEXT | `input_tokens`, `output_tokens`, `total_tokens` |
| threshold_value | REAL | token count |
| enabled | INTEGER | 0 or 1 |

### Other Tables

**ingest_offsets** — Byte offset per JSONL file to avoid re-reading. PK on `file_path`.

**settings** — Key-value store. PK on `key`.

**posts** — Blog posts (jsonblog.org schema). PK on `id`, UNIQUE on `post_uuid`.

**pii_replacements** — PII redaction audit log. Stores hashes, never raw PII.

**agent_deployments** — Tracks tmux sessions spawned by mega deploy.

**project_visibility** — Scrobble visibility per project. PK on `project_id`.

## Indexes

### Current Indexes (20 total)

#### messages (6 indexes — heaviest table)

| Index | Columns | Type | Selectivity | Used By |
|---|---|---|---|---|
| `idx_messages_session` | `session_id` | btree | ~357 rows/key | Session detail, message lookups |
| `idx_messages_timestamp` | `timestamp` | btree | ~1 row/key | Date range filtering (all pages) |
| `idx_messages_type` | `type` | btree | ~53K rows/key | Filtering user/assistant/system |
| `idx_messages_model` | `model` | btree | ~32K rows/key | Model aggregations |
| `idx_messages_model_tokens` | `(model, timestamp)` | partial, `WHERE model IS NOT NULL` | ~1 row/key | Token page model+date queries |
| `idx_messages_uuid_unique` | `message_uuid` | unique partial, `WHERE message_uuid IS NOT NULL` | 1 row/key | Dedup on ingestion |

#### content_blocks (3 indexes)

| Index | Columns | Type | Selectivity | Used By |
|---|---|---|---|---|
| `idx_content_blocks_message` | `message_id` | btree | ~1 row/key | JOIN from messages |
| `idx_content_blocks_type` | `block_type` | btree | ~30K rows/key | Block type filtering |
| `idx_content_blocks_type_message` | `(block_type, message_id)` | composite | ~1 row/key | Thinking/tool queries with message JOIN |

#### sessions (1 index + auto)

| Index | Columns | Type | Selectivity | Used By |
|---|---|---|---|---|
| `idx_sessions_project` | `project_id` | btree | ~10 rows/key | Project detail pages |
| `sqlite_autoindex_sessions_1` | `session_uuid` | unique (auto) | 1 row/key | Session lookup |

#### todos (3 indexes)

| Index | Columns | Type | Selectivity | Used By |
|---|---|---|---|---|
| `idx_todos_project` | `project_id` | btree | ~44 rows/key | Project todo queries |
| `idx_todos_status` | `status` | btree | ~326 rows/key | Pending/completed filtering |
| `idx_todos_uuid` | `uuid` | unique partial, `WHERE uuid IS NOT NULL` | 1 row/key | UUIDv7 cross-machine identity |

#### Other tables

| Index | Table | Columns | Used By |
|---|---|---|---|
| `idx_todo_events_todo` | todo_events | `todo_id` | Todo history lookup |
| `idx_usage_minutes_minute` | usage_minutes | `minute` | Time-window aggregations |
| `idx_alerts_triggered` | alerts | `triggered_at` | Recent alerts queries |
| `idx_agent_deployments_status` | agent_deployments | `status` | Active deployment lookup |
| `idx_pii_message` | pii_replacements | `message_id` | PII lookup by message |
| `idx_posts_published` | posts | `published_at` | Blog feed ordering |
| `idx_posts_type` | posts | `post_type` | Blog post type filtering |

## Index Gap Analysis

### Well-covered queries
- **Token page aggregations**: `idx_messages_model_tokens` covers `GROUP BY model` with timestamp filter
- **Session detail**: `idx_messages_session` + `idx_content_blocks_message` cover the JOIN chain
- **Message dedup**: `idx_messages_uuid_unique` enables `INSERT OR IGNORE`
- **Todo filtering**: `idx_todos_status` + `idx_todos_project` cover the main queries

### Potential improvements

| Gap | Query Pattern | Recommendation | Priority |
|---|---|---|---|
| Stale session detection | `WHERE status = 'active' AND last_message_at < ?` | Composite `(status, last_message_at)` on sessions | Low — only 465 rows |
| Todo stale queries | `WHERE status IN (...) AND updated_at < ?` | Composite `(status, updated_at)` on todos | Low — only 1.3K rows |
| Content text search | `WHERE text_content LIKE ?` on content_blocks | FTS5 virtual table | Medium — 150K rows, LIKE scan |
| Todo content search | `WHERE content LIKE ?` on todos | FTS5 virtual table | Low — only 1.3K rows |
| Tool name aggregation | `GROUP BY tool_name` on content_blocks | Index on `tool_name` | Low — covered by type_message composite for filtered queries |

### Not worth indexing (table too small)
- projects (47 rows) — full scan is instant
- alert_thresholds (7 rows) — full scan is instant
- settings (3 rows) — full scan is instant
- agent_deployments (25 rows) — existing status index is sufficient
- project_visibility (37 rows) — PK covers all queries

### FTS5 consideration

The biggest unindexed query pattern is `LIKE '%keyword%'` on `content_blocks.text_content` (150K rows) used by the thinking and logs search endpoints. A FTS5 virtual table would turn these from full-scan to instant:

```sql
CREATE VIRTUAL TABLE content_blocks_fts USING fts5(
  text_content,
  content='content_blocks',
  content_rowid='id'
);
```

This would require triggers to keep the FTS index in sync during ingestion. Worth doing when table exceeds ~500K rows or search latency becomes noticeable.
