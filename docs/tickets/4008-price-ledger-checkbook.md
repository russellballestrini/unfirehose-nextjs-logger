# 4008 — Price ledger: keep the books like a checkbook

**Status:** done
**Opened:** 2026-09-01
**Closed:** 2026-09-01
**Project:** unfirehose-nextjs-logger
**Estimated:** 240m
**Requested by:** fox — "expect wild swings in model costs, so hard coding is a
fool's errand from now on; we want honest double accounting like a checkbook."

## Problem

Ticket 4006 replaced a hand-typed price table with two oracles and a
`model_pricing` table. That fixed "our newest model reports free". It left three
defects that only show up once prices actually move — which fox says to expect.

### 1. The catalog is overwritten in place, so history is destroyed

`syncPricing` upserts `model_pricing` keyed on `(source, model_id)`. When a
price changes, the old value is gone. Every cost number on every page is
recomputed from the *current* price each render, so a token spent in June is
billed at September's rate, and the total for a closed month drifts silently
whenever an oracle updates. There is no record that it drifted, or by how much.

That is the opposite of a checkbook. A checkbook never erases an entry; a
correction is a new entry, and the balance at any past date is reproducible.

### 2. Once a day is too slow on launch day, and there is no register

Fable 5.1 shipped today. OpenRouter listed it at 18:03 UTC. Our daily sync ran
at 13:41 UTC. Until tomorrow's tick every Fable 5.1 token — 398 messages by
21:50 — priced as `unknown`. Nothing recorded that the sync had run, that it
had run on time, or that it had found nothing new. "Check our time every
session; gaps are information" — there was nowhere to see the gap.

### 3. Two oracles is not holistic

Both existing oracles are resellers. A model that is not on OpenRouter is
invisible, and with two books there is no third to break a tie. Probed today,
six public unauthenticated feeds, looking for Fable 5.1:

| feed | url | fable-5.1 | shape |
|---|---|---|---|
| openrouter | `openrouter.ai/api/v1/models` | yes (added 18:03 UTC) | $/token strings |
| nous | `inference-api.nousresearch.com/v1/models` | yes | $/token strings, resale (~0.8x) |
| litellm | `raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json` | yes, keyed `claude-fable-5-1` — our exact logged name | $/token numbers, 2,400+ chat rows |
| models.dev | `models.dev/api.json` | yes, with `release_date: 2026-09-01` | $/million, 7,494 rows across 190 providers |
| llm-prices | `llm-prices.com/current-v1.json` | yes | $/million, 153 rows, no cache-write |
| helicone | `helicone.ai/api/llm-costs` | **no** | operator-matched, stale — rejected |

All five agree: $10 / $50 per million, cache read $0.25 (down from $1.00 on
Fable 5), cache write $12.50. Five independent books agreeing is the
double-entry check a single oracle cannot give.

## Approach

**The ledger is the catalog.** `model_pricing` becomes a view over the open
rows of an append-only `model_price_ledger`. A sync never updates a price; it
closes the row that no longer holds (`effective_to`) and opens a new one
(`effective_from`). An unchanged price just gets its `last_seen_at` bumped —
"verified still true on this date". A model that vanishes upstream is stamped
`delisted_at`; its last price stays in force for history, and the UI can say so.

**Every sync is a register entry.** `pricing_sync_runs` records each attempt —
source, trigger (`worker` / `make` / `api` / `unpriced` / `bootstrap`), started,
finished, ok, models, added / changed / delisted / unchanged, error. Failures
are entries too. A missing entry is a gap you can see.

**Cost is booked at the price in force when the tokens were spent.**
`resolvePrice`, `calcCostBreakdown` and `costForUsage` take an optional `at`.
Routes that already have a timestamp per row pass it. Sums over a window are
sums of per-day bookings, so a closed month stops moving when a price changes.
A row dated before our first observation prices at the earliest observed rate —
the only evidence we have — and says so (`backdated: true`).

**Five oracles, preference by what we actually pay.** List price is
OpenRouter first (what a direct Anthropic call bills), then models.dev, LiteLLM,
llm-prices as fallbacks, Nous last. Traffic that routed through Nous prices at
Nous first, as before. `priceConsensus(model)` reports every source's list price
and whether they agree within 1%; `GET /api/pricing` surfaces disagreements so
a wrong feed is visible instead of silently winning by order.

**Sync when there is a reason to, not only by the clock.** Daily tick stays.
Additionally, after each ingest the worker checks whether any model with real
tokens in the last 24h resolves to `unknown`, and if so triggers a sync
(`trigger='unpriced'`, at most once per hour). Launch-day models price within
minutes of their first token instead of tomorrow.

**`make pricing` runs the same code path as the worker.** One `syncPricing`,
called from a script with `trigger='make'`, printing the register entry it
wrote and the diff it found. `make pricing-report` prints the book without
touching the network.

**Hardcoded prices stay out.** The `PRICING` cold-start table is not extended
for Fable 5.1 or anything else; on a database that has synced even once, the
ledger is the cold start. The table only matters for a brand-new database with
no network, and it is labelled `table` when it is used.

## Files

- `packages/core/db/migrate.ts` — `model_price_ledger`, `pricing_sync_runs`, migrate `model_pricing` table → view
- `packages/core/pricing.ts` — five sources, price history, `at`, `priceConsensus`
- `packages/core/pricing-sync.ts` — five adapters, diff-and-append sync, run register, unpriced trigger
- `packages/core/pricing-sync.test.ts` — sync against an in-memory DB with a mocked fetch
- `scripts/sync-pricing.ts` + `Makefile` — `make pricing`, `make pricing-report`
- `apps/worker/src/main.ts` — trigger label, change logging, unpriced trigger after ingest
- `apps/web/src/app/api/pricing/route.ts` — ledger, runs, consensus in GET
- `apps/web/src/app/api/tokens/route.ts`, `dashboard`, `scrobble/payload`, `usage/plan` — pass `at`

## Done when

- Fable 5.1 prices without anyone editing source
- A price change produces a new ledger row and closes the old one; nothing is overwritten
- `SELECT * FROM pricing_sync_runs` shows every attempt, including failures
- The same tokens cost the same on every page, and a closed day's cost does not move when a price changes later
- `make pricing` and the worker's daily run are the same function
- Oracles that disagree are listed, not averaged away

## Result

First `make pricing` against the live database, 2026-09-01 22:04 UTC:

| book | rows | first-sync outcome |
|---|---|---|
| openrouter | 442 open (23 delisted) | 23 ids the old upsert table had kept after upstream dropped them, now stamped delisted with their last price in force |
| modelsdev | 7,058 | new |
| litellm | 2,640 | new |
| llmprices | 152 | new (feed lists one id twice; booked once) |
| nous | 397 (21 delisted) | as openrouter |

`claude-fable-5-1`: 178M tokens, **$10 / $50 / cache read $0.25**, all four
list-price books agree. Unpriced models with real tokens in 28 days: **0**.

Second run, four minutes later, booked the ledger's first genuine change:
`deepseek/deepseek-v4-pro` on OpenRouter moved $1.024164 → $1.027470 per M
input (+0.3%). That is the sub-percent wobble fox anticipated. The ledger
records it faithfully — a row is a row — but a model priced off an exchange
rate will accumulate many such rows. Whether to treat moves under some
tolerance as "unchanged" is a policy call, not a defect; `pricing_sync_runs.
changed` per run is the number to watch before deciding.

Two defects found by the first live run and fixed in the same change:

- `make pricing` collided with a worker sync and logged `database is locked`
  for one oracle. No connection set `busy_timeout`; now 5s in
  `applyBasePragmas`, so a second writer queues instead of failing.
- The worker synced all five feeds ten seconds after every restart — and
  under `tsx watch` it restarts on every file save. Boot now syncs only if
  the book is older than a quarter of the daily interval.

Per-row pricing cost, measured on 34,542 (session, model) rows all-time:
~480ms before memoising alias resolution, of which 260ms was the regex
normalisation; cached by name now. Warm route timings after the change:
tokens ~1.2–1.4s (saved baseline 1.29s), dashboard 28d ~2s.

## Notes

Not built: a materialised daily `cost_journal`. With an append-only ledger and
`at`-aware pricing, cost at any date is a deterministic join of the token book
and the price book. A second stored copy would be a second thing to reconcile.
Revisit if render-time pricing of per-day rows ever shows up in perf reports.
