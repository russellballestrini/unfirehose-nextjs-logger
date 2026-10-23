# 4010: Onboarding — from install to first insight in five minutes

**Status:** open, ready for a web session
**Project:** unfirehose-nextjs-logger
**Estimated:** 2 to 3 sessions
**Owner:** web session; fox reviews

## Why

unfirehose is free and local, forever. Nothing here gates, trials, nags or
upsells; see the feedback memory on extractive monetization if tempted. What
the product lacks is a first run that teaches itself. Today a new install
shows one static welcome card on an empty dashboard and otherwise says
"nothing yet" in a dozen places. A person who installs it, runs nothing, and
sees nothing, leaves. A person who sees their own last week of agent spend in
five minutes stays, tells someone, and reads the rest.

Growth for a gift is onboarding. That is this ticket.

## Constraints

- No telemetry, no network calls home, no accounts. Everything below runs
  against the local database and the local filesystem.
- Nothing already free becomes conditional. Every new surface is free.
- Pure code plus tests; a web session cannot reach fox's machines. Where a
  check needs a real harness directory, fixture it.
- Follow CLAUDE.md: uPlot or the homegrown Donut for any chart, `@unturf/unfirehose/ago`
  for time in words, `our` over `the` in copy, machine learning not AI.

## Deliverables

### 1. First-run wizard replaces the welcome card
`apps/web/src/app/page.tsx` shows the card when the database has no sessions.
Replace it with a wizard component that:
- Detects each supported harness on this machine: `~/.claude/projects`,
  `~/.fetch`, `~/.uncloseai`, agnt, and the others `session-paths.ts` knows.
  Show found / not found per harness, with the file count and newest file age
  for found ones. Resolve the path once through core; do not re-derive it.
- Shows ingest state: worker reachable (the precomputed store has a fresh
  stamp), rows ingested so far, time since the last ingest pass. The number
  must move while the person watches; poll with SWR at the live cadence.
- For a machine with no harness at all: the one command to run
  (`cd ~/your/repo && claude`), and a link to the adapter docs in
  `@unturf/unfirehose-schema` for everything else.
- Hands off to the dashboard automatically once the first session lands.
Tests: jsdom render for empty, detecting, ingesting and done states.

### 2. Harness health in Settings
A section per harness: path, detected or not, rows, last message time, and
when missing, the adapter doc that explains how to feed it. Shares the
detection helper with the wizard; one implementation in `packages/core`.

### 3. Empty states that teach
Audit every page and panel for its zero-data state. Replace each "nothing yet"
with one shared `EmptyState` component carrying: what will appear here, the
action that makes it appear, and a link. The scrobble page already
distinguishes "quiet week" from "first run"; make that distinction universal:
no data in range is not the same as no data ever.

### 4. Demo mode
`make demo` seeds a small synthetic database (two projects, three harnesses,
a week of sessions, a few todos, one alert) under `~/.unfirehose-demo/` and
starts the stack against it via `UNFIREHOSE_DIR`. Use the existing
`SYNTHETIC_MODELS` convention so every cost reads $0 and the pricing book is
untouched. The same seed powers the README screenshots and the render smoke
tests, which today depend on whatever is on the author's machine.

### 5. `make doctor`
One target that checks and explains: node version, better-sqlite3 native
build loads, `~/.unfirehose` writable, port 3000 free or ours, worker unit or
dev stack running (not both), each harness directory readable, disk free
where the database lives. Green, yellow, red, with the fix beside each red.
Pure shell plus one small tsx script; no sudo in the Makefile.

### 6. Install story
- README quickstart rewritten around the wizard: install, start, open, done.
- `docker-compose.yml` that mounts `~/.claude` and friends read-only and the
  data directory read-write, for people who will not install node.
- Document `make service-install` as the "keep it running" path it already is.

### 7. Coach marks, three per page, dismissible
First visit to Dashboard, Tokens, Projects, Permacomputer shows three
anchored hints. State in localStorage under one key, with a "show hints
again" switch in Settings. No animation library; CSS only.

## Acceptance

- A fresh clone, `npm install && make dev`, no harness on disk: the wizard
  explains what to do and shows zero harnesses found, without errors.
- `make demo` on a fresh clone: every key page renders populated data within
  a minute, no page says "nothing yet".
- `make doctor` on a healthy box prints all green; with port 3000 taken it
  names the process.
- `make test` green; `tsc --noEmit` clean in core, web, worker.
- No new network calls: `grep -rn "fetch('http" apps/web/src` shows nothing
  new outside existing local routes.

## Out of scope

Accounts, payments, cloud sync, anything unsandbox. unsandbox is a separate
product and its integration may leave this repo; see the isolation ticket
when it exists.
