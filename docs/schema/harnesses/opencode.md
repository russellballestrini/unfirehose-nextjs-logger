# Open Code — Harness Format

**Provider**: Multi-provider (Anthropic, OpenAI, Google, local)
**Status**: Researched (adapter planned)
**Adapter**: `packages/core/opencode-adapter.ts` (planned)

## Overview

Open Code is an open-source alternative to Claude Code: https://github.com/nicepkg/opencode

Terminal-based coding agent with multi-provider support. Similar UX to Claude Code but provider-agnostic.

## File Location

```
~/.opencode/sessions/{session-id}.json
~/.opencode/config.json
```

Sessions are stored as JSON files (not JSONL). Each session contains the full conversation history.

## Native Format

### Session File

```jsonc
{
  "id": "sess_abc123",
  "title": "Fix login page",
  "model": "claude-sonnet-4-20250514",
  "provider": "anthropic",
  "createdAt": "2026-03-05T10:42:45.000Z",
  "updatedAt": "2026-03-05T10:45:12.000Z",
  "messages": [
    {
      "role": "user",
      "content": "Fix the login page CSS"
    },
    {
      "role": "assistant",
      "content": "I'll fix the login page...",
      "tool_calls": [
        {
          "id": "call_001",
          "type": "function",
          "function": {
            "name": "read_file",
            "arguments": "{\"path\": \"login.css\"}"
          }
        }
      ]
    },
    {
      "role": "tool",
      "tool_call_id": "call_001",
      "content": ".login-form { display: block; }"
    }
  ]
}
```

## Field Mapping -> Unfirehose

| Open Code | Unfirehose | Transform |
|---|---|---|
| `id` | `sessionId` | rename |
| `title` | `sessionTitle` | rename |
| `messages[].role: "user"` | `role: "user"` | identity |
| `messages[].role: "assistant"` | `role: "assistant"` | identity |
| `messages[].role: "tool"` | `role: "user"` (tool-result block) | restructure |
| `messages[].content` (string) | `content: [{type: "text", text: ...}]` | wrap in array |
| `messages[].tool_calls[]` | `content: [{type: "tool-call", ...}]` | flatten + rename |
| `tool_calls[].function.name` | `toolName` | extract |
| `tool_calls[].function.arguments` | `toolInput` | JSON.parse |
| `tool_call_id` | `toolCallId` | rename |
| `model` | `model` | identity |
| `provider` | metadata | store as harness metadata |

## Tools

Open Code exposes tools following the OpenAI function-calling convention:

| Tool | Purpose |
|------|---------|
| `read_file` | Read file contents |
| `write_file` | Create/overwrite files |
| `edit_file` | Edit file with search/replace |
| `list_files` | List directory contents |
| `search_files` | Search file contents |
| `execute_command` | Shell command execution |
| `web_search` | Web search |

## Thinking Support

Depends on provider. When using Anthropic models with extended thinking enabled, thinking blocks appear in the response. Open Code passes through provider-native thinking format.

## Adapter Challenges

1. **JSON not JSONL**: Full session in one file — must detect new messages for incremental ingestion
2. **Multi-provider**: Tool call format varies by provider (OpenAI function-calling vs Anthropic tool_use)
3. **No token usage in session files**: Usage data may not be persisted
4. **Config-dependent paths**: Session storage location is configurable

## Key Differences from Claude Code

| Aspect | Claude Code | Open Code |
|--------|------------|-----------|
| Format | JSONL | JSON |
| Structure | Append-only stream | Full document |
| Provider | Anthropic only | Multi-provider |
| Tool format | Anthropic tool_use | OpenAI function-calling |
| Thinking | Native thinking blocks | Provider-dependent |
| Session storage | Per-project directories | Central sessions dir |
