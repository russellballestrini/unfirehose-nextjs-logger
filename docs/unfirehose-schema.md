# unfirehose.org — Unified Session Schema

A standard JSON format for machine learning agent session logging. Any harness (Claude Code, Gemini CLI, uncloseai-cli, hermes-agent, Fetch, Codex, Aider) can either log in this format natively or be adapted just-in-time on ingestion.

**Design goals**: one schema to rule sessions, thinking chains, tool calls, todos, metrics, and projects. Fork from Vercel AI SDK types where alignment exists, diverge where agent coding sessions need more.

## Schema Version

```
unfirehose/1.0
```

All objects carry `$schema: "unfirehose/1.0"` for forward compatibility. Consumers ignore unknown fields.

---

## Top-Level Objects

The schema defines six top-level object types. Each can appear as a line in a JSONL stream or as a standalone JSON document.

| Object | Purpose | JSONL stream | Standalone |
|--------|---------|:---:|:---:|
| `session` | Session lifecycle envelope | header line | index files |
| `message` | User/assistant/system turn | yes | — |
| `tool_definition` | Tool schema (Vercel AI SDK compatible) | optional header | registry |
| `todo` | Cross-session work item | extracted from messages | API |
| `metric` | Token usage, cost, timing | embedded in messages | rollup API |
| `project` | Repository/workspace identity | index files | API |

---

## 1. Message

The atomic unit. One JSONL line per message.

### Canonical Format

```jsonc
{
  "$schema": "unfirehose/1.0",
  "type": "message",
  "id": "msg_019abc...",              // unique message ID (UUID or provider ID)
  "sessionId": "4e0f77f7-...",        // parent session UUID
  "parentId": "msg_018xyz...",         // conversation tree parent (null for roots)
  "role": "user|assistant|system|tool",
  "timestamp": "2026-03-05T10:42:45.161Z",

  // Content: always an array of typed blocks
  "content": [
    { "type": "text", "text": "Fix the login page" },
    { "type": "reasoning", "text": "Let me think about..." },
    { "type": "tool-call", "toolCallId": "tc_01...", "toolName": "Bash", "input": { "command": "ls" } },
    { "type": "tool-result", "toolCallId": "tc_01...", "toolName": "Bash", "output": "file.txt", "isError": false },
    { "type": "image", "mediaType": "image/png", "data": "base64..." },
    { "type": "file", "mediaType": "application/pdf", "data": "base64..." }
  ],

  // Model info (assistant messages only)
  "model": "claude-opus-4-6",
  "stopReason": "end_turn|tool_calls|length|content_filter|error",
  "provider": "anthropic|google|openai|local",

  // Token usage (assistant messages only)
  "usage": {
    "inputTokens": 3,
    "outputTokens": 78,
    "inputTokenDetails": {
      "cacheReadTokens": 12233,
      "cacheWriteTokens": 0,
      "noCacheTokens": 3
    },
    "outputTokenDetails": {
      "textTokens": 60,
      "reasoningTokens": 18
    },
    "totalTokens": 12314
  },

  // System message fields
  "subtype": "turn_duration|session_end|init",
  "durationMs": 5432,

  // Context
  "sidechain": false,                 // true for subagent/parallel execution
  "cwd": "/home/fox/git/myproject",
  "gitBranch": "main",
  "harness": "claude-code",           // originating harness
  "harnessVersion": "2.1.69"
}
```

### Content Block Types

Aligned with Vercel AI SDK naming where possible. The SDK uses `input`/`output` and `tool-call`/`tool-result` (hyphenated). We adopt these names.

| Block Type | Fields | Vercel AI SDK Equivalent | Notes |
|------------|--------|--------------------------|-------|
| `text` | `text` | `TextPart` | Plain text |
| `reasoning` | `text` | `ReasoningPart` | Extended thinking / chain-of-thought |
| `tool-call` | `toolCallId`, `toolName`, `input` | `ToolCallPart` | Tool invocation |
| `tool-result` | `toolCallId`, `toolName`, `output`, `isError` | `ToolResultPart` | Tool response |
| `image` | `mediaType`, `data` | `ImagePart` | Inline image |
| `file` | `mediaType`, `data` | `FilePart` | Inline file |

**Linking**: `toolCallId` links a `tool-call` block to its `tool-result` block. The call appears in an assistant message; the result appears in the next user or tool-role message.

### Usage Object

Aligned with Vercel AI SDK `LanguageModelUsage`:

```typescript
interface Usage {
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
  inputTokenDetails?: {
    noCacheTokens?: number;
    cacheReadTokens?: number;
    cacheWriteTokens?: number;
  };
  outputTokenDetails?: {
    textTokens?: number;
    reasoningTokens?: number;
  };
}
```

**Important**: `inputTokens` is exclusive of cache tokens in the Anthropic API. `totalTokens = inputTokens + outputTokens + cacheReadTokens + cacheWriteTokens` if you want the full context window count.

---

## 2. Session

Wraps a sequence of messages. Appears as the first JSONL line or in an index file.

```jsonc
{
  "$schema": "unfirehose/1.0",
  "type": "session",
  "id": "4e0f77f7-1b16-4adc-88bd-37f46790e2ae",
  "projectId": "-home-fox-git-myproject",
  "status": "active|closed",
  "createdAt": "2026-03-05T10:42:45.161Z",
  "updatedAt": "2026-03-05T12:31:19.191Z",
  "closedAt": null,

  // Context
  "firstPrompt": "Fix the login page CSS",
  "summary": "",
  "gitBranch": "main",
  "cwd": "/home/fox/git/myproject",
  "sidechain": false,

  // Harness metadata
  "harness": "claude-code",
  "harnessVersion": "2.1.69",

  // Aggregate stats (optional, for index files)
  "messageCount": 14,
  "totalUsage": {
    "inputTokens": 1200,
    "outputTokens": 4500,
    "inputTokenDetails": { "cacheReadTokens": 89000, "cacheWriteTokens": 3200 }
  }
}
```

---

## 3. Tool Definition

Compatible with Vercel AI SDK `tool()` shape. Published in a tool registry or as JSONL header lines.

```jsonc
{
  "$schema": "unfirehose/1.0",
  "type": "tool_definition",
  "name": "Bash",
  "description": "Execute a shell command and return its output",
  "inputSchema": {
    "type": "object",
    "properties": {
      "command": { "type": "string", "description": "The command to execute" },
      "timeout": { "type": "number", "description": "Timeout in milliseconds" },
      "description": { "type": "string", "description": "What this command does" }
    },
    "required": ["command"]
  },
  "outputSchema": {
    "type": "object",
    "properties": {
      "stdout": { "type": "string" },
      "stderr": { "type": "string" },
      "exitCode": { "type": "number" }
    }
  }
}
```

**Vercel AI SDK alignment**: `inputSchema` maps to the `parameters` field (accepts JSON Schema or Zod). We use `inputSchema`/`outputSchema` to match the SDK's `tool()` function signature.

### Standard Tool Registry

Tools that all coding agent harnesses share (names may differ per harness):

| Canonical Name | Purpose | Aliases |
|----------------|---------|---------|
| `Bash` | Shell execution | `bash`, `terminal`, `shell`, `execute` |
| `Read` | Read file | `read_file`, `cat`, `view` |
| `Write` | Write file | `write_file`, `create_file` |
| `Edit` | Edit file (diff) | `edit_file`, `str_replace`, `patch` |
| `Glob` | Find files | `find_files`, `list_files`, `search_files` |
| `Grep` | Search content | `search`, `ripgrep`, `find_in_files` |
| `WebFetch` | HTTP fetch | `web_fetch`, `curl`, `browser` |
| `WebSearch` | Web search | `web_search`, `google` |
| `Agent` | Spawn subagent | `sub_agent`, `delegate` |
| `AskUser` | Prompt human | `ask_user`, `human_input` |

Adapters normalize tool name aliases to canonical names during ingestion.

---

## 4. Todo

Cross-session work items extracted from tool calls or created manually.

```jsonc
{
  "$schema": "unfirehose/1.0",
  "type": "todo",
  "uuid": "019506a8-7c5f-7000-8000-abcdef012345",  // UUIDv7 (time-ordered)
  "projectId": "-home-fox-git-myproject",
  "sessionId": "4e0f77f7-...",
  "status": "pending|in_progress|completed|obsolete",
  "content": "Add unit tests for auth module",
  "activeForm": "Add unit tests for the auth module login flow",
  "source": "claude-code|gemini|uncloseai|hermes|fetch|manual",
  "sourceSessionId": "4e0f77f7-...",
  "blockedBy": ["todo:019506b2-..."],
  "estimatedMinutes": 30,
  "createdAt": "2026-03-05T10:42:45.161Z",
  "updatedAt": "2026-03-05T12:00:00.000Z",
  "completedAt": null
}
```

**UUIDv7**: time-ordered (48-bit ms timestamp prefix). Efficient B-tree inserts, human-scannable creation time, safe for cross-machine sync.

**Terminal statuses**: `completed` and `obsolete` are sticky. Re-ingestion cannot reopen them.

### Todo Events (Audit Log)

```jsonc
{
  "$schema": "unfirehose/1.0",
  "type": "todo_event",
  "todoUuid": "019506a8-...",
  "oldStatus": "pending",
  "newStatus": "in_progress",
  "messageId": "msg_019abc...",
  "eventAt": "2026-03-05T11:00:00.000Z"
}
```

---

## 5. Metric

Pre-computed rollups for dashboards and spike detection. Generated during ingestion.

```jsonc
{
  "$schema": "unfirehose/1.0",
  "type": "metric",
  "window": "2026-03-05T10:42",       // minute-level granularity
  "projectId": "-home-fox-git-myproject",
  "usage": {
    "inputTokens": 5000,
    "outputTokens": 12000,
    "inputTokenDetails": { "cacheReadTokens": 45000, "cacheWriteTokens": 2000 }
  },
  "messageCount": 8,
  "costUsd": 0.42                      // equivalent API cost
}
```

### Alert Thresholds

```jsonc
{
  "$schema": "unfirehose/1.0",
  "type": "alert_threshold",
  "windowMinutes": 5,
  "metric": "output_tokens|input_tokens|total_tokens|cost_usd",
  "thresholdValue": 1000000,
  "enabled": true
}
```

---

## 6. Project

Repository or workspace identity. Published in index files and the API.

```jsonc
{
  "$schema": "unfirehose/1.0",
  "type": "project",
  "id": "-home-fox-git-myproject",     // slug-encoded path
  "displayName": "myproject",
  "path": "/home/fox/git/myproject",
  "visibility": "public|private",
  "firstSeen": "2026-01-12T00:00:00.000Z",
  "git": {
    "branch": "main",
    "remotes": [
      { "name": "origin", "url": "git@github.com:user/repo.git", "type": "push" }
    ],
    "recentCommits": [
      { "hash": "abc123", "subject": "Fix login", "author": "fox", "date": "2026-03-05" }
    ]
  }
}
```

### Slug Encoding

```
/home/fox/git/myproject     →  -home-fox-git-myproject
/home/fox/git/my.app        →  -home-fox-git-my-app
```

Path separators and dots become hyphens. Leading slash becomes leading hyphen.

---

## Harness Native Formats & Adaptation

### Claude Code (reference implementation)

**Location**: `~/.claude/projects/{slug}/{session-uuid}.jsonl`
**Adapter**: none (native format, adapted from → schema was designed around it)

| Claude Code Field | Unfirehose Field | Transform |
|---|---|---|
| `type: "user"` | `role: "user"` | direct |
| `type: "assistant"` | `role: "assistant"` | direct |
| `type: "system"` | `role: "system"` | direct |
| `uuid` | `id` | rename |
| `parentUuid` | `parentId` | rename |
| `isSidechain` | `sidechain` | rename |
| `message.content[].type: "thinking"` | `content[].type: "reasoning"` | rename |
| `message.content[].thinking` | `content[].text` | rename field |
| `message.content[].type: "tool_use"` | `content[].type: "tool-call"` | rename, remap fields |
| `message.content[].id` | `content[].toolCallId` | rename |
| `message.content[].name` | `content[].toolName` | rename |
| `message.content[].type: "tool_result"` | `content[].type: "tool-result"` | rename, remap fields |
| `message.content[].tool_use_id` | `content[].toolCallId` | rename |
| `message.usage.input_tokens` | `usage.inputTokens` | camelCase |
| `message.usage.cache_read_input_tokens` | `usage.inputTokenDetails.cacheReadTokens` | nest + camelCase |
| `message.usage.cache_creation_input_tokens` | `usage.inputTokenDetails.cacheWriteTokens` | nest + camelCase |

### Fetch

**Location**: `~/.fetch/sessions/{slug}/{session-uuid}.jsonl`
**Adapter**: same as Claude Code (identical format)

Projects prefixed `fetch:` in the database. Display names formatted `[fetch] {name}`.

### Gemini CLI

**Location**: `~/.gemini/sessions/{slug}/{session-uuid}.jsonl` (expected)
**Adapter**: planned
**Status**: not yet implemented

Expected differences from Claude Code:

| Gemini Field | Unfirehose Field | Notes |
|---|---|---|
| `parts[].text` | `content[].text` | Google uses `parts` not `content` |
| `parts[].functionCall` | `content[].tool-call` | `functionCall.name` + `functionCall.args` |
| `parts[].functionResponse` | `content[].tool-result` | `functionResponse.name` + `functionResponse.response` |
| `usageMetadata.promptTokenCount` | `usage.inputTokens` | different field names |
| `usageMetadata.candidatesTokenCount` | `usage.outputTokens` | |
| `usageMetadata.cachedContentTokenCount` | `usage.inputTokenDetails.cacheReadTokens` | |
| no thinking blocks | — | Gemini uses `thinkingConfig` but no separate block type in output yet |

### uncloseai-cli

**Location**: `~/.uncloseai/sessions/{slug}/{session-uuid}.jsonl`
**Adapter**: `packages/core/uncloseai-adapter.ts`

Native format uses event types instead of message roles:

```jsonc
// Native uncloseai events:
{"type": "session_start", "timestamp": "...", "prompt": "Fix the thing"}
{"type": "assistant", "timestamp": "...", "content": "I'll fix that..."}
{"type": "tool_call", "timestamp": "...", "tool": "bash", "args": "{\"command\": \"ls\"}"}
{"type": "session_end", "timestamp": "..."}
```

| uncloseai Event | Unfirehose Message | Transform |
|---|---|---|
| `session_start` | `role: "user"`, content text from `prompt` | event → message |
| `assistant` | `role: "assistant"`, content text from `content` | event → message |
| `tool_call` | `role: "assistant"`, `tool-call` block from `tool`+`args` | event → message + block |
| `session_end` | `role: "system"`, `subtype: "session_end"` | event → message |

Model hardcoded to `hermes-3-8b`. Token usage zeroed (not tracked by uncloseai).

### hermes-agent

**Location**: TBD
**Adapter**: planned
**Status**: not yet implemented

hermes-agent runs Hermes 3 locally via llama.cpp or similar. Expected format follows the OpenAI chat completions shape:

| hermes-agent Field | Unfirehose Field | Notes |
|---|---|---|
| `messages[].role` | `role` | direct (`user`, `assistant`, `system`, `tool`) |
| `messages[].content` | `content[].text` | string → text block |
| `messages[].tool_calls[].function.name` | `content[].toolName` | OpenAI function calling format |
| `messages[].tool_calls[].function.arguments` | `content[].input` | JSON string → parsed object |
| `messages[].tool_calls[].id` | `content[].toolCallId` | direct |
| `usage.prompt_tokens` | `usage.inputTokens` | rename |
| `usage.completion_tokens` | `usage.outputTokens` | rename |

### Codex (OpenAI) — planned

**Location**: `~/.codex/sessions/`
**Adapter**: planned

Same OpenAI message format as hermes-agent but with `gpt-4o` / `o3` models.

### Aider — planned

**Location**: `.aider.chat.history.md` per project
**Adapter**: planned (markdown parser)

Aider logs are markdown, not JSON. Adapter parses `/ask`, `/code`, `/architect` blocks into messages with role inference.

---

## Thinking Chains

Extended thinking / chain-of-thought blocks appear as `reasoning` content blocks within assistant messages. They form a thinking chain when read in sequence across a session.

```jsonc
// Assistant message with thinking
{
  "role": "assistant",
  "content": [
    { "type": "reasoning", "text": "The user wants me to fix the CSS..." },
    { "type": "text", "text": "I found the issue in login.css." },
    { "type": "tool-call", "toolCallId": "tc_01", "toolName": "Edit", "input": { "..." } }
  ]
}
```

To extract a thinking chain for a session:

```sql
SELECT cb.text_content, m.timestamp, m.model
FROM content_blocks cb
JOIN messages m ON cb.message_id = m.id
JOIN sessions s ON m.session_id = s.id
WHERE s.session_uuid = ? AND cb.block_type = 'thinking'
ORDER BY m.timestamp, cb.position;
```

### Cross-Harness Thinking Support

| Harness | Thinking Block | Notes |
|---------|----------------|-------|
| Claude Code | `type: "thinking"`, field: `thinking` | Full extended thinking with signature |
| Gemini CLI | `thinkingConfig` parameter, no separate output block | May need inference from model behavior |
| uncloseai-cli | Not supported | Hermes 3 doesn't have extended thinking |
| hermes-agent | Not supported | Local model, no thinking API |
| Fetch | Same as Claude Code | Uses Claude models |
| Codex | Not supported | OpenAI o-series has "reasoning" but doesn't expose tokens |

---

## Multi-Step Tool Execution

Aligned with Vercel AI SDK's `steps[]` concept. A single user prompt may trigger multiple LLM round-trips (steps), each with its own tool calls and results.

```
User message
  └─ Step 1: Assistant thinks → calls Bash
      └─ Tool result → Step 2: Assistant reads output → calls Edit
          └─ Tool result → Step 3: Assistant responds with text
```

In JSONL, each step is a pair of messages (assistant + user/tool). The `parentId` field threads them:

```
msg_001 (user, parentId: null)     "Fix the login page"
msg_002 (assistant, parentId: 001)  [reasoning, tool-call: Bash]
msg_003 (user, parentId: 002)       [tool-result: Bash output]
msg_004 (assistant, parentId: 003)  [reasoning, tool-call: Edit]
msg_005 (user, parentId: 004)       [tool-result: Edit success]
msg_006 (assistant, parentId: 005)  [text: "Done, I fixed the CSS"]
```

The Vercel AI SDK collapses these into `steps[]` on the result object. The unfirehose format keeps them as individual messages for streaming/append-only compatibility but supports reconstructing steps via `parentId` chains.

---

## File Layout Convention

All harnesses should follow this directory structure:

```
~/.{harness}/
├── sessions/                        # or projects/ (Claude Code uses projects/)
│   ├── {project-slug}/
│   │   ├── sessions-index.json      # session metadata index
│   │   ├── {session-uuid}.jsonl     # session transcript
│   │   └── memory/
│   │       └── MEMORY.md            # persistent agent memory
│   └── ...
└── config.json                      # harness-specific config
```

### JSONL Stream Structure

```
Line 1: {"$schema": "unfirehose/1.0", "type": "session", ...}     # session header (optional)
Line 2: {"type": "message", "role": "user", ...}                   # first user message
Line 3: {"type": "message", "role": "assistant", ...}              # first assistant response
Line 4: {"type": "message", "role": "user", ...}                   # tool result
...
Line N: {"type": "message", "role": "system", "subtype": "session_end"}
```

The session header line is optional. If absent, session metadata is inferred from the first message and the `sessions-index.json`.

---

## Ingestion Pipeline

```
JSONL file (any harness)
  │
  ├─ Claude Code / Fetch: direct read
  ├─ uncloseai: normalize via uncloseai-adapter.ts
  ├─ Gemini: normalize via gemini-adapter.ts (planned)
  ├─ hermes-agent: normalize via hermes-adapter.ts (planned)
  └─ Codex: normalize via codex-adapter.ts (planned)
  │
  ▼
Unified message format
  │
  ├─ insertMessage() → messages table (dedup on message UUID)
  ├─ insertContentBlocks() → content_blocks table (position-ordered)
  ├─ extractTodos() → todos table (from TaskCreate/TaskUpdate/TodoWrite)
  ├─ updateUsageMinutes() → usage_minutes table (per-minute rollups)
  └─ sanitizePII() → pii_replacements table (hashes only)
```

**Idempotent**: message UUID dedup + byte offset tracking = safe re-ingestion. Terminal todo statuses (`completed`, `obsolete`) are sticky across re-ingestion.

---

## Writing a Harness Adapter

To add support for a new harness:

1. **`packages/core/{harness}-paths.ts`** — Where session files live on disk
2. **`packages/core/{harness}-adapter.ts`** — Normalize native entries to the canonical message format
3. **Add ingestion logic to `packages/core/db/ingest.ts`** — Directory scanning and batch processing

The adapter function signature:

```typescript
import type { SessionEntry } from '@unfirehose/core/types';

export function normalizeEntry(raw: unknown): SessionEntry | null {
  // Map native harness fields → canonical format
  // Return null for unmapped/irrelevant event types
}
```

### Minimum viable adapter

The adapter must produce entries with:
- `type`: `"user"`, `"assistant"`, or `"system"`
- `message.role`: matching the type
- `message.content`: array of content blocks
- `timestamp`: ISO 8601
- `sessionId`: unique session identifier

Everything else (`usage`, `parentUuid`, `model`, `gitBranch`) is optional. Missing fields degrade gracefully — analytics pages show "unknown" for missing models, zero for missing token counts.

---

## Vercel AI SDK Compatibility

The unfirehose schema is designed to round-trip with Vercel AI SDK types. Here's the mapping:

| Vercel AI SDK | Unfirehose | Notes |
|---|---|---|
| `CoreMessage` | `message` | Same 4 roles |
| `TextPart` | `{ type: "text" }` | Identical |
| `ReasoningPart` | `{ type: "reasoning" }` | Identical |
| `ToolCallPart` | `{ type: "tool-call" }` | Identical field names |
| `ToolResultPart` | `{ type: "tool-result" }` | Identical field names |
| `ImagePart` | `{ type: "image" }` | Identical |
| `FilePart` | `{ type: "file" }` | Identical |
| `LanguageModelUsage` | `usage` | Identical structure |
| `tool()` | `tool_definition` | `inputSchema` = `parameters` |
| `StepResult` | reconstructed from `parentId` chain | JSONL is flat; steps are reconstructed |
| `GenerateTextResult` | full session | Session = all steps combined |

### Converting to/from Vercel AI SDK

```typescript
// Unfirehose message → Vercel AI SDK CoreMessage
function toVercelMessage(msg: UnfirehoseMessage): CoreMessage {
  return {
    role: msg.role,
    content: msg.content.map(block => {
      switch (block.type) {
        case 'text': return { type: 'text', text: block.text };
        case 'reasoning': return { type: 'reasoning', text: block.text };
        case 'tool-call': return {
          type: 'tool-call',
          toolCallId: block.toolCallId,
          toolName: block.toolName,
          input: block.input,
        };
        case 'tool-result': return {
          type: 'tool-result',
          toolCallId: block.toolCallId,
          toolName: block.toolName,
          output: block.output,
          isError: block.isError,
        };
        default: return { type: 'text', text: '' };
      }
    }),
  };
}
```

---

## Anthropic API ↔ Unfirehose Field Map

Since Claude Code is the reference implementation:

| Anthropic API | Unfirehose | Notes |
|---|---|---|
| `content[].type: "thinking"` | `content[].type: "reasoning"` | Renamed for cross-provider neutrality |
| `content[].thinking` | `content[].text` | Unified text field |
| `content[].type: "tool_use"` | `content[].type: "tool-call"` | Hyphenated, matches Vercel SDK |
| `content[].id` | `content[].toolCallId` | Explicit name |
| `content[].name` | `content[].toolName` | Explicit name |
| `content[].type: "tool_result"` | `content[].type: "tool-result"` | Hyphenated |
| `content[].tool_use_id` | `content[].toolCallId` | Unified linking field |
| `usage.input_tokens` | `usage.inputTokens` | camelCase |
| `usage.output_tokens` | `usage.outputTokens` | camelCase |
| `usage.cache_read_input_tokens` | `usage.inputTokenDetails.cacheReadTokens` | Nested |
| `usage.cache_creation_input_tokens` | `usage.inputTokenDetails.cacheWriteTokens` | Nested |
| `stop_reason` | `stopReason` | camelCase |

## OpenAI API ↔ Unfirehose Field Map

For hermes-agent, Codex, and any OpenAI-compatible harness:

| OpenAI API | Unfirehose | Notes |
|---|---|---|
| `messages[].role` | `role` | Direct |
| `messages[].content` (string) | `content: [{ type: "text", text }]` | Wrap in block |
| `messages[].tool_calls[].function.name` | `content[].toolName` | Flatten |
| `messages[].tool_calls[].function.arguments` | `content[].input` | JSON parse |
| `messages[].tool_calls[].id` | `content[].toolCallId` | Direct |
| `messages[].role: "tool"` | `role: "tool"` | Direct |
| `messages[].tool_call_id` | `content[].toolCallId` | Direct |
| `usage.prompt_tokens` | `usage.inputTokens` | Rename |
| `usage.completion_tokens` | `usage.outputTokens` | Rename |
| `finish_reason: "tool_calls"` | `stopReason: "tool_calls"` | camelCase |

## Google AI ↔ Unfirehose Field Map

For Gemini CLI:

| Google AI | Unfirehose | Notes |
|---|---|---|
| `parts[].text` | `content[].text` | `parts` → `content` |
| `parts[].functionCall.name` | `content[].toolName` | Flatten |
| `parts[].functionCall.args` | `content[].input` | Rename |
| `parts[].functionResponse.name` | `content[].toolName` | Flatten |
| `parts[].functionResponse.response` | `content[].output` | Rename |
| `usageMetadata.promptTokenCount` | `usage.inputTokens` | Rename |
| `usageMetadata.candidatesTokenCount` | `usage.outputTokens` | Rename |
| `usageMetadata.cachedContentTokenCount` | `usage.inputTokenDetails.cacheReadTokens` | Nest |

---

## Database Normalization

The canonical JSON format maps to SQLite as documented in `docs/database.md`. Key transformations:

| JSON Field | DB Column | Table |
|---|---|---|
| `message.id` | `message_uuid` | messages |
| `message.parentId` | `parent_uuid` | messages |
| `message.role` | `type` | messages |
| `message.content[]` | rows in content_blocks | content_blocks |
| `content[].type: "reasoning"` | `block_type: "thinking"` | content_blocks |
| `content[].type: "tool-call"` | `block_type: "tool_use"` | content_blocks |
| `content[].type: "tool-result"` | `block_type: "tool_result"` | content_blocks |
| `content[].text` | `text_content` | content_blocks |
| `content[].toolName` | `tool_name` | content_blocks |
| `content[].input` | `tool_input` (JSON string) | content_blocks |
| `content[].toolCallId` | `tool_use_id` | content_blocks |
| `usage.inputTokens` | `input_tokens` | messages |
| `usage.outputTokens` | `output_tokens` | messages |
| `usage.inputTokenDetails.cacheReadTokens` | `cache_read_tokens` | messages |
| `usage.inputTokenDetails.cacheWriteTokens` | `cache_creation_tokens` | messages |

Note: the database uses `snake_case` and Anthropic-era names (`thinking`, `tool_use`) internally. The canonical JSON uses `camelCase` and provider-neutral names (`reasoning`, `tool-call`). The ingestion layer handles the mapping.
