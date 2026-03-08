# Todos System

Cross-session task tracker that aggregates todos from Claude Code sessions across all projects. Supports three tool sources: `TaskCreate`, `TaskUpdate`, `TodoWrite`. Also supports manual task injection via the UI.

## Data Flow

1. **Ingestion**: During JSONL ingestion, `tool_use` blocks with `tool_name` in (`TaskCreate`, `TaskUpdate`, `TodoWrite`) are extracted from `content_blocks` and inserted into the `todos` table.
2. **Backfill**: `scripts/backfill-todos.ts` processes existing `content_blocks` for repos ingested before todo extraction was added. Deletes existing todos (events first for FK), then replays all `TaskCreate` -> `TaskUpdate` -> `TodoWrite` in timestamp order.
3. **Manual creation**: `POST /api/todos` with `{ content, projectId?, source }` creates a todo with `source='manual'`.

## Database Tables

### `todos`

| Column | Type | Notes |
|---|---|---|
| project_id | FK | links to projects |
| session_id | FK | links to sessions |
| external_id | TEXT | task ID from the agent tool call |
| content | TEXT | task description |
| status | TEXT | `pending`, `in_progress`, `completed` |
| active_form | TEXT | present-continuous label shown during in_progress |
| source | TEXT | `claude`, `manual`, `fetch` |
| source_session_uuid | TEXT | originating session UUID |
| estimated_minutes | INTEGER | time estimate, nullable |
| created_at | TEXT | timestamp from original message |
| updated_at | TEXT | last status change |
| completed_at | TEXT | set when status becomes `completed` |

UNIQUE constraint on `(project_id, session_id, external_id)` for dedup.

### `todo_events`

Audit trail for status changes.

| Column | Type | Notes |
|---|---|---|
| todo_id | FK | links to todos |
| old_status | TEXT | previous status |
| new_status | TEXT | new status |
| event_at | TEXT | timestamp of change |

### `todo_attachments`

File attachments for todos. Content-addressed by SHA-256.

| Column | Type | Notes |
|---|---|---|
| id | INTEGER | primary key |
| todo_id | FK | links to todos |
| filename | TEXT | original filename |
| mime_type | TEXT | MIME type (e.g. `image/png`) |
| size_bytes | INTEGER | file size in bytes |
| hash | TEXT | SHA-256 content hash (unique) |
| created_at | TEXT | upload timestamp |

UNIQUE constraint on `hash` for content-addressed dedup.

## API Endpoints

### `GET /api/todos`

List todos with optional filters.

```
?project=name&status=pending,in_progress&source=claude
```

Returns:

```json
{
  "todos": [...],
  "byProject": { "project-name": [...] },
  "counts": { "pending": 12, "inProgress": 3, "completed": 45, "total": 60 }
}
```

Groups by project, includes session links, capped at 500. Each todo includes an `attachments[]` array.

### `POST /api/todos`

Create a manual todo.

```json
{ "content": "Fix the thing", "projectId": 1, "source": "manual" }
```

Defaults: `source='manual'`, `status='pending'`, `projectId` = first project if not specified. Creates a `todo_event` for the initial status.

### `PATCH /api/todos`

Update a todo.

```json
{ "id": 123, "estimatedMinutes": 30, "status": "completed" }
```

Sets `completed_at` when status becomes `completed`.

### `POST /api/todos/attachments`

Upload files to a todo. Accepts multipart FormData with `todoId` field and one or more `files`. Max 10MB per file. Files are content-addressed by SHA-256 — duplicate uploads are deduped.

### `GET /api/todos/attachments?todoId=N`

List attachments for a todo. Returns array of `{ id, filename, mimeType, sizeBytes, hash, createdAt }`.

### `GET /api/todos/attachments/{hash}`

Serve a file by its SHA-256 hash. Returns the file with appropriate `Content-Type`. Immutable cache headers.

### `DELETE /api/todos/attachments`

Remove an attachment.

```json
{ "id": 123 }
```

Cleans orphaned files from disk when no other todos reference the same hash.

## UI

Page: `src/app/todos/page.tsx`

Two view modes toggled via tabs:

- **Kanban**: 3-column board (Pending / In Progress / Completed) with `TodoCard` components.
- **By Project**: Grouped list with project links, status dots, time estimates.

### Features

- **Task injection**: Text input at top, Enter or Add button, POSTs to `/api/todos`.
- **Time estimates**: Click `?m` on any card to set estimate from presets (5/10/15/30/60/120m).
- **Ticket threshold**: Tasks >15m highlighted yellow with "ticket" badge.
- **Triage summary**: Shows remaining time, quick tasks count, ticket count, unestimated count.
- **Active/All filter**: Active shows `pending` + `in_progress` only.
- **Source badges**: claude (purple), fetch (blue), manual (green).
- **Session links**: Click session name to jump to the session viewer.

## Backfill Script

```bash
npx tsx scripts/backfill-todos.ts
```

- Clears `todo_events` then `todos` (FK order).
- Processes `TaskCreate`: assigns sequential `external_id` per session, uses `m.timestamp` for `created_at`.
- Processes `TaskUpdate`: matches by `(project_id, external_id, source='claude')`, maps `'deleted'` to `'completed'`.
- Processes `TodoWrite`: bulk inserts from todo arrays.
- All timestamps come from the original message, not ingestion time.

## Ticket Workflow Integration

Tasks with `estimated_minutes > 15` are flagged as needing a ticket (see [docs/tickets/README.md](tickets/README.md)). The threshold is configurable via `TICKET_THRESHOLD` constant.
