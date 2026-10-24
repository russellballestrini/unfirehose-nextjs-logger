# 4010: Onboarding — from install to first insight in five minutes

**Status:** done 2026-10-23, fox reviews
**Project:** unfirehose-nextjs-logger
**Estimated:** 2 to 3 sessions
**Owner:** web session; fox reviews

## Outcome (2026-10-23)

| # | Deliverable | Where |
|---|---|---|
| — | One detector, per-harness stats, `UNFIREHOSE_DIR` | `packages/core/harness-detect.ts`, `db/harness-stats.ts`, `db/data-dir.ts` |
| 1 | First-run wizard | `apps/web/src/components/FirstRunWizard.tsx`, `GET /api/onboarding`; shown only when the database holds no sessions (a quiet range draws our dashboard) |
| 2 | Harness health | Settings → Harnesses (`app/settings/HarnessHealth.tsx`), same route |
| 3 | Empty states | `@unturf/unfirehose-ui/EmptyState` (`first-run` / `quiet`), `lib/ever.ts` lifetime probes on six routes |
| 4 | `make demo` | `packages/core/demo-seed.ts`, `scripts/demo.ts`; serves `~/.unfirehose-demo` on :3010, `UNFIREHOSE_HARNESSES=none`, no worker; `DEMO_MODELS` in `SYNTHETIC_MODELS` |
| 5 | `make doctor` | `scripts/doctor.ts` (facts) + `scripts/doctor-checks.ts` (rules, tested) |
| 6 | Install story | README quickstart, Keep it running, `docker-compose.yml` (+ `compose-up/down/logs`) |
| 7 | Coach marks | `components/CoachMarks.tsx`, `data-coach` anchors on four pages, Settings → General → Show hints again |

Checked in a browser against `make demo`: Dashboard, Tokens, Projects and
Permacomputer render populated, three hints each, no "nothing yet", no
page errors; a fresh data dir shows the wizard with nothing ingested.

Found on the way and fixed: the dashboard's Day of Week chart drew no bars
for any range (per-bar colours sat where uPlot ignores them).

Decisions taken that fox may want to revisit:
- doctor: a missing harness is a neutral line when another harness is
  found, yellow only when none is (otherwise a healthy box is never all green).
- compose: only `~/.claude` mounted by default (a missing bind source makes
  docker create a root-owned dir in the home); the worker runs from the
  Dockerfile's builder stage, which has no ssh/git, so mesh probes fail in
  the container. A worker stage in the Dockerfile would be cleaner.
- `make docker-run` now lags compose (no worker, all interfaces).
- demo: a demo web server with an empty price book still bootstraps it from
  the public price feeds on first cost, as any fresh install does.

fox, 2026-10-24: all three accepted as shipped. The demo's one price-feed
fetch is what every fresh install does and fetches public prices, nothing of
ours. (The Dockerfile worker stage and compose-backed `make docker-run`
landed in ticket 4011 item 10.)

Not ours, seen once: uPlot builds an `Intl.NumberFormat(navigator.language)`
at module load, which throws for a POSIX-suffixed browser locale
(`en-US@posix`, a `LANG=C` headless chromium).

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
