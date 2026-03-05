# 3017: UUIDv7 for Todos + Triage Infrastructure

**Status:** all phases complete
**Project:** unfirehose
**Estimated:** 90m
**Todo IDs:** (new — no existing todo covers this)
**Blocked by:** none

## Context

824 pending todos across 22 projects. 770 are stale (7+ days). Current todos use auto-increment `id` which breaks across machines, can't be referenced cross-repo, and fragments SQLite indexes on random inserts. The triage protocol in BLACKOPS.md defines the workflow but the infrastructure doesn't support it yet.

Two gaps:
1. **No stable identity** — auto-increment ids are local to one database. Can't reference `todo:1234` from another repo's ticket because that id means nothing on another machine.
2. **No dependency graph** — `blocked_by` column exists but contains free text. No structured references between todos.

## Plan

### Phase 1: UUIDv7 column (~30m)

1. Add `uuid TEXT` column to `todos` table
2. Create unique index: `CREATE UNIQUE INDEX idx_todos_uuid ON todos(uuid)`
3. Generate UUIDv7 in TypeScript at ingest time — use `created_at` timestamp for the time component on backfill
4. Backfill existing todos: derive v7 UUID from `created_at` + random suffix
5. Update API responses to include `uuid` field
6. Library: either `uuidv7` npm package or hand-roll (it's 20 lines — 48-bit timestamp + 4-bit version + 12-bit rand + 2-bit variant + 62-bit rand)

### Phase 2: Triage API endpoints (~30m)

1. `GET /api/todos/triage?project=X` — returns todos grouped by session, with session context (first message summary, session age, status)
2. `POST /api/todos/bulk-trash` — mark array of UUIDs as obsolete with reason
3. `GET /api/todos/session-context?session=UUID` — returns session mission summary (first 3 assistant messages) for quick triage without LLM
4. Enhance `blocked_by` to accept todo UUIDs: `["todo:019506a8-..."]`

### Phase 3: Dependency graph view (~30m)

1. Parse `blocked_by` references into a DAG
2. `/api/todos/graph` — returns nodes + edges JSON for visualization
3. Page at `/todos/graph` — renders the DAG with Recharts or simple SVG
4. Cross-repo edges: a todo in unsandbox-com blocking one in proxy-unturf-com

## Why UUIDv7 not UUID4

- Time-ordered: first 48 bits = unix ms timestamp. B-tree append-only inserts.
- No index fragmentation: UUID4's randomness causes page splits. v7 is monotonic.
- Human-readable prefix: `019506a8-` tells you the rough creation date.
- Sortable: `ORDER BY uuid` = chronological order. No join to `created_at` needed.
- Standard: RFC 9562 (May 2024). Supported by most UUID libraries.

## Notes

- BLACKOPS.md triage protocol already references this ticket
- The firehose assigns UUID at first ingestion. Re-proposed todos from later sessions keep original UUID.
- Dedup shifts from content-matching to UUID-matching once assigned
