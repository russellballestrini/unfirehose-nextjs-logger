# Todos Schema

Cross-session work items extracted from agent tool calls or created manually.

## Canonical Format

```jsonc
{
  "$schema": "unfirehose/1.0",
  "type": "todo",
  "uuid": "019506a8-7c5f-7000-8000-abcdef012345",  // UUIDv7 (time-ordered)
  "projectId": "-home-fox-git-myproject",
  "sessionId": "4e0f77f7-...",
  "status": "pending|in_progress|completed|obsolete|deleted",
  "content": "Add unit tests for auth module",
  "activeForm": "Add unit tests for the auth module login flow",
  "source": "claude-code|gemini|uncloseai|hermes|fetch|manual",
  "sourceSessionId": "4e0f77f7-...",
  "blockedBy": ["todo:019506b2-..."],
  "estimatedMinutes": 30,
  "createdAt": "2026-03-05T10:42:45.161Z",
  "updatedAt": "2026-03-05T12:00:00.000Z",
  "completedAt": null
}
```

## Fields

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `uuid` | string | yes | UUIDv7 (time-ordered, cross-machine safe) |
| `projectId` | string | yes | Slug-encoded project path |
| `sessionId` | string | no | Originating session UUID |
| `status` | string | yes | Current status (see below) |
| `content` | string | yes | Todo description |
| `activeForm` | string | no | Latest wording (may differ from original) |
| `source` | string | yes | What created it |
| `sourceSessionId` | string | no | Session that created it |
| `blockedBy` | array | no | References to blocking items |
| `estimatedMinutes` | number | no | Time estimate |
| `createdAt` | ISO 8601 | yes | Creation time |
| `updatedAt` | ISO 8601 | yes | Last modification time |
| `completedAt` | ISO 8601 | no | When completed |

## Status Lifecycle

```
PENDING → IN_PROGRESS → COMPLETED
    ↓         ↓             ↑
    └─────────┴── OBSOLETE ─┘
                     ↓
                  DELETED
```

- **pending**: created, not started
- **in_progress**: actively being worked on
- **completed**: done (sticky — re-ingestion cannot reopen)
- **obsolete**: no longer relevant (sticky)
- **deleted**: soft-deleted from UI (filtered from all queries)

**Terminal statuses**: `completed`, `obsolete`, and `deleted` are sticky. Re-ingestion cannot reopen them.

## Todo Events (Audit Log)

Every status change is logged:

```jsonc
{
  "$schema": "unfirehose/1.0",
  "type": "todo_event",
  "todoUuid": "019506a8-...",
  "oldStatus": "pending",
  "newStatus": "in_progress",
  "messageId": "msg_019abc...",
  "eventAt": "2026-03-05T11:00:00.000Z"
}
```

## Extraction Sources

Todos are extracted from multiple harnesses during ingestion:

| Source | How Detected | Tool Name |
|--------|-------------|-----------|
| Claude Code | `TodoWrite` tool calls | `TodoWrite` |
| Claude Code | `TaskCreate`, `TaskUpdate` tool calls | `TaskCreate` |
| uncloseai-cli | `session_start` events with task lists | Event parsing |
| Fetch | Same as Claude Code | `TodoWrite` |
| Manual | Created via `/api/todos` POST | API |

## UUIDv7

All todos use UUIDv7 for identity:
- **Time-ordered**: 48-bit millisecond timestamp prefix → efficient B-tree inserts
- **Human-scannable**: creation time visible in the UUID
- **Cross-machine safe**: random suffix prevents collisions in distributed sync

## Ticket Threshold

- **Under 15 minutes**: just do it, no ticket needed
- **Over 15 minutes**: create a ticket in `docs/tickets/NNNN-slug.md`
- **Blocked**: create a ticket with `blocked` status

## API

```bash
# Get todo landscape
curl localhost:3000/api/todos/summary

# Actionable work for a project
curl "localhost:3000/api/todos/pending?project=-home-fox-git-myproject"

# Quick wins (under 15 minutes)
curl "localhost:3000/api/todos/pending?quick=true&limit=20"

# Create a todo
curl -X POST localhost:3000/api/todos \
  -H 'Content-Type: application/json' \
  -d '{"content": "Fix the thing", "source": "manual"}'

# Delete (soft-delete)
curl -X DELETE localhost:3000/api/todos \
  -H 'Content-Type: application/json' \
  -d '{"id": 123}'

# Bulk operations
curl -X PATCH localhost:3000/api/todos/bulk \
  -H 'Content-Type: application/json' \
  -d '{"ids": [1,2,3], "status": "completed"}'
```

## Database Mapping

| JSON Field | DB Column | Table |
|---|---|---|
| `uuid` | `uuid` (UNIQUE) | todos |
| `projectId` | `project_id` (FK) | todos |
| `sessionId` | `session_id` (FK) | todos |
| `status` | `status` | todos |
| `content` | `content` | todos |
| `activeForm` | `active_form` | todos |
| `source` | `source` | todos |
| `estimatedMinutes` | `estimated_minutes` | todos |
