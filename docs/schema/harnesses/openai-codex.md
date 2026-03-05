# OpenAI Codex CLI — Harness Format

**Provider**: OpenAI
**Status**: Documented (adapter planned)
**Adapter**: `packages/core/codex-adapter.ts` (planned)

## Overview

OpenAI's Codex CLI is an open-source coding agent: https://github.com/openai/codex

It uses the OpenAI chat completions API format with function calling.

## Native Format

Codex follows the OpenAI message format:

### User Message

```jsonc
{
  "role": "user",
  "content": "Fix the login page"
}
```

### Assistant Message (with tool calls)

```jsonc
{
  "role": "assistant",
  "content": null,
  "tool_calls": [
    {
      "id": "call_abc123",
      "type": "function",
      "function": {
        "name": "shell",
        "arguments": "{\"command\": \"ls src/\"}"
      }
    }
  ]
}
```

### Tool Response

```jsonc
{
  "role": "tool",
  "tool_call_id": "call_abc123",
  "content": "login.css\napp.js"
}
```

### Usage

```jsonc
{
  "usage": {
    "prompt_tokens": 1234,
    "completion_tokens": 567,
    "total_tokens": 1801,
    "prompt_tokens_details": {
      "cached_tokens": 890
    },
    "completion_tokens_details": {
      "reasoning_tokens": 120
    }
  }
}
```

## Field Mapping → Unfirehose

| OpenAI / Codex | Unfirehose | Transform |
|---|---|---|
| `role: "assistant"` | `role: "assistant"` | direct |
| `role: "tool"` | `role: "tool"` | direct |
| `content` (string) | `content: [{ type: "text", text }]` | wrap in block |
| `tool_calls[].function.name` | `content[].toolName` | flatten |
| `tool_calls[].function.arguments` | `content[].input` | JSON parse |
| `tool_calls[].id` | `content[].toolCallId` | direct |
| `tool_call_id` | `content[].toolCallId` | direct |
| `usage.prompt_tokens` | `usage.inputTokens` | rename |
| `usage.completion_tokens` | `usage.outputTokens` | rename |
| `usage.prompt_tokens_details.cached_tokens` | `usage.inputTokenDetails.cacheReadTokens` | nest + rename |
| `usage.completion_tokens_details.reasoning_tokens` | `usage.outputTokenDetails.reasoningTokens` | nest + rename |
| `finish_reason: "tool_calls"` | `stopReason: "tool_calls"` | camelCase |
| `finish_reason: "stop"` | `stopReason: "end_turn"` | normalize |

## Tools

Codex CLI uses a sandboxed execution model:

| Codex Tool | Canonical Name |
|------------|---------------|
| `shell` | `Bash` |
| `read_file` | `Read` |
| `write_file` | `Write` |
| `apply_diff` | `Edit` |
| `list_dir` | `Glob` |

## Thinking Support

OpenAI o-series models (o3, o4-mini) have internal reasoning, but the reasoning text is **not exposed** in the API response. Only `reasoning_tokens` appears in usage stats.

This means Codex sessions have no thought traces extractable for the thinking stream — only a token count of how much reasoning occurred.

## Key Differences from Claude Code

| Aspect | Claude Code | Codex CLI |
|--------|------------|-----------|
| Content format | Block array always | String or null + separate tool_calls |
| Tool calls | Inline `tool_use` blocks | Separate `tool_calls[]` array |
| Tool results | `tool_result` in user message | Separate `tool` role message |
| Thinking | Full text exposed | Token count only |
| Cache tokens | `cache_read_input_tokens` | `prompt_tokens_details.cached_tokens` |
| Sandbox | None (user approved) | Docker container |
