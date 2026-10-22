# Precomputed payloads

Our dashboard, Tokens page, scrobble page and project list each answer from a payload our worker built ahead of time and stored in SQLite. A route reads what is stored; it builds only when nothing has ever been stored. This page describes that pattern as our code implements it. In-memory TTL caches inside a route are a different thing; see [`docs/caching.md`](../caching.md).

## Why

Each build is seconds of SQL against `messages` (measured on a 6.6 GB database: dashboard 24h 0.7 s, 7d 1.2 s, 28d 4.6 s; project list 4.0 s; scrobble 14.7 s; tokens lifetime ~11 s — `apps/worker/src/main.ts:49-66`). Our Next.js server is one thread, so a build on a request is charged to every other request. A separate worker process does that work instead.

## Store: rows in `settings`

No dedicated table. A payload is three rows in our key/value `settings` table (`key TEXT PRIMARY KEY, value TEXT, updated_at`, `packages/core/db/migrate.ts:123`), written with `setSetting` (upsert, so a rebuild replaces rather than accumulates):

| key | value |
|---|---|
| `<key>` | payload as JSON |
| `<key>_at` | ISO time of our build — served as `X-Computed-At` |
| `<key>_watermark` | `MAX(messages.id)` read *before* our build began |

| payload | key(s) | built by |
|---|---|---|
| dashboard | `dashboard_<range>` | `buildDashboard` — `packages/core/dashboard.ts:42` |
| tokens | `tokens_<range>` | `buildTokensPayload` — `packages/core/tokens.ts:78` |
| scrobble | `scrobble_payload` | `buildScrobblePayload` — `packages/core/scrobble.ts:78` |
| project list | `project_list` | `buildProjectList` — `packages/core/projects-list.ts:148` |

All four go through `packages/core/precomputed.ts`:

- `storePayload(key, payload, watermark)` — `:43`, writes all three rows.
- `readPayload(key, maxAgeMs)` — `:92`, returns `{ payload, at }` or `null`. Missing payload, missing or unparseable `_at`, age over `maxAgeMs`, or JSON that will not parse all read as `null`: "no answer", so a caller does one thing — build.
- `messagesWatermark()` — `:32`, `SELECT MAX(id) FROM messages` as a string (`'0'` on an empty table).
- `payloadCurrent(key, maxAgeMs, watermark)` — `:56`, true only when our stored watermark equals today's *and* `readPayload(key, maxAgeMs)` answers.
- `storedRanges(prefix, known)` — `:71`, lists ranges under a prefix by their `_at` rows, filtered to known range names.

## Watermark and staleness

`messages.id` is `AUTOINCREMENT` and ingest only appends, so `MAX(id)` moves exactly when a message lands. A payload whose watermark matches was built from what our database holds now; rebuilding it would write back our same bytes.

Our watermark is read before a build, not after (`precomputed.ts:37-42`): a message landing during a multi-second build is not in our payload, so its stamp must not claim it is.

Matching watermarks alone are not enough. A `24h` window slides with our clock and mesh energy samples land without a message, so `payloadCurrent` also demands an age under a "max quiet" bound. Rule, per worker tick:

```
rebuild  if  stored _watermark != MAX(messages.id)
         or  now - _at > maxQuietMs
         or  any row missing / unparseable
skip     otherwise   (refreshX returns null, nothing logged)
```

Routes apply **no** staleness rule: every one reads with `maxAgeMs = Infinity`. Staleness is decided only by our worker.

## Who builds, and when

```
   ingest (watcher + poll)                  web (Next.js, one thread)
          │ appends messages                         │
          ▼                                          │ GET /api/dashboard?range=7d
   ┌─────────────┐  refreshX(range,                  ▼
   │   worker    │   {unlessCurrentMs})     readX(range, Infinity)
   │  timers     │──── payloadCurrent? ──┐       │            │
   └─────────────┘     yes → skip        │   stored?        none
          │            no  → build ──────┤       │            │
          │                              ▼       ▼            ▼
          │                     storePayload ─► settings ◄─ refreshX(range)
          │                                       rows       (build on request,
          └── storedRanges(prefix) ◄──────────────┘           store, return)
               picks up ranges a request stored
```

**Worker** (`apps/worker/src/main.ts`). Each payload has a kickoff `setTimeout` after boot and a `setInterval`, each calling `refreshX(..., { unlessCurrentMs: <max quiet> })`. Ranges loop through `refreshRanges` (`:192`), which catches and logs per range so one failure does not stop our others.

| set | ranges | tick | max quiet | kickoff |
|---|---|---|---|---|
| dashboard short (`WARM_SHORT_RANGES`) | 24h, 7d | 60 s | 15 min | 12 s |
| dashboard long (`WARM_LONG_RANGES`) | 28d | 5 min | 30 min | 12 s |
| dashboard stored | whatever a request stored, less warm | 30 min | 60 min | 45 s |
| tokens short (`WARM_TOKENS_SHORT_RANGES`) | 24h, 7d | 60 s | 15 min | 16 s |
| tokens long (`WARM_TOKENS_LONG_RANGES`) | 28d, all | 10 min | 60 min | 16 s |
| tokens stored | whatever a request stored, less warm | 30 min | 60 min | 50 s |
| project list | — | 3 min | 15 min | 8 s |
| scrobble | — (one lifetime payload) | 15 min | 2 h | 20 s |

Constants: `main.ts:55-83`. "Stored" sets come from `storedDashboardRanges` (`dashboard.ts:529`) / `storedTokensRanges` (`tokens.ts:445`) minus our warm sets (`storedBeyond`, `main.ts:211`). Without that listing, a range first built by a request was served forever — 90d, 365d and lifetime sat a month old (2026-10-14).

**Request path.** Only on a miss: `refreshX(range)` with no `unlessCurrentMs`, built on our web thread, stored, returned.

## How a route serves

| state | dashboard `route.ts:12` | tokens `route.ts:40` | scrobble `payload/route.ts:22` |
|---|---|---|---|
| stored (any age) | 200, `X-Computed-At`, `Server-Timing: stored` | same | same |
| missing | build, store, 200, `Server-Timing: built` | same | same |
| build throws | 500 `{ error, detail }` | 500 | 500 |

Stale-while-revalidate here means: serve whatever is stored, however old, and leave revalidation to our worker's next tick. A route never triggers a background rebuild (unlike `/api/mesh`'s in-process SWR in `caching.md`).

Route specifics:

- **Dashboard** overwrites `ingestLagMinutes` at read time (`route.ts:22`): our worker skips rebuilds while nothing lands, so a stamped lag would read "quiet" even with a dead worker.
- **Tokens** stores only a bare named range. `?range=` outside `TOKENS_RANGES` is a 400. A `project`, `from` or `to` builds live and is never stored (`route.ts:62-78`). No parameters means `all`.
- **Scrobble** has one lifetime payload carrying day grains; our page re-folds any range in our browser with `sliceScrobble` (`packages/core/scrobble-range.ts:120`).
- **Projects** (`/api/projects/route.ts`) follows our same shape.

## Ranges

Dashboard and tokens share one table: `DASHBOARD_RANGES` (`dashboard.ts:23`; `TOKENS_RANGES` is our same object, `tokens.ts:34`) — `1h 3h 6h 12h 24h 7d 14d 28d 90d 180d 365d all`, as minutes; `all` is 0, meaning lifetime (dashboard window starts at 1970; tokens `rangeFrom` returns `undefined`). Only our warm sets above are built before anyone asks; any other range is built on its first request and then kept fresh by our "stored" tick.

## Failure modes and cold boot

- **Cold boot, empty `settings`.** First request per key builds on our web thread (seconds; scrobble ~15 s), then stores. Worker kickoffs fill warm sets 8-50 s after it starts.
- **Worker down or busy importing.** Routes keep serving their last stored copy; `X-Computed-At` gives its age. Nothing rebuilds on requests.
- **Build throws in our worker.** Logged per range; our previous payload stays and is served.
- **Corrupt or half-written rows.** `readPayload` returns `null` → our route rebuilds once. A missing `_watermark` (rows from before watermarks) makes `payloadCurrent` false → our worker rebuilds.
- **Concurrent misses.** No single-flight on our request path: simultaneous first requests each build, last write wins.
- **Changes that add no message** (project merges, visibility, prices, mesh samples) do not move our watermark; they reach a payload only through its max-quiet bound.

## Adding a new precomputed payload

1. In `packages/core/<name>.ts`, write `buildX(...)` — pure read of our database, throws on failure.
2. Add `refreshX(range?, { unlessCurrentMs })`: read `messagesWatermark()` first; return `null` if `payloadCurrent(key, unlessCurrentMs, watermark)`; else build and `storePayload(key, payload, watermark)`. Copy `refreshDashboard` (`dashboard.ts:511`).
3. Add `readX(range?, maxAgeMs)` wrapping `readPayload`.
4. For ranges: key as `<prefix><range>`, validate against a known-ranges table, export `WARM_*` sets and `storedXRanges()` via `storedRanges(prefix, known)`.
5. Route: `readX(..., Infinity)` → 200 + `X-Computed-At`; on `null` → `refreshX()` → 200; on throw → 500.
6. Worker (`main.ts`): kickoff `setTimeout` + `setInterval` with a tick and a max-quiet constant; for ranges, use `refreshRanges` and `storedBeyond`; clear both timers in our shutdown handler.
7. Tests: core test asserting store/skip on unchanged watermark (see `dashboard.test.ts`, `tokens.test.ts`), route test asserting a stored payload is served stale rather than rebuilt (see `apps/web/src/app/api/tokens/route.test.ts`).
