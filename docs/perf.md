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

## After (2026-09-05, production, recharts removed, control 14ms, best of five)

| page | first data | last data | js on a cold visit | before (last data) |
|---|---|---|---|---|
| `/settings` | 116 | 145 | 293k | 2,156 |
| `/live` | 103 | 307 | 156k | 2,506 |
| `/schema` | 81 | 335 | 293k | 1,872 |
| `/tokens` | 89 | 338 | 193k | 3,007 |
| `/tmux` | 90 | 374 | 293k | 1,901 |
| `/scrobble` | 75 | 396 | 293k | 2,358 |
| `/usage` | 230 | 528 | 155k | 3,239 |
| `/rate-limits` | 108 | 554 | 293k | 2,071 |
| `/projects` | 73 | 645 | 293k | 2,065 |
| `/active` | 110 | 673 | 293k | 2,202 |
| `/` | 75 | 694 | 299k | 2,861 |
| `/logs` | 97 | 699 | 293k | 2,842 |
| `/permacomputer` | 104 | 835 | 293k | 2,629 |
| `/todos` | 102 | 988 | 293k | 2,528 |

Milliseconds. "First data" is when a reader has something to read — 73 to
116ms on thirteen of fourteen pages. Where "last data" trails it, the gap is
secondary panels filling in beneath content already on screen, and on
`/permacomputer` and `/active` it is a remote call (`/api/unsandbox` at 699ms,
`/api/tmux/stream` at 491ms) that the page waits for last. The shared script
chunk fell from 437k to 293k when recharts left; `/tokens` from 360k to 193k.

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
