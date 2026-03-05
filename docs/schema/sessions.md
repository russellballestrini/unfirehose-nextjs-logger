# Sessions Schema

Wraps a sequence of messages. One session per coding task or conversation.

## Canonical Format

```jsonc
{
  "$schema": "unfirehose/1.0",
  "type": "session",
  "id": "4e0f77f7-1b16-4adc-88bd-37f46790e2ae",
  "projectId": "-home-fox-git-myproject",
  "status": "active|closed",
  "createdAt": "2026-03-05T10:42:45.161Z",
  "updatedAt": "2026-03-05T12:31:19.191Z",
  "closedAt": null,

  // Context
  "firstPrompt": "Fix the login page CSS",
  "summary": "",
  "displayName": "Fix login CSS",
  "gitBranch": "main",
  "cwd": "/home/fox/git/myproject",
  "sidechain": false,

  // Harness metadata
  "harness": "claude-code",
  "harnessVersion": "2.1.69",

  // Aggregate stats (optional, for index files)
  "messageCount": 14,
  "totalUsage": {
    "inputTokens": 1200,
    "outputTokens": 4500,
    "inputTokenDetails": { "cacheReadTokens": 89000, "cacheWriteTokens": 3200 }
  }
}
```

## Fields

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `id` | string | yes | Session UUID (v4 for Claude Code, v7 for new harnesses) |
| `projectId` | string | yes | Slug-encoded project path |
| `status` | string | yes | `active` or `closed` |
| `createdAt` | ISO 8601 | yes | Session start time |
| `updatedAt` | ISO 8601 | yes | Last activity time |
| `closedAt` | ISO 8601 | no | When session ended |
| `firstPrompt` | string | no | First user message (for display) |
| `summary` | string | no | Auto-generated or manual summary |
| `displayName` | string | no | Human label |
| `gitBranch` | string | no | Branch at session start |
| `cwd` | string | no | Working directory |
| `sidechain` | boolean | no | True for subagent/parallel sessions |
| `harness` | string | no | Originating harness identifier |
| `harnessVersion` | string | no | Harness version string |
| `messageCount` | number | no | Total messages (for index files) |
| `totalUsage` | Usage | no | Aggregate token usage (for index files) |

## Session Lifecycle

```
CREATED → ACTIVE → CLOSED
                 ↗
     (stale detection)
```

- **Active**: receiving messages, `last_message_at` updated on each
- **Closed**: explicitly ended by harness (`session_end` system message) or stale detection
- **Stale detection**: sessions with no messages for 2+ hours are closed by the ingestion sweep

## In JSONL Files

The session object appears as the first line (header) in the JSONL stream:

```
Line 1: {"$schema": "unfirehose/1.0", "type": "session", "id": "...", ...}
Line 2: {"type": "message", "role": "user", ...}
Line 3: {"type": "message", "role": "assistant", ...}
...
Line N: {"type": "message", "role": "system", "subtype": "session_end"}
```

The session header is optional. If absent, session metadata is inferred from the first message and the `sessions-index.json` file.

## Index Files

Each project directory has a `sessions-index.json` listing all sessions with aggregate stats:

```jsonc
{
  "sessions": [
    {
      "id": "4e0f77f7-...",
      "status": "closed",
      "firstPrompt": "Fix login CSS",
      "createdAt": "2026-03-05T10:42:45Z",
      "messageCount": 14,
      "totalUsage": { "inputTokens": 1200, "outputTokens": 4500 }
    }
  ]
}
```

## Database Mapping

| JSON Field | DB Column | Table |
|---|---|---|
| `id` | `session_uuid` (UNIQUE) | sessions |
| `projectId` | `project_id` (FK → projects) | sessions |
| `status` | `status` | sessions |
| `firstPrompt` | `first_prompt` | sessions |
| `harness` | `cli_version` | sessions |
| `gitBranch` | `git_branch` | sessions |
| `sidechain` | `is_sidechain` | sessions |
| `displayName` | `display_name` | sessions |
| `closedAt` | `closed_at` | sessions |
