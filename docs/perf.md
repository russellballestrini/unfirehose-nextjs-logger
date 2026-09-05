# What a reader waits for

`make vitals` measures every page in a real browser and ranks them by the
moment real text lands on screen. `make vitals-prod` does the same against a
production build: build, start on :3100, best of five runs, stop.

## Why not the HTTP timings

`scripts/perf-report.py` times HTTP responses. For this dashboard that is the
fastest link in the chain reported as the whole thing: the document arrives
in about 40ms and the screen stays empty until the bundle parses, React
hydrates, SWR fetches and the answer paints. It reported 44ms for pages that
took three seconds.

## What the columns mean

| column | meaning |
|---|---|
| `first` | the first time real text landed — a reader has *something* |
| `data`  | the last time it did — the page has finished. A lazily loaded chart moves this and not `first`. |
| `lcp`, `fcp` | the browser's own paints; both fire happily on a loading skeleton |
| `ttfb`  | the server's part, usually not the problem |
| `block` | main-thread time in tasks over 50ms, during which nothing responds to a click |
| `js`    | bytes of script transferred on a cold visit |
| `control` (header) | TTFB of a trivial route, ×5. Past 40ms the server is fighting for a core and every number is inflated by that fight. |

Cold by default (cache disabled): a first visit is what people mean by slow.

## Where the time was (2026-09-05, first honest run, production)

Every page took **1.9–3.2s** to show its data. About 1.9s of that was the same
on every page: the vault auto-unlock ran PBKDF2 at 600,000 iterations twice
(~725ms each in this browser) and `VaultGate` rendered a boot screen until it
finished — in front of pages that never touch a key. Beyond that:
`/api/scrobble/preview` shipped 4.3MB (every one of 9,455 rows in `projects`,
mostly agent scratch directories), `/api/projects/activity` shipped 2.4MB for
the same reason, and recharts (326KB minified) arrived with every page that
drew a chart.

## What changed

- The gate no longer blocks the app; the vault restores in the background. The
  one derivation over a random 256-bit session key is gone (a KDF cannot make
  full entropy harder to guess); the one over the password stays.
- Both payloads read the folded project list the Projects page already keeps.
- Every bar and line chart draws on uPlot (49KB) through `UPlotCategoryChart`;
  the dashboard's charts load after its stats cards. recharts remains only for
  pies, which uPlot does not draw — see `ShareBars` on the styleguide for the
  candidate replacement.

## After (2026-09-05, production, control 10ms, best of five)

| page | first data | last data | before (last data) |
|---|---|---|---|
| `/todos` | 102 | 111 | 2,528 |
| `/projects` | 107 | 113 | 2,065 |
| `/active` | 114 | 163 | 2,202 |
| `/settings` | 123 | 392 | 2,156 |
| `/schema` | 101 | 418 | 1,872 |
| `/tmux` | 101 | 443 | 1,901 |
| `/tokens` | 115 | 522 | 3,007 |
| `/scrobble` | 97 | 542 | 2,358 |
| `/permacomputer` | 152 | 588 | 2,629 |
| `/rate-limits` | 111 | 676 | 2,071 |
| `/usage` | 276 | 770 | 3,239 |
| `/live` | 561 | 931 | 2,506 |
| `/` | 148 | 979 | 2,861 |
| `/logs` | 179 | 1,014 | 2,842 |

Milliseconds. "First data" is when a reader has something to read; on the
pages where "last data" trails it by several hundred milliseconds, the gap
is charts and secondary panels filling in below content that is already on
screen. `/live` and `/logs` are the two still worth work: `/live` waits on
`/api/metrics` (972ms on this run — the server was contended for that one
call) and `/logs` fetches 1,000 rows on its first request.

## Four ways the instrument lied first

Each is fixed in code; each flattered the numbers.

1. A fresh browser profile has no vault, so every route rendered the unlock
   screen and the tool measured one screen fourteen times.
2. `pkill` then `next start` left the old server holding the port; the new one
   died with `EADDRINUSE` into a log nobody read, and the tool benchmarked the
   build from *before* the change. `scripts/perf/prod-server.sh` kills by port
   owner and proves the new pid answers.
3. Closing chromium's parent leaked its renderers — 21 of them pushed load to 20
   and slowed the very pages being measured 3×.
4. Load average passed while the dev server and worker burned 1.5 cores; the
   control TTFB is what now says the server is contended.
