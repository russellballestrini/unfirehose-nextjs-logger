# Project identity

## Problem

Claude Code, and every other harness we ingest, identifies a project by the **encoded filesystem path** of its working directory:

```
~/git/arborist  →  ~/.claude/projects/-home-fox-git-arborist/<session>.jsonl
```

Rename the repo on disk (`~/git/foo` → `~/git/bar`) and the harness starts writing to a brand-new directory. Without intervention, unfirehose creates a brand-new project row, losing continuity with everything that came before. A cascade follows: the same rename creates a dupe in every harness slot we track (base claude, subagents, uncloseai, fetch, ...).

We treat this as an **upstream defect we will outlast.** unfirehose derives project identity from something stable, not from the harness's choice of directory name.

## Identity model

Each project is identified by a tuple computed from `cwd` at ingest time:

| field | source | role |
|---|---|---|
| `root_commit_hash` | `git rev-list --max-parents=0 HEAD` | primary identity — survives renames, clones, mirrors |
| `origin_url` | `git config --get remote.origin.url` | fork tiebreaker — same root + different origin = different project |
| `remotes_json` | all `remote.*.url` entries | mirror tolerance — overlap on any remote URL counts as a match |
| `last_cwd_seen` | the JSONL's `cwd` field | for debugging / display only |

### Stability of the root commit hash

| event | effect |
|---|---|
| rename `~/git/foo` → `~/git/bar` | same `.git`, same root hash — **identity preserved** |
| clone to another computer | byte-identical commit objects — same root hash — **identity preserved** |
| add new commits | root hash is the *first* commit, unaffected — **identity preserved** |
| fork from upstream | shares root hash with upstream — distinguished by `origin_url` |
| `git filter-repo`, `rebase --root` editing the first commit, full squash | new root hash — **identity lost** (rare and deliberate) |
| brand-new `git init` over existing files | new random root hash — **identity lost** (no history) |
| local-only repo never pushed | no origin; root hash alone identifies it (collisions astronomical) |

### Why not just trust the encoded path?

The encoded path is the harness's *current opinion* about identity. We use it as a label, never as the truth. Multiple encoded paths can map to one project:

```
project #106 = arborist
  aliases:
    -home-fox-git-arborist        (added 2026-04-02, cwd = /home/fox/git/arborist)
    -home-fox-git-foo             (added 2026-06-15, after a rename — same root_commit_hash)
```

## Tables

### `projects`

```sql
CREATE TABLE projects (
  id                  INTEGER PRIMARY KEY,
  name                TEXT UNIQUE NOT NULL,   -- encoded dir name FIRST seen for this project (legacy / display)
  display_name        TEXT NOT NULL,
  path                TEXT,                   -- legacy: first cwd seen
  first_seen          TEXT NOT NULL,
  root_commit_hash    TEXT,                   -- NEW: git rev-list --max-parents=0 HEAD
  origin_url          TEXT,                   -- NEW: git remote get-url origin
  remotes_json        TEXT,                   -- NEW: JSON array of all remote URLs
  last_cwd_seen       TEXT                    -- NEW: most recent cwd observed
);

CREATE INDEX idx_projects_root_hash ON projects(root_commit_hash) WHERE root_commit_hash IS NOT NULL;
```

`name` stays UNIQUE for backward compatibility with every query in the codebase that joins on it. It represents the *first* encoded path the project was ever seen under — never updated, even after renames, so existing references keep working.

### `project_aliases`

```sql
CREATE TABLE project_aliases (
  id              INTEGER PRIMARY KEY,
  project_id      INTEGER NOT NULL REFERENCES projects(id),
  encoded_name    TEXT NOT NULL UNIQUE,       -- e.g. -home-fox-git-foo
  cwd             TEXT,                       -- filesystem path at first sight
  harness_prefix  TEXT NOT NULL DEFAULT '',   -- '' for base claude, else 'arborist', 'uncloseai', etc.
  first_seen      TEXT NOT NULL,
  last_seen       TEXT NOT NULL
);
```

One row per encoded directory name ever observed for the project. The same `(root_commit_hash, origin_url)` can show up under many encoded names over time; each gets an alias row.

## Resolution algorithm (`getOrCreateProject`)

Located in `packages/core/db/ingest.ts`. Given `(name, displayName, projectPath?)`:

1. **Direct name match.** Look up `projects.name = ?`. If found, opportunistically backfill `root_commit_hash` / `origin_url` / `last_cwd_seen` from the current cwd, then return its id. This is the hot path.
2. **Alias match.** Look up `project_aliases.encoded_name = ?`. If found, bump `last_seen`, return the linked `project_id`.
3. **Identity match.** Compute `gitIdentity(projectPath)`. If it returns a `rootHash`, find projects with the same hash *within the same harness slot* (a `prefix:` namespace, or no prefix for base claude). Confirm with origin/remote overlap. If matched, register the new encoded name as an alias and return the matched id. **This is the rename absorber.**
4. **New project.** Insert a fresh `projects` row with full identity captured, plus a self-alias row for the new encoded name. Return the new id.

### Harness slot isolation

Subagents and other harness wrappers prefix the encoded name with `harness:` (e.g. `arborist:-home-fox-git-arborist`). Identity matching is scoped to one slot at a time — we never merge a base-claude session into an `arborist:` subagent project even when they share a root hash. Sessions about the same repo from different harnesses stay separate by design; they describe different *kinds* of work.

### Fork handling

Two repos forked from the same upstream share `root_commit_hash`. The identity match in step 3 requires either:

- exact `origin_url` equality, or
- overlap in `remotes_json` arrays (handles mirrors with different `origin` choices), or
- both sides have zero remotes (both local-only).

A fork with its own distinct `origin` correctly creates a separate project row.

## Captured automatically

- **At ingest time** for every project dir we read, by spawning `git rev-list` + `git config --get-regexp remote\..*\.url` against the cwd. Results are memoized per ingest pass; cache clears at the top of `ingestAll()`.
- **For renamed-away dirs** where the old cwd no longer exists on disk: identity stays null. The orphan row persists but will not silently merge with anything. Reconciling old orphans is a separate one-shot, not the prevention path.
- **For non-git directories**: identity stays null and we fall back to the historical path-based identity. Renaming a non-git dir still creates a dupe; we accept that.

## What this fixes — and what it does not

| case | before | after |
|---|---|---|
| `~/git/foo` → `~/git/bar` rename, future sessions | new project row, history split | sessions attach to existing row via root-hash match |
| clone of the same repo on a second machine | separate project rows per machine | one project row, sessions from all machines |
| `git clone` of one's own fork | new project row | new project row (different origin) — correct |
| repo with no git history | new project row on every move | new project row on every move (unchanged) |
| existing dupes already in the DB (e.g. `aborist` vs `arborist`) | two rows | still two rows — retrospective merge is a separate ticket (4003) |

## Future work

- A `/projects/reconcile` UI to merge already-existing dupes (manual confirmation per group). Ticket: `docs/tickets/4003-project-rename-reconciliation.md`.
- A way to capture identity for native-harness JSONL whose slug doesn't resolve via `resolveProjectPath` — peek the first `cwd` field from any message instead.
