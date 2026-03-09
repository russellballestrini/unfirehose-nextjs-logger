# pi-coding-agent — Harness Format

**Provider**: Multi-provider (OpenAI, Anthropic, Google via `@mariozechner/pi-ai`)
**Status**: Documented (extension adapter planned)
**Adapter**: Extension-based — `@unturf/unfirehose-extension-pi` (planned)
**Repo**: https://github.com/badlogic/pi-mono

## Overview

`pi-coding-agent` is a minimal terminal coding agent by Mario Zechner (badlogic). Part of the pi-mono monorepo which also includes a Slack bot (`pi-mom`), web UI, and vLLM pod manager.

The key architectural difference: almost everything is an extension. Sub-agents, plan mode, MCP integration, git checkpointing, permission gates, custom compaction — all delivered via the extension API. The core agent is deliberately thin.

## File Location

```
~/.pi/agent/history/       # conversation history (JSON)
~/.pi/agent/extensions/    # user extensions
{project-root}/.pi/        # project-level config and extensions
```

## Extension System

pi's extension API hooks into agent lifecycle events:

```typescript
export default function (pi: ExtensionAPI) {
  pi.registerTool({ name: "deploy", ... });
  pi.registerCommand("stats", { ... });
  pi.on("tool_call", async (event, ctx) => { ... });
  pi.on("session_start", async (event, ctx) => { ... });
  pi.on("message", async (event, ctx) => { ... });
}
```

Extensions can:
- Add/replace tools
- Intercept events (`tool_call`, `message`, `session_start`, `session_end`)
- Add sub-agents and plan mode
- Add MCP server integration
- Custom compaction strategies
- Permission gates
- UI widgets

Discovery: `~/.pi/agent/extensions/`, `.pi/extensions/`, or npm packages with `pi.extensions` in manifest.

## Native Format

pi stores conversations as JSON (not JSONL). The format follows OpenAI-style message arrays:

```json
{
  "messages": [
    {
      "role": "user",
      "content": "Fix the login page"
    },
    {
      "role": "assistant",
      "content": "Let me check the CSS...",
      "tool_calls": [
        {
          "id": "tc_01",
          "type": "function",
          "function": {
            "name": "readFile",
            "arguments": "{\"path\": \"src/login.css\"}"
          }
        }
      ]
    },
    {
      "role": "tool",
      "tool_call_id": "tc_01",
      "content": ".login-form { display: block; }"
    }
  ]
}
```

## Field Mapping → Unfirehose

| pi Element | Unfirehose | Transform |
|---|---|---|
| `role: "user"` | `role: "user"`, `content: [{type: "text"}]` | Wrap in content block array |
| `role: "assistant"` | `role: "assistant"`, `content: [{type: "text"}]` | Split text + tool_calls |
| `tool_calls[].function` | `content: [{type: "tool-call"}]` | Map `function.name` → `toolName`, `function.arguments` → `input` |
| `role: "tool"` | `content: [{type: "tool-result"}]` | Map `tool_call_id` → `toolCallId` |
| Extension events | System messages | Map lifecycle hooks to session metadata |

## Adapter Strategy: Extension-First

Instead of parsing pi's history files after the fact, the unfirehose adapter ships as a **pi extension** that hooks lifecycle events in real-time:

```typescript
// @unturf/unfirehose-extension-pi
export default function (pi: ExtensionAPI) {
  let writer: JsonlWriter;

  pi.on("session_start", async (event) => {
    writer = openJsonlWriter(event.sessionId);
    writer.write({ $schema: "unfirehose/1.0", type: "session", ... });
  });

  pi.on("message", async (event) => {
    writer.write({
      $schema: "unfirehose/1.0",
      type: "message",
      role: event.role,
      content: mapContentBlocks(event),
      ...
    });
  });

  pi.on("tool_call", async (event) => {
    // Already captured in message event, but can add metrics
  });

  pi.on("session_end", async () => {
    writer.write({ type: "message", role: "system", subtype: "session_end" });
    writer.close();
  });
}
```

This is the preferred pattern: **zero changes to pi's core**, ships as `npm install @unturf/unfirehose-extension-pi`, drop in `~/.pi/agent/extensions/`.

## Tools

pi tools are registered by extensions. Common built-in tools:

| pi Tool | Canonical Name | Notes |
|---------|---------------|-------|
| `readFile` | `Read` | Read file contents |
| `writeFile` | `Write` | Write/create file |
| `editFile` | `Edit` | Apply edits |
| `executeCommand` | `Bash` | Shell execution |
| `searchFiles` | `Grep` | Content search |
| `listFiles` | `Glob` | File listing |
| `webSearch` | `WebSearch` | Web search (extension) |
| `webFetch` | `WebFetch` | Fetch URL (extension) |

## Thinking Support

Depends on the LLM provider. When using Anthropic models with extended thinking, pi passes through reasoning blocks. The extension adapter would map these to `type: "reasoning"` content blocks.

## Key Differences from Claude Code

| Aspect | Claude Code | pi-coding-agent |
|--------|------------|-----------------|
| Format | JSONL | JSON message arrays |
| Architecture | Monolithic | Extension-based (thin core) |
| Tools | Built-in | Registered by extensions |
| Sub-agents | Built-in | Extension |
| Plan mode | Built-in | Extension |
| MCP | Built-in | Extension |
| Provider | Anthropic only | Multi-provider (OpenAI, Anthropic, Google) |
| Compaction | Fixed strategy | Pluggable via extensions |
| Adapter path | File watcher | Extension hook (real-time) |

## Monorepo Packages

| Package | Purpose |
|---------|---------|
| `@mariozechner/pi-coding-agent` | Terminal coding agent |
| `@mariozechner/pi-ai` | Unified LLM client (OpenAI, Anthropic, Google) |
| `@mariozechner/pi-mom` | Slack bot that delegates to coding agent |
| `@mariozechner/pi-web` | Web UI |
| `@mariozechner/pi-vllm` | vLLM pod manager |
