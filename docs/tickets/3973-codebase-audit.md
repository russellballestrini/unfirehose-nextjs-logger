# 3973: Codebase audit — the defect classes behind "everything is slow"

**Status:** open
**Project:** unfirehose-nextjs-logger
**Estimated:** 240m
**Todo IDs:** 3973

## Why

Three Code-tab fixes on 2026-09-04 were three different causes wearing one
error message. This is a sweep for the same classes everywhere else, with
measurements rather than impressions. Every number below was taken on this
box while it was under its normal load.

## Ranked by measured cost

### 1. `/api/mesh/history` ships 8 MB every 6 seconds — **worst thing in the codebase**

| | |
|---|---|
| payload | **7.97 MB**, 4.5s |
| rows | 5,646 timeline points x 15 fields |
| poll | `refreshInterval: 6000` on the node page |
| destination | a uPlot chart roughly 1,100px wide |

That is five points per pixel, and 1.3 MB/s of continuous JSON parse on a
thermally-throttled laptop. Nothing can be read from four of every five
points. **Fix:** bucket server-side to a `?points=` the caller asks for
(chart width), returning min/max/avg per bucket so spikes survive
downsampling. Poll no faster than the 15s sampler writes.

### 2. `/api/todos` returns every todo, always

2.27 MB, all 3,961 rows, no LIMIT — polled by the board. **Fix:** page it,
or return open todos plus a bounded completed window (the board already
hides completed by default).

### 3. Per-line DOM in three diff viewers

The file viewer built a `<tr>` + two `<td>` per line — 8,748 nodes for a
1,458-line file — and took seconds to open while the API answered in 7ms.
Fixed in 882a01c. The same shape is still in:

- `app/projects/page.tsx:835`
- `app/projects/[project]/page.tsx:1354`
- `app/usage/review/[project]/page.tsx:145`

A diff is unbounded in a way a file is not: `git diff HEAD` on a large
change is tens of thousands of lines. **Fix:** same two-`<pre>` shape, or
cap with "show more" — diffs need per-line colour, so keep one element per
line but virtualise or slice.

### 4. Spawning processes inside request handlers

fork copies the page tables of the Next process, so each spawn costs
**~400ms here** even though git itself is 0.00s. Counts per file:

| route | spawns |
|---|---|
| `mesh/route.ts` | 12 |
| `tmux/stream/route.ts` | 6 |
| `mesh/node/route.ts` | 4 |
| `projects/[project]/agent`, `boot`, `mesh/geoip` | 2 each |

`mesh/route.ts` also does synchronous `readFileSync`/`readdirSync` on
`/proc` and `/sys` inside the handler. **Fix:** read `/proc` and `/sys`
with async fs; batch or cache SSH probes; never spawn for something a file
can answer (the branch now comes from `.git/HEAD` for exactly this reason).

### 5. DRY — the same code in many places

| helper | copies |
|---|---|
| `fetcher` (SWR boilerplate) | **24 files** |
| `gitExec` | **7 route files** |
| `shortModel` | 4 |
| `formatTokens`, `formatCost`, `truncate` | 2 each |

Already consolidated this week: the repo-path resolver (was 7 copies), the
model colour map (2), the summary strip (2). `gitExec` and `fetcher` are
the remaining large ones. A shared `gitExec` also gives one place to add
the spawn accounting item 4 needs.

### 6. Unbounded SELECT in 12 API routes

`mesh/history`, `projects`, `dashboard`, `active-sessions`,
`rate-limits`, `usage/plan`, `account`, `projects/merge`,
`projects/[project]/visibility`, `projects/[project]/full`,
`webhooks/tier-sync`, `projects/[project]/agent`. Most are small today
and become items 1 and 2 as the database grows. The database is already
4.5 GB.

### 7. `/api/scrobble/payload` still 11.6s cold

Halved on 2026-09-03 (8 full scans of 1.6M rows to 2), still the slowest
endpoint. The lifetime aggregates could be a rollup table like
`usage_minutes` rather than recomputed per cache miss.

## Order of work

1, 2 and 3 are user-visible today. 5 is what fox asked for and makes 4
tractable. 6 and 7 are debt that grows with the database.
