# 3970: Follow-ups surfaced by the landing-page reshoot

**Status:** open
**Project:** unfirehose-nextjs-logger
**Estimated:** 120m
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
