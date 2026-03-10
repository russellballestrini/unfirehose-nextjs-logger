# pi — Harness Format

**Provider**: Multi-provider (OpenAI, Anthropic, Google)
**Status**: Extension implemented
**Adapter**: `extensions/pi-unfirehose.ts` (ships with `@unturf/unfirehose-schema`)
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

## Extension: `pi-unfirehose.ts`

pi's extension API does NOT expose session writer replacement — the session manager is internal. So the extension hooks lifecycle events and writes unfirehose/1.0 JSONL to a separate path that unfirehose ingests. Pi's native session file still exists (pi needs it for `/tree`, compaction, branching), but unfirehose reads from the extension's output — one source of truth per consumer.

### Install

```bash
# copy
cp node_modules/@unturf/unfirehose-schema/extensions/pi-unfirehose.ts ~/.pi/agent/extensions/unfirehose.ts

# or symlink
ln -s $(npm root)/@unturf/unfirehose-schema/extensions/pi-unfirehose.ts ~/.pi/agent/extensions/unfirehose.ts
```

### Output

```
~/.pi/projects/{project-slug}/{session-uuid}.jsonl
```

Configurable via `~/.pi/agent/settings.json`:
```json
{ "unfirehose": { "outputDir": "~/.pi/projects" } }
```

### What it captures

| pi Event | unfirehose/1.0 Output |
|----------|----------------------|
| `session_start` | Session envelope (`type: "session"`) |
| `message_end` (user) | User message with text content blocks |
| `message_end` (assistant) | Assistant message with text, reasoning, tool-call blocks + usage |
| `message_end` (toolResult) | User message with tool-result content blocks |
| `model_select` | System message with `subtype: "model_change"` |
| `session_shutdown` | System message with `subtype: "session_end"` |

### Transforms applied

- `thinking` → `reasoning` (provider-neutral naming)
- `toolCall` → `tool-call` (kebab-case)
- Tool names canonicalized: `read` → `Read`, `bash` → `Bash`, `find` → `Glob`
- Provider normalized: `"anthropic"` / `"google"` / `"openai"` / `"local"`
- Stop reason normalized: `"end_turn"` / `"tool_calls"` / `"length"`
- Session IDs are UUIDv7 (time-ordered)
- Cache token details preserved in `inputTokenDetails`

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
