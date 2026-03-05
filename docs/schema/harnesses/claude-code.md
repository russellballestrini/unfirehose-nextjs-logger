# Claude Code — Harness Format

**Provider**: Anthropic
**Status**: Reference implementation (the schema was designed around this format)
**Adapter**: Identity (native format is the baseline)

## File Location

```
~/.claude/projects/{project-slug}/{session-uuid}.jsonl
```

Each session is a single JSONL file. Project slug is the filesystem path with separators replaced by hyphens.

## Native Format

Claude Code logs every API message exchange as JSONL entries with three top-level types:

### User Entry

```jsonc
{
  "type": "user",
  "uuid": "d5531d63-b26b-4f34-a8ec-186ae1b75fad",
  "parentUuid": "f036f889-48c8-40d4-a1ee-d3a77d3cdde3",
  "timestamp": "2026-03-05T10:42:45.161Z",
  "message": {
    "role": "user",
    "content": [
      { "type": "text", "text": "Fix the login page" }
      // tool_result blocks also appear here
    ]
  },
  "sessionId": "4e0f77f7-1b16-4adc-88bd-37f46790e2ae",
  "cwd": "/home/fox/git/myproject",
  "version": "2.1.69",
  "isSidechain": false
}
```

### Assistant Entry

```jsonc
{
  "type": "assistant",
  "uuid": "f036f889-48c8-40d4-a1ee-d3a77d3cdde3",
  "parentUuid": "d5531d63-b26b-4f34-a8ec-186ae1b75fad",
  "timestamp": "2026-03-05T10:42:51.432Z",
  "message": {
    "role": "assistant",
    "model": "claude-opus-4-6",
    "content": [
      { "type": "thinking", "thinking": "The user wants me to fix..." },
      { "type": "text", "text": "I found the issue." },
      { "type": "tool_use", "id": "toolu_01ABC", "name": "Bash", "input": { "command": "ls" } }
    ],
    "stop_reason": "tool_use",
    "usage": {
      "input_tokens": 3,
      "output_tokens": 78,
      "cache_read_input_tokens": 12233,
      "cache_creation_input_tokens": 0
    }
  }
}
```

### System Entry

```jsonc
{
  "type": "system",
  "subtype": "turn_duration",
  "timestamp": "2026-03-05T10:42:51.432Z",
  "durationMs": 5432,
  "sessionId": "4e0f77f7-..."
}
```

## Content Block Types

| Native Type | Native Fields | Canonical Type | Transform |
|---|---|---|---|
| `text` | `text` | `text` | identity |
| `thinking` | `thinking` (not `text`) | `reasoning` | rename type + field |
| `tool_use` | `id`, `name`, `input` | `tool-call` | rename all fields |
| `tool_result` | `tool_use_id`, `content` | `tool-result` | rename + restructure |

## Field Mapping → Unfirehose

| Claude Code | Unfirehose | Transform |
|---|---|---|
| `type` | `role` | `user`→`user`, `assistant`→`assistant`, `system`→`system` |
| `uuid` | `id` | rename |
| `parentUuid` | `parentId` | rename |
| `isSidechain` | `sidechain` | rename |
| `message.content[].type: "thinking"` | `content[].type: "reasoning"` | rename |
| `message.content[].thinking` | `content[].text` | rename field |
| `message.content[].type: "tool_use"` | `content[].type: "tool-call"` | rename + remap |
| `message.content[].id` | `content[].toolCallId` | rename |
| `message.content[].name` | `content[].toolName` | rename |
| `message.content[].type: "tool_result"` | `content[].type: "tool-result"` | rename + remap |
| `message.content[].tool_use_id` | `content[].toolCallId` | rename |
| `message.usage.input_tokens` | `usage.inputTokens` | camelCase |
| `message.usage.output_tokens` | `usage.outputTokens` | camelCase |
| `message.usage.cache_read_input_tokens` | `usage.inputTokenDetails.cacheReadTokens` | nest + camelCase |
| `message.usage.cache_creation_input_tokens` | `usage.inputTokenDetails.cacheWriteTokens` | nest + camelCase |
| `message.stop_reason` | `stopReason` | camelCase |
| `version` | `harnessVersion` | rename |

## Tools Available

Claude Code exposes these tools to the model:

| Tool | Purpose |
|------|---------|
| `Bash` | Shell command execution |
| `Read` | Read file contents |
| `Write` | Create/overwrite files |
| `Edit` | Surgical string replacement in files |
| `Glob` | Find files by pattern |
| `Grep` | Search file contents (ripgrep) |
| `WebFetch` | HTTP requests |
| `WebSearch` | Web search |
| `Agent` | Spawn subagent |
| `AskUserQuestion` | Prompt human for input |
| `TodoWrite` | Create/update todos |
| `NotebookEdit` | Edit Jupyter notebooks |
| `Skill` | Invoke registered skills |

## Thinking Blocks

Claude Code has full extended thinking support. Thinking blocks include a signature for verification:

```jsonc
{
  "type": "thinking",
  "thinking": "Let me analyze the login page CSS...",
  "thinking_signature": "ErUB..." // optional verification signature
}
```

These map to `{ type: "reasoning", text: "...", signature: "..." }` in canonical format.

## Session Index

Claude Code maintains a `sessions-index.json` per project with session metadata (UUIDs, first prompts, timestamps). The ingestion pipeline reads this for session envelope data when JSONL files don't have a session header line.
