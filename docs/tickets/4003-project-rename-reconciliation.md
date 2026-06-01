# 4003: Project rename reconciliation

**Status:** prevention done, retrospective merge open
**Project:** unfirehose-nextjs-logger
**Estimated:** 120m
**Todo IDs:** (none — proposed by fox)

## Update

Prevention path shipped — new renames are absorbed silently via `root_commit_hash` + `origin_url` matching in `getOrCreateProject`. See `docs/architecture/project-identity.md`. **This ticket now only covers retrospective merge of pre-existing dupes** (e.g. legacy `aborist` vs current `arborist`), which needs a UI + audit table.

## Context

`projects.name` is derived from the encoded JSONL directory (e.g. `-home-fox-git-foo`). When a repo is renamed on disk (`~/git/foo` → `~/git/bar`), Claude Code writes future sessions to a new dir and unfirehose creates a brand-new project row. History continuity breaks.

Confirmed live case: `aborist` → `arborist`. The rename poisoned **three rows** simultaneously — one per harness slot:

| renamed-from | renamed-to | harness |
|---|---|---|
| `-home-fox-git-aborist` (10 sess, 19,633 msgs) | `-home-fox-git-arborist` (2,478 sess, 46,472 msgs) | base claude |
| `aborist:-home-fox-git-aborist` (170 sess) | `arborist:-home-fox-git-arborist` (2,396 sess) | subagent |
| `uncloseai:home-fox-git-aborist` (9 sess) | `uncloseai:home-fox-git-arborist` (14 sess) | uncloseai harness |

The `name` schema is `<harness>:<encoded-path>` for non-claude sources; base claude has no prefix. Reconciliation matches within the same harness slot.

## Plan

### 1. Schema migration

Add to `projects` table:

```sql
root_commit_hash TEXT,   -- first commit of the repo, stable across renames
origin_url       TEXT,   -- `git remote get-url origin` (or null), tiebreaker for forks
last_cwd_seen    TEXT,   -- most recent cwd observed in JSONL — falls behind on rename
```

Index `idx_projects_root_hash` on `(root_commit_hash, origin_url)`.

### 2. Live capture during ingest (`packages/core/db/ingest.ts`)

When a session's first `user`/`assistant` message arrives with a `cwd`:
- If `cwd` is still a live git repo, compute `git rev-list --max-parents=0 HEAD` + `git remote get-url origin`
- `UPDATE projects SET root_commit_hash = ?, origin_url = ?, last_cwd_seen = ? WHERE id = ?` (only when current value is null or stale)

Cache per (cwd → hash, origin) within a single ingest pass to avoid re-spawning git.

### 3. Backfill task

One-shot script: for every existing project row with `path` pointing to a live git dir, populate `root_commit_hash` + `origin_url`. Use to populate `arborist`, but `aborist` will be null (path gone).

### 4. Reconcile API

`GET /api/projects/reconcile/candidates` — returns groups of project rows that share `(root_commit_hash, origin_url)` within the same harness prefix (parsed from `name`). Each group includes message/session/todo counts so a human can see which is the "winner."

`POST /api/projects/reconcile/merge` — body `{ sourceId, targetId }`. In a transaction:
- `UPDATE sessions SET project_id = target WHERE project_id = source`
- `UPDATE todos SET project_id = target WHERE project_id = source`
- `UPDATE usage_minutes SET project_id = target WHERE project_id = source` (handle ON CONFLICT minute,project — sum tokens)
- Update any other project_id FK: `agent_actions`, `project_visibility`, mesh-related tables (audit before coding)
- `DELETE FROM projects WHERE id = source`

Append a row to a new `project_merges` table (id, source_name, target_name, merged_at, source_row_json) so a merge is auditable + future-undoable.

### 5. UI

`/projects/reconcile` page:
- Lists auto-detected candidate groups (matching hash + origin)
- Below: a "manual merge" panel for renamed-away cases (path gone, no hash retrievable). User picks two projects from a dropdown, sees side-by-side stats, confirms merge.
- "Merge into [target]" button per group with confirmation modal.

### 6. CLI fallback

`apps/worker/src/main.ts` (or a new script): `npm run reconcile-candidates` — prints same data as the API for fox to eyeball before merging.

## Tradeoffs / decisions for fox

1. **Forks share root hash.** Adding `origin_url` as a tiebreaker handles 99% of real cases. Edge case: two forks with the same origin (rare). Mitigation: never auto-merge; always require human click.
2. **Worktrees of one repo share both hash + origin** — they'd auto-merge. Usually desired (same project, different branch on disk). If fox wants worktrees kept separate, we'd need a `worktree_path` field too.
3. **Renamed-away cases have no retrievable hash** — fall back to manual merge UI. The cascade pattern (same `display_name` across harness slots) is a strong signal we can surface as a hint.
4. **Merge is destructive** — source row is deleted. The `project_merges` audit table keeps `source_row_json` so we can reverse if needed, but session/todo FKs would need re-pointing manually on undo. Acceptable for now or do we want a soft-delete model?
5. **No auto-merge on first sight** — even with perfect hash+origin match, a merge always requires a human click. Avoids surprise data loss.

## Notes

- Touches: `packages/core/db/schema.ts`, `packages/core/db/ingest.ts`, new `apps/web/src/app/api/projects/reconcile/{candidates,merge}/route.ts`, new `apps/web/src/app/projects/reconcile/page.tsx`.
- Out of scope: detecting renames *before* a new project row is created. We always create-then-reconcile; pre-emptive detection is more fragile.
