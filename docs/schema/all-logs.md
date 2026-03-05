# All Logs — JSONL Stream Format & Ingestion Pipeline

How everything fits together: the JSONL file format, directory layout, ingestion pipeline, and adapter authoring guide.

## File Layout Convention

All harnesses should follow this directory structure:

```
~/.{harness}/
├── projects/                        # or sessions/
│   ├── {project-slug}/
│   │   ├── sessions-index.json      # session metadata index
│   │   ├── {session-uuid}.jsonl     # session transcript
│   │   └── memory/
│   │       └── MEMORY.md            # persistent agent memory
│   └── ...
└── config.json                      # harness-specific config
```

Known harness locations:

| Harness | Base Directory | Structure |
|---------|---------------|-----------|
| Claude Code | `~/.claude/projects/` | `{slug}/{uuid}.jsonl` |
| Fetch | `~/.fetch/sessions/` | `{slug}/{uuid}.jsonl` |
| Gemini CLI | `~/.gemini/sessions/` | TBD |
| uncloseai-cli | `~/.uncloseai/sessions/` | `{slug}/{uuid}.jsonl` |
| Codex | `~/.codex/sessions/` | TBD |
| Aider | Per-project `.aider.chat.history.md` | Markdown |
| agnt | `~/.agnt/projects/` | `{slug}/{uuid}.jsonl` (native unfirehose/1.0) |

## JSONL Stream Structure

```
Line 1: {"$schema": "unfirehose/1.0", "type": "session", ...}     # session header (optional)
Line 2: {"type": "message", "role": "user", ...}                   # first user message
Line 3: {"type": "message", "role": "assistant", ...}              # first assistant response
Line 4: {"type": "message", "role": "user", ...}                   # tool result or next prompt
...
Line N: {"type": "message", "role": "system", "subtype": "session_end"}
```

The session header line is optional. If absent, session metadata is inferred from the first message and the `sessions-index.json`.

### System Messages

Special system-role messages for harness metadata:

| Subtype | Purpose | Fields |
|---------|---------|--------|
| `init` | Session initialization | harness, version, cwd |
| `turn_duration` | Time between user prompt and final response | `durationMs` |
| `session_end` | Explicit session close | — |

## Ingestion Pipeline

```
JSONL file (any harness)
  │
  ├─ Claude Code / Fetch: direct read (reference format)
  ├─ uncloseai-cli: normalize via uncloseai-adapter.ts
  ├─ Gemini CLI: normalize via gemini-adapter.ts (planned)
  ├─ Codex: normalize via codex-adapter.ts (planned)
  ├─ Aider: markdown parser → normalize (planned)
  └─ agnt: direct read (native unfirehose/1.0)
  │
  ▼
Unified message format
  │
  ├─ insertMessage() → messages table (dedup on message UUID)
  ├─ insertContentBlocks() → content_blocks table (position-ordered)
  ├─ extractTodos() → todos table (from TodoWrite/TaskCreate)
  ├─ updateUsageMinutes() → usage_minutes table (per-minute rollups)
  └─ sanitizePII() → pii_replacements table (hashes only)
```

### Idempotency

- **Message UUID dedup**: `INSERT OR IGNORE` on unique `message_uuid` index
- **Byte offset tracking**: `ingest_offsets` table stores last read position per file
- **Terminal todo statuses**: `completed`, `obsolete`, `deleted` are sticky across re-ingestion
- Safe to re-run ingestion at any time

## Writing a Harness Adapter

To add support for a new harness:

1. **`packages/core/{harness}-paths.ts`** — Where session files live on disk
2. **`packages/core/{harness}-adapter.ts`** — Normalize native entries to canonical format
3. **Add ingestion logic to `packages/core/db/ingest.ts`** — Directory scanning and batch processing

### Adapter Function Signature

```typescript
import type { SessionEntry } from '@unfirehose/core/types';

export function normalizeEntry(raw: unknown): SessionEntry | null {
  // Map native harness fields → canonical format
  // Return null for unmapped/irrelevant event types
}
```

### Minimum Viable Adapter

The adapter must produce entries with:
- `type`: `"user"`, `"assistant"`, or `"system"`
- `message.role`: matching the type
- `message.content`: array of content blocks
- `timestamp`: ISO 8601
- `sessionId`: unique session identifier

Everything else (`usage`, `parentUuid`, `model`, `gitBranch`) is optional. Missing fields degrade gracefully — analytics pages show "unknown" for missing models, zero for missing token counts.

### Example: Minimal Adapter

```typescript
export function normalizeEntry(raw: any): SessionEntry | null {
  if (raw.type === 'user_message') {
    return {
      type: 'user',
      timestamp: raw.ts,
      message: {
        role: 'user',
        content: [{ type: 'text', text: raw.text }],
      },
    };
  }
  if (raw.type === 'bot_response') {
    return {
      type: 'assistant',
      timestamp: raw.ts,
      message: {
        role: 'assistant',
        content: [{ type: 'text', text: raw.reply }],
        model: raw.model ?? 'unknown',
      },
    };
  }
  return null; // Skip unknown event types
}
```

## Querying All Logs

The `/api/logs` endpoint queries across all ingested data:

```bash
# Search all logs
curl "localhost:3000/api/logs?search=error&from=2026-03-01&types=assistant&limit=50"

# Search thinking blocks
curl "localhost:3000/api/thinking?search=architecture&from=2026-03-01&limit=100"
```

Query parameters:
- `search` — text content search (LIKE on content_blocks)
- `from` — ISO 8601 date filter
- `types` — comma-separated message types (user, assistant, system)
- `limit` / `offset` — pagination
