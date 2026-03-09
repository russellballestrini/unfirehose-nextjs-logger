# uncloseai-cli — Harness Format

**Provider**: Local (Hermes 3 via llama.cpp)
**Status**: Native unfirehose/1.0 (no adapter needed)
**Adapter**: `packages/core/uncloseai-adapter.ts` (legacy event format still supported)

## File Location

```
~/.uncloseai/sessions/{project-slug}/{session-uuid}.jsonl
```

## Native Format (unfirehose/1.0)

As of 2026-03-09, uncloseai-cli emits native unfirehose/1.0 JSONL. Each session file starts
with a session header, followed by message entries with typed content blocks.

### Session Header

```jsonc
{
  "$schema": "unfirehose/1.0",
  "type": "session",
  "id": "4e0f77f7-1b16-4adc-88bd-37f46790e2ae",
  "projectId": "-home-fox-git-myproject",
  "status": "active",
  "createdAt": "2026-03-09T12:00:00.000Z",
  "firstPrompt": "Fix the login page",
  "harness": "uncloseai",
  "cwd": "/home/fox/git/myproject",
  "gitBranch": "main"
}
```

### User Message

```jsonc
{
  "$schema": "unfirehose/1.0",
  "type": "message",
  "id": "msg-uuid",
  "sessionId": "4e0f77f7-...",
  "parentId": null,
  "role": "user",
  "timestamp": "2026-03-09T12:00:01.000Z",
  "content": [{ "type": "text", "text": "Fix the login page" }],
  "harness": "uncloseai",
  "cwd": "/home/fox/git/myproject"
}
```

### Assistant Message (with tool call)

```jsonc
{
  "$schema": "unfirehose/1.0",
  "type": "message",
  "id": "msg-uuid-2",
  "sessionId": "4e0f77f7-...",
  "parentId": "msg-uuid",
  "role": "assistant",
  "timestamp": "2026-03-09T12:00:02.000Z",
  "content": [
    { "type": "text", "text": "Let me check the files." },
    { "type": "tool-call", "toolCallId": "tc-abc123", "toolName": "bash", "input": { "command": "ls src/" } }
  ],
  "model": "adamo1139/Hermes-3-Llama-3.1-8B-FP8-Dynamic",
  "provider": "local",
  "usage": { "inputTokens": 0, "outputTokens": 0 },
  "harness": "uncloseai"
}
```

### Tool Result

```jsonc
{
  "$schema": "unfirehose/1.0",
  "type": "message",
  "id": "msg-uuid-3",
  "sessionId": "4e0f77f7-...",
  "parentId": "msg-uuid-2",
  "role": "user",
  "timestamp": "2026-03-09T12:00:03.000Z",
  "content": [
    { "type": "tool-result", "toolCallId": "tc-abc123", "toolName": "bash", "output": "login.css\napp.js", "isError": false }
  ],
  "harness": "uncloseai"
}
```

### Session End

```jsonc
{
  "$schema": "unfirehose/1.0",
  "type": "message",
  "role": "system",
  "subtype": "session_end",
  "content": [],
  "harness": "uncloseai"
}
```

## Ingestion

Native entries (`$schema: "unfirehose/1.0"`) are normalized via `normalizeNativeEntry()` which
maps unfirehose/1.0 field names to the internal DB format (role→type, id→uuid, tool-call→tool_use, etc).
No canonical JSONL is generated since the source is already canonical.

Legacy event-based entries (without `$schema`) are still supported via `normalizeUncloseaiEntry()`.

## Details

- Model set from `UNCLOSE_MODEL` env var (default: Hermes 3 8B FP8)
- Token usage zeroed (local model, not tracked)
- Provider: `local`
- No thinking/reasoning blocks (Hermes 3 doesn't have extended thinking)
- parentId threading: each message links to the previous via UUID chain
