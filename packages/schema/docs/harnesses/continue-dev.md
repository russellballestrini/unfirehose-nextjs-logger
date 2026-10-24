# Continue.dev — Harness Format

**Provider**: Multi-provider (OpenAI, Anthropic, Ollama, etc.)
**Status**: Supported: ingested from `~/.continue/sessions`
**Adapter**: `packages/core/continue-adapter.ts`, read by `packages/core/db/ingest-foreign.ts`

## Overview

Continue is an open-source coding assistant as a VS Code/JetBrains extension: https://github.com/continuedev/continue

## Session Storage

Continue stores session history in JSON files:

```
~/.continue/sessions/                  # Session storage
~/.continue/config.json                # Configuration
~/.continue/dev_data/                  # Analytics/telemetry data
```

### Session Format

```typescript
// From core/index.d.ts
interface Session {
  sessionId: string;
  title: string;
  workspaceDirectory: string;
  history: ChatHistoryItem[];
}
```

### Message Roles

Continue has **5 roles** (more than most harnesses):

```typescript
type ChatMessageRole = "user" | "assistant" | "thinking" | "system" | "tool";
```

### ChatHistoryItem (wraps messages with metadata)

```typescript
interface ChatHistoryItem {
  message: ChatMessage;
  contextItems: ContextItemWithId[];  // files, search results, etc.
  editorState?: any;
  promptLogs?: PromptLog[];
  toolCallState?: ToolCallState;
  reasoning?: { active: boolean; text: string; startAt: number; endAt?: number; };
}
```

### Tool Calls

```typescript
interface ToolCallDelta {
  id?: string;
  type?: "function";
  function?: { name?: string; arguments?: string; };
}
```

### Thinking Messages

Continue has native thinking support as a distinct role:

```typescript
interface ThinkingChatMessage {
  role: "thinking";
  content: MessageContent;
  signature?: string;          // Anthropic thinking signature
  redactedThinking?: string;
}
```

### Data Export (JSONL)

Continue supports structured data export via config:

```jsonc
// config.json
{
  "data": {
    "destination": "file://~/.continue/export.jsonl"
    // or HTTP endpoint
  }
}
```

Exports `autocomplete`, `chatInteraction`, and other event types in JSONL with schema versioning (0.1.0, 0.2.0).

## Mapping as ingested

Read from `core/index.d.ts`, `core/util/history.ts` and `core/util/paths.ts`
(continuedev/continue main, 2026-10-23). `CONTINUE_GLOBAL_DIR` moves
`~/.continue`, and we follow it. `sessions/sessions.json` is the index
(`dateCreated` is epoch milliseconds as a string); every other
`sessions/<sessionId>.json` is one `Session`.

| Continue | Unfirehose |
|---|---|
| `role: "user"` | `role: "user"`, text blocks |
| `role: "assistant"` | `role: "assistant"`: `item.reasoning.text` as `reasoning`, content as `text`, `toolCalls[]` as `tool-call` (arguments parsed as JSON when they are) |
| `role: "thinking"` | `role: "assistant"`, `reasoning` blocks |
| `role: "tool"` | `role: "user"`, a `tool-result` for `toolCallId` |
| `toolCallStates[].output` | a `tool-result`, only when no `tool` message carries that call |
| `role: "system"` | `role: "system"` |
| `message.usage.promptTokens - promptTokensDetails.cachedTokens` | `usage.inputTokens` |
| `message.usage.completionTokens` | `usage.outputTokens` |
| `promptTokensDetails.cachedTokens` / `cacheWriteTokens` | `cacheReadTokens` / `cacheWriteTokens` |
| `promptLogs[-1].modelTitle`, else `chatModelTitle` | `model` (Continue names models by their configured title) |
| `workspaceDirectory` (a `file://` URI) | the project's cwd; projects are `continue:<encoded cwd>` |
| `history[i]` | message id `continue:<sessionId>:<i>` |
| `contextItems` | not mapped: context, not messages |

A session file is rewritten whole, so it is skipped while its size and mtime
are unchanged and refolded when they move; messages insert by id, so a reread
adds only new turns. The newest turn of a file written in the last 30 seconds
waits a pass, since it may still be streaming. Messages carry no timestamps:
each is stamped with its item's reasoning times when it has them, otherwise
the session's creation time, never earlier than the message before it. A turn
a person edits in place keeps its index, so the stored row is the version we
first saw.

## Key Differences from Claude Code

| Aspect | Claude Code | Continue.dev |
|--------|------------|-------------|
| Format | JSONL (append-only) | JSON (full document) |
| Tool calls | Named function calls | `toolCalls[]` and a `tool` message (older versions: inline edits) |
| Context | Implicit (model sees files) | Explicit `contextItems` |
| Token tracking | Full | Per assistant message, when the provider reports it (`message.usage`) |
| Open source | Yes (CLI) | Yes (extension) |
| IDE | Terminal | VS Code / JetBrains |
