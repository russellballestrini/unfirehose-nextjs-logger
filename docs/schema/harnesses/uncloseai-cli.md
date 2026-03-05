# uncloseai-cli — Harness Format

**Provider**: Local (Hermes 3 via llama.cpp)
**Status**: Supported (adapter live)
**Adapter**: `packages/core/uncloseai-adapter.ts`

## File Location

```
~/.uncloseai/sessions/{project-slug}/{session-uuid}.jsonl
```

## Native Format

uncloseai-cli uses an event-based format rather than the message-based format of Claude Code. Each line is a typed event:

### Session Start

```jsonc
{
  "type": "session_start",
  "timestamp": "2026-03-05T10:42:45.161Z",
  "prompt": "Fix the login page",
  "model": "hermes-3-8b",
  "session_id": "abc123"
}
```

### Assistant Response

```jsonc
{
  "type": "assistant",
  "timestamp": "2026-03-05T10:42:51.432Z",
  "content": "I'll fix the login page. Let me check the files first.",
  "session_id": "abc123"
}
```

### Tool Call

```jsonc
{
  "type": "tool_call",
  "timestamp": "2026-03-05T10:42:52.100Z",
  "tool": "bash",
  "args": "{\"command\": \"ls src/\"}",
  "session_id": "abc123"
}
```

### Tool Result

```jsonc
{
  "type": "tool_result",
  "timestamp": "2026-03-05T10:42:52.500Z",
  "tool": "bash",
  "output": "login.css\napp.js",
  "session_id": "abc123"
}
```

### Session End

```jsonc
{
  "type": "session_end",
  "timestamp": "2026-03-05T11:00:00.000Z",
  "session_id": "abc123"
}
```

## Field Mapping → Unfirehose

| uncloseai Event | Unfirehose Message | Transform |
|---|---|---|
| `session_start` | `role: "user"`, text from `prompt` | event → message |
| `assistant` | `role: "assistant"`, text from `content` | event → message |
| `tool_call` | `role: "assistant"`, `tool-call` block | event → message + block |
| `tool_result` | `role: "user"`, `tool-result` block | event → message + block |
| `session_end` | `role: "system"`, `subtype: "session_end"` | event → message |

### Details

- Model hardcoded to `hermes-3-8b` (or whatever model is configured)
- Token usage zeroed (not tracked by uncloseai-cli)
- Provider set to `local`
- No thinking blocks (Hermes 3 doesn't have extended thinking)
- Tool names are lowercase (`bash`, `read_file`) — adapter normalizes to canonical names

## Tools

| uncloseai Tool | Canonical Name |
|----------------|---------------|
| `bash` | `Bash` |
| `read_file` | `Read` |
| `write_file` | `Write` |
| `edit_file` | `Edit` |
| `list_dir` | `Glob` |
| `search` | `Grep` |

## Key Differences from Claude Code

| Aspect | Claude Code | uncloseai-cli |
|--------|------------|---------------|
| Format | Message-based | Event-based |
| Content | Block array | Flat string |
| Tool calls | Inline in message | Separate events |
| Token tracking | Full | None |
| Thinking | Full extended thinking | Not supported |
| Models | Claude (cloud) | Hermes 3 (local) |

## Implementing unfirehose/1.0 Natively

When uncloseai-cli adopts unfirehose/1.0, it would:

1. Switch from event types to message roles
2. Use content block arrays instead of flat strings
3. Wrap tool calls in `tool-call` blocks within assistant messages
4. Add `$schema: "unfirehose/1.0"` header
5. Include session envelope as first JSONL line

This eliminates the need for the adapter entirely.
