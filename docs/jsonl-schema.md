# Unified JSONL Schema for ML Agent Session Logging

A specification for logging machine learning agent sessions, tool calls, todos, and token usage in a single JSONL format. Designed for interoperability across coding agent harnesses.

## Why JSONL

Every coding agent harness writes session logs. None agree on the format. This makes cross-tool analytics, training data extraction, and agent fleet management harder than it needs to be. JSONL (newline-delimited JSON) is the natural fit: append-only, streamable, human-readable, trivially parseable.

This document describes the schema used by [unfirehose](https://github.com/russellballestrini/unfirehose-nextjs-logger) (unfirehose) to ingest, normalize, and query sessions from multiple harnesses. It serves as both documentation of what exists and a proposal for what the industry should converge on.

## Supported Harnesses

| Harness | Session Dir | Format | Adapter |
|---------|------------|--------|---------|
| Claude Code | `~/.claude/projects/{slug}/{session}.jsonl` | Native (reference) | Direct ingestion |
| Fetch | `~/.fetch/sessions/{slug}/{session}.jsonl` | Claude-compatible | Direct ingestion |
| uncloseai | `~/.uncloseai/sessions/{slug}/{session}.jsonl` | Custom events | `uncloseai-adapter.ts` |
| Codex (OpenAI) | `~/.codex/sessions/` | OpenAI-format | Planned |
| Aider | `.aider.chat.history.md` + `.aider.input.history` | Markdown | Planned |
| Continue.dev | `~/.continue/sessions/` | Custom JSON | Planned |
| Cursor | Internal SQLite | Proprietary | Planned |

## File Layout

### Project Directory Structure

```
~/.claude/
├── projects/
│   ├── {project-slug}/           # e.g. -home-fox-git-myproject
│   │   ├── sessions-index.json   # Session metadata index
│   │   ├── {session-uuid}.jsonl  # Session transcript
│   │   ├── {session-uuid}/
│   │   │   └── subagents/        # Subagent session files
│   │   └── memory/
│   │       └── MEMORY.md         # Persistent agent memory
│   └── ...
├── stats-cache.json              # Aggregated statistics
└── todos/                        # Legacy todo storage
```

### Project Slug Encoding

The project slug encodes the filesystem path of the working directory:

```
/home/fox/git/myproject  →  -home-fox-git-myproject
/home/fox/git/my.app     →  -home-fox-git-my-app
```

Path separators and dots become hyphens. Leading slash becomes leading hyphen.

## Sessions Index

Each project directory contains a `sessions-index.json` with metadata about all sessions in that project.

```json
{
  "version": 1,
  "entries": [
    {
      "sessionId": "4e0f77f7-1b16-4adc-88bd-37f46790e2ae",
      "fullPath": "/home/fox/.claude/projects/-home-fox-git-myproject/4e0f77f7.jsonl",
      "fileMtime": 1771245079191,
      "firstPrompt": "Fix the login page CSS",
      "summary": "",
      "messageCount": 14,
      "created": "2026-02-16T11:53:08.399Z",
      "modified": "2026-02-16T12:31:19.191Z",
      "gitBranch": "main",
      "projectPath": "/home/fox/git/myproject",
      "isSidechain": false
    }
  ]
}
```

| Field | Type | Description |
|-------|------|-------------|
| `sessionId` | UUID v4 | Unique session identifier |
| `fullPath` | string | Absolute path to the JSONL file |
| `fileMtime` | number | File modification time (ms since epoch) |
| `firstPrompt` | string | First user message (truncated) |
| `summary` | string | AI-generated session summary |
| `messageCount` | number | Total messages in session |
| `created` | ISO 8601 | Session start time |
| `modified` | ISO 8601 | Last activity time |
| `gitBranch` | string | Git branch at session start |
| `projectPath` | string | Original filesystem path of the project |
| `isSidechain` | boolean | Whether this is a subagent/sidechain session |

## JSONL Entry Types

Each line in a session JSONL file is a self-contained JSON object. The `type` field determines the entry schema.

### Common Fields

Every entry shares these fields:

```json
{
  "type": "user|assistant|system|file-history-snapshot",
  "sessionId": "uuid-v4",
  "version": "2.1.69",
  "cwd": "/home/fox/git/myproject",
  "gitBranch": "main",
  "timestamp": "2026-03-05T10:42:45.161Z",
  "uuid": "uuid-v4",
  "parentUuid": "uuid-v4|null",
  "isSidechain": false,
  "userType": "external|internal"
}
```

| Field | Type | Description |
|-------|------|-------------|
| `type` | string | Entry type: `user`, `assistant`, `system` |
| `sessionId` | UUID | Session this entry belongs to |
| `version` | string | CLI version that wrote this entry |
| `cwd` | string | Working directory at time of entry |
| `gitBranch` | string | Current git branch |
| `timestamp` | ISO 8601 | When the entry was created |
| `uuid` | UUID | Unique ID for this entry |
| `parentUuid` | UUID/null | ID of the entry this responds to (conversation threading) |
| `isSidechain` | boolean | True for subagent/parallel tool execution |
| `userType` | string | `external` (human) or `internal` (tool result) |

### User Entry

A message from the human or a tool result being fed back.

```json
{
  "type": "user",
  "message": {
    "role": "user",
    "content": "Fix the login page CSS"
  }
}
```

Content can be a string or an array of content blocks:

```json
{
  "type": "user",
  "message": {
    "role": "user",
    "content": [
      { "type": "text", "text": "Here's the error:" },
      {
        "type": "tool_result",
        "tool_use_id": "toolu_01ABC...",
        "content": "Command output here"
      }
    ]
  }
}
```

#### Tool Result Entries

When the user entry contains a tool result, additional metadata appears:

```json
{
  "type": "user",
  "message": { "role": "user", "content": [...] },
  "toolUseResult": {
    "matches": ["Bash", "Read"],
    "query": "select:Bash,Read",
    "total_deferred_tools": 22
  },
  "sourceToolAssistantUUID": "uuid-of-assistant-that-called-tool"
}
```

#### Todo Snapshot (Legacy)

User entries may contain a `todos` array (legacy TodoWrite format):

```json
{
  "type": "user",
  "todos": [
    {
      "content": "Add unit tests for auth module",
      "status": "pending",
      "activeForm": null
    }
  ]
}
```

### Assistant Entry

A response from the model, containing one or more content blocks.

```json
{
  "type": "assistant",
  "message": {
    "model": "claude-opus-4-6",
    "id": "msg_014BU3...",
    "role": "assistant",
    "content": [
      {
        "type": "thinking",
        "thinking": "Let me analyze the CSS structure..."
      },
      {
        "type": "text",
        "text": "I found the issue. The login form..."
      },
      {
        "type": "tool_use",
        "id": "toolu_01XYZ...",
        "name": "Edit",
        "input": {
          "file_path": "/src/login.css",
          "old_string": "margin: 0",
          "new_string": "margin: 1rem"
        }
      }
    ],
    "stop_reason": "end_turn|tool_use",
    "usage": {
      "input_tokens": 3,
      "output_tokens": 78,
      "cache_read_input_tokens": 12233,
      "cache_creation_input_tokens": 0,
      "service_tier": "standard"
    }
  },
  "requestId": "req_011CYjo2...",
  "timestamp": "2026-03-05T10:42:45.161Z"
}
```

### Content Block Types

| Block Type | Fields | Description |
|-----------|--------|-------------|
| `text` | `text` | Plain text response |
| `thinking` | `thinking` | Extended thinking / chain-of-thought (not shown to user) |
| `tool_use` | `id`, `name`, `input` | Tool invocation request |
| `tool_result` | `tool_use_id`, `content`, `is_error` | Result of a tool invocation |
| `tool_reference` | `tool_name` | Reference to a deferred tool being loaded |

### Token Usage

The `usage` object on assistant messages tracks token consumption:

```json
{
  "usage": {
    "input_tokens": 3,
    "output_tokens": 78,
    "cache_read_input_tokens": 12233,
    "cache_creation_input_tokens": 0,
    "service_tier": "standard",
    "server_tool_use": {
      "web_search_requests": 0,
      "web_fetch_requests": 0
    }
  }
}
```

**Important**: `input_tokens` is EXCLUSIVE of cache tokens. Total input = `input_tokens` + `cache_read_input_tokens` + `cache_creation_input_tokens`.

### System Entry

System-level events (session lifecycle, timing, etc.):

```json
{
  "type": "system",
  "subtype": "turn_duration|session_end|init",
  "durationMs": 5432
}
```

### File History Snapshot

Tracks file state for undo/redo:

```json
{
  "type": "file-history-snapshot",
  "messageId": "uuid",
  "snapshot": {
    "messageId": "uuid",
    "trackedFileBackups": {},
    "timestamp": "2026-03-05T10:42:41.773Z"
  },
  "isSnapshotUpdate": false
}
```

## Tool Call Schema

Tools are invoked via `tool_use` content blocks and their results returned as `tool_result` blocks. The `tool_use_id` field links them.

### Common Tools

| Tool | Purpose | Key Input Fields |
|------|---------|-----------------|
| `Bash` | Shell command execution | `command`, `timeout`, `description` |
| `Read` | Read file contents | `file_path`, `offset`, `limit` |
| `Edit` | Edit file (search & replace) | `file_path`, `old_string`, `new_string` |
| `Write` | Create/overwrite file | `file_path`, `content` |
| `Glob` | Find files by pattern | `pattern`, `path` |
| `Grep` | Search file contents | `pattern`, `path`, `output_mode` |
| `Agent` | Spawn subagent | `prompt`, `subagent_type` |
| `TaskCreate` | Create a todo/task | `subject`, `description` |
| `TaskUpdate` | Update task status | `taskId`, `status` |
| `TodoWrite` | Write todo snapshot | `todos[]` |

### TaskCreate / TaskUpdate Lifecycle

Tasks have a lifecycle tracked through tool calls:

```
TaskCreate(subject: "Add tests") → Task #1 created
TaskUpdate(taskId: 1, status: "in_progress")
TaskUpdate(taskId: 1, status: "completed")
```

Valid statuses: `pending`, `in_progress`, `completed`, `deleted`

## Normalized Database Schema

The JSONL is ingested into a normalized SQLite database for querying:

```
projects → sessions → messages → content_blocks
                   ↘ todos → todo_events
```

### Projects
```sql
CREATE TABLE projects (
  id INTEGER PRIMARY KEY,
  name TEXT UNIQUE NOT NULL,          -- encoded slug
  display_name TEXT NOT NULL,         -- human-readable
  path TEXT,                          -- original filesystem path
  first_seen TEXT DEFAULT (datetime('now'))
);
```

### Sessions
```sql
CREATE TABLE sessions (
  id INTEGER PRIMARY KEY,
  session_uuid TEXT UNIQUE NOT NULL,
  project_id INTEGER REFERENCES projects(id),
  git_branch TEXT,
  first_prompt TEXT,
  cli_version TEXT,
  created_at TEXT,
  updated_at TEXT,
  display_name TEXT,
  status TEXT DEFAULT 'active',       -- active, closed
  is_sidechain INTEGER DEFAULT 0
);
```

### Messages
```sql
CREATE TABLE messages (
  id INTEGER PRIMARY KEY,
  session_id INTEGER REFERENCES sessions(id),
  message_uuid TEXT,                  -- UNIQUE WHERE NOT NULL (dedup key)
  parent_uuid TEXT,                   -- conversation threading
  type TEXT NOT NULL,                 -- user, assistant, system
  subtype TEXT,
  timestamp TEXT,
  model TEXT,
  input_tokens INTEGER DEFAULT 0,
  output_tokens INTEGER DEFAULT 0,
  cache_read_tokens INTEGER DEFAULT 0,
  cache_creation_tokens INTEGER DEFAULT 0,
  duration_ms INTEGER,
  is_sidechain INTEGER DEFAULT 0
);
```

### Content Blocks
```sql
CREATE TABLE content_blocks (
  id INTEGER PRIMARY KEY,
  message_id INTEGER REFERENCES messages(id),
  position INTEGER NOT NULL,
  block_type TEXT NOT NULL,           -- text, thinking, tool_use, tool_result
  text_content TEXT,
  tool_name TEXT,
  tool_input TEXT,                    -- JSON string
  tool_use_id TEXT,
  is_error INTEGER DEFAULT 0
);
```

### Todos
```sql
CREATE TABLE todos (
  id INTEGER PRIMARY KEY,
  uuid TEXT,                          -- UUIDv7 for cross-machine identity
  project_id INTEGER REFERENCES projects(id),
  session_id INTEGER REFERENCES sessions(id),
  external_id TEXT,                   -- TaskCreate ID within session
  content TEXT NOT NULL,
  status TEXT DEFAULT 'pending',      -- pending, in_progress, completed, obsolete
  active_form TEXT,
  source TEXT DEFAULT 'claude',       -- claude, fetch, manual
  source_session_uuid TEXT,
  blocked_by TEXT,                    -- JSON array of blocking todo refs
  estimated_minutes INTEGER,
  created_at TEXT,
  updated_at TEXT,
  completed_at TEXT
);
```

### Todo Events (Audit Log)
```sql
CREATE TABLE todo_events (
  id INTEGER PRIMARY KEY,
  todo_id INTEGER REFERENCES todos(id),
  old_status TEXT,
  new_status TEXT NOT NULL,
  message_id INTEGER REFERENCES messages(id),
  event_at TEXT DEFAULT (datetime('now'))
);
```

## Harness-Specific Formats

### Claude Code (Reference Format)

**Location**: `~/.claude/projects/{slug}/{session-uuid}.jsonl`

The reference implementation. All fields documented above. Session files are append-only JSONL. The `sessions-index.json` provides metadata without parsing JSONL.

Key characteristics:
- UUID v4 for session and message IDs
- `parentUuid` threading for conversation structure
- `isSidechain` flag for subagent activity
- Token usage on every assistant message
- File history snapshots interspersed with conversation

### Fetch

**Location**: `~/.fetch/sessions/{slug}/{session-uuid}.jsonl`

Uses the same JSONL format as Claude Code. Direct ingestion without adaptation. Project slugs follow the same encoding scheme.

### uncloseai

**Location**: `~/.uncloseai/sessions/{slug}/{session-uuid}.jsonl`

Custom event format normalized to Claude Code format during ingestion:

```json
{"type": "session_start", "timestamp": "...", "prompt": "Fix the thing"}
{"type": "assistant", "timestamp": "...", "content": "I'll fix that..."}
{"type": "tool_call", "timestamp": "...", "tool": "bash", "args": "{\"command\": \"ls\"}"}
{"type": "session_end", "timestamp": "..."}
```

Adapter mapping:
| uncloseai | Normalized |
|-----------|-----------|
| `session_start` → | `user` message with prompt as text |
| `assistant` → | `assistant` message with text block |
| `tool_call` → | `assistant` message with tool_use block |
| `session_end` → | `system` message with session_end subtype |

### Codex (OpenAI) — Planned

**Location**: `~/.codex/sessions/`

OpenAI's Codex CLI writes sessions in a different format. Adapter planned.

Expected differences:
- OpenAI message format (`messages[]` array vs JSONL stream)
- Different tool call schema (`function_call` vs `tool_use`)
- No thinking blocks (no extended thinking equivalent)
- Different token usage fields

### Aider — Planned

**Location**: `.aider.chat.history.md` (per-project)

Aider uses markdown-based chat history. Adapter would parse:
- `/ask`, `/code`, `/architect` command blocks
- Code fence blocks as tool results
- Git commit references

### Continue.dev — Planned

**Location**: `~/.continue/sessions/`

JSON-based session storage. Adapter would map their message format to the unified schema.

## Todo Extraction

Todos are extracted from JSONL during ingestion from three sources:

1. **User entry `todos[]` array** — Legacy TodoWrite snapshots
2. **`TaskCreate` tool calls** — Creates new pending todos
3. **`TaskUpdate` tool calls** — Updates status of existing todos
4. **`TodoWrite` tool calls** — Batch todo snapshots
5. **Tool result task lists** — Parsed from JSON tool results containing `tasks[]`

### Dedup Rules

- Todos with `external_id` (from TaskCreate): keyed on `(project_id, external_id, source)`
- Legacy todos without IDs: keyed on `(project_id, session_id, content, source)`
- Terminal statuses (`completed`, `obsolete`) are sticky — re-ingestion cannot reopen them

### UUIDv7 for Cross-Machine Identity

Todos are assigned UUIDv7 identifiers at creation time. UUIDv7 is time-ordered (first 48 bits = unix milliseconds), so:
- B-tree indexes stay efficient (append-only inserts)
- Rough creation time is visible in the UUID prefix
- Safe for cross-machine sync and dedup

## API Endpoints

The normalized database is exposed via REST API at `localhost:3000`:

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/api/todos` | GET | List todos (filterable by project, status, source) |
| `/api/todos` | POST | Create a todo |
| `/api/todos` | PATCH | Update todo (status, estimate) |
| `/api/todos/bulk` | PATCH | Bulk update todos |
| `/api/todos/summary` | GET | Counts, stale items, by-project breakdown |
| `/api/todos/pending` | GET | Active todos with search and filters |
| `/api/todos/stale` | GET | Todos not touched in N days |
| `/api/logs` | GET | Search messages across all sessions |
| `/api/thinking` | GET | Search thinking/reasoning blocks |
| `/api/tokens` | GET | Token usage by model with cost calculation |
| `/api/projects` | GET | List all projects with session counts |
| `/api/boot` | POST | Spawn agent in tmux session |
| `/api/boot/mega` | POST/GET/DELETE | Fleet management: spawn, status, cull |

## Design Principles

1. **Append-only JSONL** — Never modify session files. Ingestion is idempotent via `message_uuid` dedup and byte offset tracking.
2. **Schema-on-read** — Raw JSONL carries everything. The normalized DB is a materialized view that can be rebuilt from source files.
3. **Harness-agnostic normalization** — Every harness gets an adapter that maps to the reference format. Analytics code only sees the normalized schema.
4. **PII-aware** — Text content is sanitized during ingestion (emails, keys, tokens replaced with placeholder tokens). Original hashes stored for audit.
5. **Cross-machine identity** — UUIDv7 for todos, UUID v4 for sessions/messages. No auto-increment IDs in the wire format.

## Contributing a Harness Adapter

To add support for a new coding agent harness:

1. Create `src/lib/{harness}-paths.ts` — Define where session files live
2. Create `src/lib/{harness}-adapter.ts` — Normalize entries to the reference format
3. Add ingestion logic to `src/lib/db/ingest.ts` — Scan directories and process files
4. The normalized entries flow through the existing `insertMessage` / `insertContentBlocks` pipeline

The adapter's job is to produce entries that match the reference format's `type`, `message.content[]`, and `message.usage` structure. Everything downstream (DB insertion, todo extraction, analytics) works automatically.
