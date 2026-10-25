# 4012: Batch four — what shipping batch three taught us, then reach

**Status:** open, ready for a web session
**Project:** unfirehose-nextjs-logger
**Estimated:** several sessions
**Owner:** web session; fox reviews

## Rules for this batch, non-negotiable

- **One item, one pull request.** Batch three landed ten items in one
  25,000-line PR that no one could read line by line. Each item below is its
  own PR against main. A PR over 2,000 changed lines, tests included, gets
  split before it is opened.
- Everything free, local, no network call home. See the feedback memory on
  extractive monetization.
- Outcome and decisions appended to this ticket per item, as before.

## Found live on fox's box after the batch-three merge (2026-10-25)

### 1. Ledger backfill starves the sampler
`LEDGER_WINDOW = 50_000` block ids per tick, one transaction, on the worker's
main thread: ticks measured 6 to 14.5 s, eleven `SQLITE_BUSY` errors and nine
dropped mesh samples across three nodes in six minutes. The sampler is a
separate process and loses the lock race. Fix: windows small enough that a
write transaction stays under one second (measure; likely 2,000 to 5,000),
`PRAGMA busy_timeout` raised on every connection we open, and the backfill
moved into the payload child beside the other heavy builds so ingest and
sampling never wait on it. Acceptance: zero `SQLITE_BUSY` in the journal
through a full backfill on a database with two million blocks.

### 2. Energy attribution cannot see our own traffic
`energy_attribution_15m` joins on `messages.endpoint IS NOT NULL`. On fox's
box that is zero of 167,008 messages in the last 30 days (13,659 of them
from local providers), so `node_energy_15m` filled with 30,425 rows and
attribution stayed at zero. Add a fallback chain when the endpoint is null:
provider → node (our `rate-limits.ts` already maps `ai.foxhop.net` to qwen,
and pricing's `MODEL_HARDWARE_HINT` maps model names to hardware), then a
user-editable provider-or-model → node table in Settings → Permacomputer,
seeded from those. Acceptance: on the demo seed and on a fixture modelled on
fox's data (provider `qwen`, no endpoint), attribution rows exist and the
dashboard power column shows measured, not estimate.

## Quality, measured

### 3. Six functions nobody can hold in their head
CRAP with current coverage: `analyzeStatement` 11,990 (complexity 109) and
`splitTopLevel` 3,906 in `action-ledger.ts`; `exportTrainingSet` 3,906;
`buildMonthlyCostReport` 2,652; `extractTodosFromEntry` 1,980; `gitRules`
1,806. Split each into named rules or steps with their own tests until no
function in the repo scores over 500. The ledger's rule tables want to be
data, not branches.

### 4. The CRAP test depends on stale coverage
`scripts/quality/reports.test.ts` "honours a threshold" fails on a box whose
`coverage-final.json` files date from September: it measures the live repo
against old coverage. Make the test use its own fixture only, and make
`report-crap` say when coverage is older than the sources it scores.

### 5. Lint to zero warnings
73 warnings, 62 of them unused variables, 5 exhaustive-deps, 6 stale
disable directives. Then turn warnings into errors in CI so it stays there.

## Product

### 6. Backup and restore
Nothing today. `make backup` writes a consistent copy through SQLite's
online backup API plus the settings, alert destinations and attachments,
into one dated archive; `make restore` brings it onto a new machine; doctor
reports the last backup's age. Moving to a new box is the first thing a
real user does after a year.

### 7. Fleet view
Fleet-roots already ingests other hosts' seat homes over the mesh and
nothing shows it. One page: who ran what, where, when, at what cost, per
host and per seat, from rows we already have.

### 8. Command palette
Ctrl-K: jump to a project, session, node, todo or action by typing, with
recent items first. Search across logs, thinking and the ledger from the
same box. No library; the repo already has list and keyboard primitives.

### 9. Accessibility pass
16 `aria-label`s in the whole app. Keyboard reach for every tab strip and
drawer, labels on every chart with a text alternative, contrast checked in
both themes, focus visible. Measured with axe in the render smoke tests.

### 10. In-app docs
The dashboard links to `/docs/architecture/node-score` and no such route
exists. Render `docs/architecture/*.md`, `packages/schema/SPEC.md` and
`llms.txt` under `/docs` with a sidebar and search, so a link in the app
never leaves the app.

## Decisions fox owns
Cursor and OpenCode readers stay off until their formats hold still.
Monetization direction is unchanged: none. unsandbox remains behind its
flag; its removal is a separate decision.
