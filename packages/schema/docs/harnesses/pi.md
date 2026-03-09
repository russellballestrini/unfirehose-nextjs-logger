# pi — Harness Format

**Provider**: Multi-provider (OpenAI, Anthropic, Google)
**Status**: Researched (extension-based adapter proposed)
**Adapter**: Extension — `@unturf/unfirehose-extension-pi` (proposed)
**Source**: https://github.com/badlogic/pi-mono/tree/main/packages/coding-agent

## Overview

`pi` (`@mariozechner/pi-coding-agent`) is a minimal, aggressively extensible terminal coding agent by Mario Zechner (badlogic). Similar in role to Claude Code, agnt, or aider — reads your codebase, makes tool calls, talks to LLMs. The core is deliberately thin; sub-agents, plan mode, MCP, git checkpointing are all extensions.

Part of the pi-mono monorepo which also includes `pi-ai` (unified multi-provider LLM API), `pi-agent-core` (agent runtime), `pi-mom` (Slack bot), `pi-tui` (terminal UI), `pi-web-ui` (web components), and `pi-pods` (vLLM pod manager).

## File Location

```
~/.pi/agent/sessions/{working-dir-slug}/{session-id}.jsonl
```

Sessions are JSONL files with tree structure. Each entry has `id` and `parentId` fields enabling in-place branching without creating new files.

## Native Format

pi stores sessions as JSONL natively. The `--mode json` flag outputs all events as JSON lines. The `--mode rpc` flag uses strict LF-delimited JSONL framing for RPC over stdin/stdout.

Messages include tool calls and results, notifications, and errors. Compaction summarizes older messages but the full history remains in the JSONL file.

### Output Modes

| Mode | Description |
|------|-------------|
| Interactive (default) | Terminal UI with differential rendering |
| `-p` / `--print` | Print response and exit |
| `--mode json` | All events as JSON lines |
| `--mode rpc` | RPC over stdin/stdout (JSONL framing) |

## Configuration

| Resource | Global | Project |
|----------|--------|---------|
| Context | `~/.pi/agent/AGENTS.md` | `.pi/` directory |
| System prompt | `~/.pi/agent/SYSTEM.md` | `.pi/SYSTEM.md` |
| Settings | `~/.pi/agent/settings.json` | `.pi/settings.json` |
| Extensions | `~/.pi/agent/extensions/` | `.pi/extensions/` |
| Skills | `~/.pi/agent/skills/` | `.pi/skills/` |
| Models | `~/.pi/agent/models.json` | — |
| Keybindings | `~/.pi/agent/keybindings.json` | — |

## Tools

Built-in tools map closely to unfirehose canonical names:

| pi Tool | Canonical Name | Notes |
|---------|---------------|-------|
| `read` | `Read` | File read |
| `write` | `Write` | File write |
| `edit` | `Edit` | File edit |
| `bash` | `Bash` | Shell execution |
| `grep` | `Grep` | Content search |
| `find` | `Glob` | File search |
| `ls` | `ListDir` | Directory listing |

Extensions register custom tools via `pi.registerTool()`.

## Field Mapping → Unfirehose

| pi Element | Unfirehose | Transform |
|---|---|---|
| Session JSONL file | Session header | Extract session ID, working dir → projectId |
| `id` / `parentId` per entry | `id` / `parentId` on messages | Direct map (may need UUIDv7 normalization) |
| User messages | `role: "user"`, `content: [{type: "text"}]` | Extract content |
| Assistant messages | `role: "assistant"`, `content: [...]` | Map content blocks |
| Tool calls | `content: [{type: "tool-call"}]` | Map tool name to canonical |
| Tool results | `content: [{type: "tool-result"}]` | Extract output |
| `--mode json` events | Stream ingestion | Already JSONL, map fields |

## Extension-Based Adapter

pi's extension system is the ideal adoption path. Rather than modifying pi core, an unfirehose extension hooks into the agent lifecycle:

```typescript
// ~/.pi/agent/extensions/unfirehose.ts
export default function (pi: ExtensionAPI) {
  // Write unfirehose/1.0 session header on start
  pi.on("session_start", async (event, ctx) => {
    appendJSONL({ $schema: "unfirehose/1.0", type: "session", ... });
  });

  // Mirror each tool call as unfirehose message
  pi.on("tool_call", async (event, ctx) => {
    appendJSONL({ $schema: "unfirehose/1.0", type: "message", ... });
  });

  // Capture usage/metrics from assistant responses
  pi.on("response", async (event, ctx) => {
    appendJSONL({ $schema: "unfirehose/1.0", type: "message", role: "assistant", ... });
  });
}
```

This writes a parallel unfirehose/1.0 JSONL stream alongside pi's native session file, ready for unfirehose ingestion with zero adapter overhead.

## Thinking Support

pi supports configurable thinking levels via `settings.json`. Thinking content would map to `content: [{type: "reasoning"}]` blocks.

## Session Management

- `pi -c` — Continue most recent session
- `pi -r` — Browse past sessions
- `pi --no-session` — Ephemeral mode (no persistence)
- `pi --session <path>` — Use specific session file or ID
- `/tree` — Revisit full conversation tree including compacted messages

## Key Differences from Claude Code

| Aspect | Claude Code | pi |
|--------|------------|-----|
| Format | JSONL | JSONL (native) |
| Architecture | Monolithic core | Extension-based (thin core) |
| Sub-agents | Built-in | Extension |
| MCP | Built-in | Extension |
| Plan mode | Built-in | Extension |
| Session structure | Flat sequence | Tree (id/parentId branching) |
| Providers | Anthropic only | OpenAI, Anthropic, Google |
| Compaction | Automatic | Configurable, preserves full history |
| Distribution | npm (`@anthropic-ai/claude-code`) | npm (`@mariozechner/pi-coding-agent`) |
