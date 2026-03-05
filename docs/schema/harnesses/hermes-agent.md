# Hermes Agent — Harness Format

**Provider**: Local (Hermes 3 via llama.cpp / Ollama)
**Status**: Documented (adapter planned)
**Adapter**: planned

## Overview

Hermes Agent is a local inference agent powered by Hermes 3 (NousResearch fine-tune of Llama). It runs tool-calling loops against local models and can be orchestrated by Claude Code via the Agent tool or direct shell invocation.

## Session Storage

```
~/.hermes/sessions/{cwd-slug}/{session-uuid}.jsonl
```

Sessions follow the OpenAI chat completions format since Hermes uses the OpenAI-compatible API.

## Native Format

### User Message

```jsonc
{
  "role": "user",
  "content": "Fix the login page CSS"
}
```

### Assistant Message

```jsonc
{
  "role": "assistant",
  "content": "I'll fix the login styles.",
  "tool_calls": [
    {
      "id": "call_abc123",
      "type": "function",
      "function": {
        "name": "shell",
        "arguments": "{\"cmd\": \"cat src/login.css\"}"
      }
    }
  ]
}
```

### Tool Result

```jsonc
{
  "role": "tool",
  "tool_call_id": "call_abc123",
  "content": ".login { color: red; }"
}
```

### Usage (from Ollama/llama.cpp)

```jsonc
{
  "usage": {
    "prompt_tokens": 1234,
    "completion_tokens": 567,
    "total_tokens": 1801
  }
}
```

## Field Mapping → Unfirehose

| Hermes Agent | Unfirehose | Transform |
|---|---|---|
| `role: "user"` | `role: "user"` | direct |
| `role: "assistant"` | `role: "assistant"` | direct |
| `role: "tool"` | embedded in user message | restructure |
| `content` (string) | `content: [{type: "text", text}]` | wrap in block |
| `tool_calls[].function.name` | `content[].toolName` | extract + rename |
| `tool_calls[].function.arguments` | `content[].input` | JSON parse |
| `tool_calls[].id` | `content[].toolCallId` | rename |
| `tool_call_id` | `content[].toolCallId` | rename (tool results) |
| `usage.prompt_tokens` | `usage.inputTokens` | rename |
| `usage.completion_tokens` | `usage.outputTokens` | rename |

## Tools

Hermes Agent uses a minimal tool set:

| Hermes Tool | Canonical Name |
|-------------|---------------|
| `shell` | `Bash` |
| `read_file` | `Read` |
| `write_file` | `Write` |
| `search` | `Grep` |

## Thinking Support

Hermes 3 supports `<thinking>` XML tags in output but these are not structured as separate content blocks. The adapter should extract `<thinking>...</thinking>` sections from assistant content and emit them as `{ type: "reasoning", text }` blocks.

## Cross-Harness Delegation

Hermes Agent is commonly invoked by Claude Code:

```bash
# Claude Code spawns hermes-agent via Bash tool
hermes-agent --prompt "Fix the CSS" --cwd /home/fox/git/myproject
```

When `UNFIREHOSE_PARENT_SESSION` is set in the environment, the hermes-agent session should record `delegatedFrom` in its first JSONL entry, linking it to the parent Claude Code session.

## Key Differences from Claude Code

| Aspect | Claude Code | Hermes Agent |
|--------|------------|--------------|
| Format | JSONL (native) | JSONL (OpenAI-compat) |
| Content | Block array | String + separate tool_calls |
| Tool results | `tool_result` in user msg | Separate `tool` role msg |
| Thinking | Structured blocks | XML in content string |
| Token tracking | Full | Local model stats only |
| Model | Claude (cloud) | Hermes 3 (local) |
| Sandbox | User-approved | Configurable |

## Canonical Event Log

Since Hermes Agent uses OpenAI format (not native unfirehose/1.0), the ingestion pipeline generates a canonical event log at:

```
~/.unfirehose/canonical/hermes/{project-slug}/{session-uuid}.jsonl
```

This normalized JSONL can be consumed by any unfirehose/1.0-compatible tool without needing the hermes-specific adapter.
