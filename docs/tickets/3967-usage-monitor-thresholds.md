# 3967: Usage Monitor — thresholds that mean something

**Status:** done
**Project:** unfirehose-nextjs-logger
**Estimated:** 90m
**Todo IDs:** 3967

## Context

`/usage` is a wall of red. 751 unacknowledged alerts since 2026-06-26, 2740
total. Two enabled thresholds — `total_tokens` > 25M/15min and > 75M/60min —
fire almost every window because they measure the wrong thing at the wrong
scale:

| window | threshold | our p50 (7d) | our p95 (7d) | our max (7d) |
|--------|-----------|--------------|--------------|--------------|
| 60min total_tokens | 75M | 48M | 184M | 375M |

- **89% of our tokens are cache reads** (10% price). `total_tokens` tracks
  context churn, not spend. Uncached input+output p95 is 10.8M/hr, output
  p95 is 543K/hr — those are our real signals.
- Defaults come from `PLAN_THRESHOLDS` in `packages/core/db/ingest.ts` —
  hand-guessed per plan tier, never calibrated against our own history.
- Every alert that fires against a threshold we know is wrong is noise; an
  alert that fires 1246 times has stopped being an alert.
- `apps/web/src/app/usage/page.tsx` is 1066 lines; ~550 are components
  never rendered (`StandupProjectDetail`, `MeshNodeCard`, `UnsandboxCard`,
  `RateCard`) plus SWR fetches for `plan`, `mesh`, `meshHistory`, `extra`
  that nothing displays. The "7 days" range selector drives only a mesh
  history fetch that is never shown.

## Plan

1. **Calibrate from history.** New `calibrateThresholds(days=7)` in core:
   for each (window, metric) compute p95 of the rolling-window sum over the
   last N days and set threshold = 1.5 × p95 (rounded to 2 significant
   figures). Button on the page: "Calibrate from last 7 days". Run it once
   now as the new default; `applyPlanThresholds` stays as a fallback for a
   fresh install with no history.
2. **Alert on what we pay for.** Enable `output_tokens` and `input_tokens`
   (uncached) at 15min and 60min; disable `total_tokens` by default. Keep
   the rows, flip the `enabled` bits. Cache reads stay visible on /tokens.
3. **Reset stale alerts on threshold change.** `update_threshold` and
   calibrate auto-acknowledge unacked alerts for that (window, metric) —
   they were measured against a number we just declared wrong.
4. **Alert history → per-day breach counts** with the raw list behind a
   disclosure, so the page shows "3 breaches today" rather than 751 rows.
5. **Trim dead code**: delete the four unrendered components and the unused
   fetches; drop the range selector unless step 4 uses it (it can scope
   the history). Per feedback: trim not polish.

## Notes

- Numbers above from `usage_minutes` on 2026-09-03; recompute at calibrate
  time, never hardcode.
- Option not taken: a `cost_usd` metric. `alerts.metric` already documents
  it, but pricing lives in the price book on /tokens and would need to be
  joined per minute per model. Worth a follow-up ticket if uncached tokens
  prove too coarse.

## Done — 2026-09-03

- `calibrateAlertThresholds(days, factor)` in core: dense per-minute series,
  prefix sums, p95 per rolling window, 1.5×, two significant figures. Stores
  its run in settings `alert_calibration`; rules with no tokens are skipped.
- 11 rules seeded (4 windows × 3 metrics, minus 1m total). One-time
  migration `alert_defaults_v2` flips existing installs: input/output at
  15m and 60m on, everything else off.
- Threshold edits and calibration acknowledge open alerts on the moved rule.
- `/api/alerts?filter=daily&days=N` per-day breach counts; page shows days,
  raw list behind a disclosure. Page went 1066 → 384 lines; four unrendered
  components, seven unused fetches and the range selector are gone.
- Live run: 751 open alerts acknowledged. Enabled rules now 15m 4.6M in /
  210K out, 60m 16M in / 780K out.
