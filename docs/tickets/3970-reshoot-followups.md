# 3970: Follow-ups surfaced by the landing-page reshoot

**Status:** blocked
**Project:** unfirehose-nextjs-logger
**Estimated:** 120m
**Blocked by:** fox — the npm token in ~/.npmrc no longer authenticates
**Todo IDs:** 3970

## Context

Driving every page headless for screenshots (2026-09-03) exposed what a
human tab-switching never waits for.

| finding | measured | why it matters |
|---|---|---|
| `GET /api/projects` | 7.6s, 7,324 rows | Projects page shows "Loading projects…" for 8s; 7k of those rows are arborist fleet workers (`workspace-agent_worker_*`) |
| `GET /api/scrobble/payload` | 11.6s | Scrobble page blank for 12s on every visit |
| `GET /api/mesh` | 3.8s | SSH probes serialised behind the page |
| Projects list | fleet workers as top-level projects | 7 rows of `workspace-agent_worker_00…` chips before any real repo; hot-projects sidebar is 4/5 workers |
| npm | `@unturf/unfirehose-schema`, `-ui` at 1.1.2; repo 1.2.0 | the Schema page and clients page point people at a package a version behind |
| `lib/unsandbox/emails/unfirehose.ex` | links to `/unfirehose/pricing` (now removed) | cannot fire without a paid account; fix when a paid tier returns |
| Next dev | first hit of a route compiles for 40s+ | the splash sits at 0% — only dev, but it is what a screenshot catches |

## Plan

1. Projects: fleet workers become children of their fleet run (one
   project per `results/<run>/`), or are hidden behind a "fleet" toggle;
   the hot-projects sidebar excludes them. Index `projects(last_active)`
   and paginate `/api/projects`.
2. Scrobble payload: profile the query; it re-aggregates lifetime
   usage_minutes on every request — cache per minute or roll up.
3. Publish schema 1.2.0 and ui 1.2.0 (`npm publish --access public`).
4. Emails: leave until a paid tier exists; note here so it is not lost.

## Done — 2026-09-03

| item | before | after |
|---|---|---|
| `/api/projects` | 7.6s, 153 rows led by fleet workers | 117 rows, zero worker rows; rollup 2507ms → 441ms |
| `/api/projects/activity` (sidebar) | 2,455 rows, top five all workers | 148 rows, real repos |
| `/api/scrobble/payload` | 11.6s, 8 full scans of 1.6M messages | 5.8s, 2 scans; every lifetime figure identical |

- `isWorkspacePath` / `ancestorByPath` / `countPathChildren` in
  `packages/core/project-rollup.ts`, with tests including one that proves
  the prefix count matches the pairwise definition it replaced.
- Workspaces fold into the project owning their parent directory, so a
  repo keeps its workers' sessions and tokens; nothing is lost, only
  un-listed.
- scrobble: `strftime` reparsed all 1.6M timestamps for a day and hour the
  ISO string already spells; `substr` does not. Weekday is computed once
  per day in the fold. Weekly velocity now counts a session in the week it
  last ran, rather than once per week it touched.

## Blocked: npm publish

`npm whoami` → **401 Unauthorized**; `npm publish` → 404 on our own scope,
which is what npm returns when the token cannot write it. Both packages
pack correctly (`--dry-run` green: schema 1.2.0, 46 files including all 19
harness docs; ui 1.2.0, 25 files). Registry still holds 1.1.2 for all four.

**Needs fox:** a fresh npm token for `fxhp` written to `~/.npmrc`. Per our
credential rule this session did not read or modify that file.

### Also owed, and worse than the version gap

`@unturf/unfirehose` (core) and `-router` are at 1.1.2 in the repo *and* on
npm, but the repo's 1.1.2 is not what was published — core has gained
status-pages, the refusals module and the rollup helpers since. Same
version, different content. All four should go out together on the next
publish, with core and router bumped to 1.2.0 so the registry stops
disagreeing with the tree.
