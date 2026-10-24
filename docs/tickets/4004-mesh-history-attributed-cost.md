# 4004: Mesh-history-attributed cost for self-hosted models

**Status:** done 2026-10-24, on fox's three answers (below, under Outcome). The open questions are kept as they were asked.
**Project:** unfirehose-nextjs-logger
**Estimated:** 1-2 days
**Todo IDs:** (proposed by fox 2026-06-08)

## Context

Self-hosted models (Qwen on 4090, Hermes on 3090) currently show cost via a flat estimate in `packages/core/pricing.ts`:

- 4090: 400W, 70 tok/s → ~$0.524 / M tokens at $0.33/kWh
- 3090: 300W, 100 tok/s → ~$0.275 / M tokens at $0.33/kWh

Estimate ships in #4003-adjacent commit; sorts dashboard model list by tokens desc.

Meanwhile `apps/web/src/app/api/mesh/route.ts` already shells out `nvidia-smi --query-gpu=power.draw,utilization.gpu` per node and persists `gpu_power_watts` to `mesh_history`. That real-watts data exists per-node, per-timestamp — but the Model Usage panel never joins it.

## Goal

Replace the flat per-model-token estimate with actual measured energy attributed to each model from `mesh_history`.

## Required changes

1. **Ingest tags message host.** `messages` rows need a `host` column populated at scrobble time from the harness payload. Without `host`, no join key.
2. **mesh_history alignment.** Join `messages.timestamp` against `mesh_history.hostname + timestamp` window. Sum `gpu_power_watts` over the inference window for that host, multiply by elapsed time and kWh rate.
3. **Per-model attribution.** A single node can run multiple models. When two self-hosted models hit the same host in the same window, split watts proportional to tokens (best-effort heuristic) or per-process if `nvidia-smi --query-compute-apps` gave us a PID-process mapping at that moment.
4. **Fall back gracefully.** When `host` is missing or `mesh_history` is sparse, fall back to the flat estimate so dashboards never break.

## Open questions

- Should the join happen in `calcCost` (per-row, expensive) or in a pre-aggregated `model_energy` table refreshed by the mesh poller?
- Idle GPU draw vs inference draw: subtract baseline, or count all watts during the window?
- Multi-GPU nodes — sum across GPUs or attribute to the specific CUDA device?

## Notes

Real-watts numbers may run 2× or 0.5× the static estimate depending on throughput variance + idle draw. Expect dashboard cost values to shift when this lands.

Estimate fix that this replaces: `packages/core/pricing.ts :: selfHostCost()`.

## Outcome (2026-10-24)

fox decided all three:

1. **Pre-aggregate in the sampler.** No per-row join at request time; that is where the tokens route was before it was precomputed.
2. **Subtract idle**, and show idle as the node's standing cost.
3. **Sum GPUs per node** until nvidia-smi gives us a per-process mapping.

What landed:

- `packages/core/energy-attribution.ts`, run by our sampler child every minute (`apps/worker/src/sampler.ts`), fills two tables (`db/migrate.ts`):
  - `node_energy_15m`: per node per 15-minute bucket (aligned with `mesh_snapshots_15m`), total Wh, GPU Wh, idle watts subtracted, standing (idle) Wh, active Wh, attributed Wh.
  - `energy_attribution_15m`: per node, bucket, model, project and harness, with tokens, a GPU-seconds weight, its share of active Wh, and `measured` (0 when the node was unsampled then).
  - Progress is in settings as our payloads keep theirs: `energy_attribution_at`, `energy_attribution_watermark` (`MAX(messages.id)` read before the run) and `energy_attribution_through` (first bucket not yet final). A message ingested late is found by id above the watermark, and its bucket is rebuilt. A tick spends at most ~2 s; a backfill continues on later ticks. Per-day idle is cached in the sampler, so a steady tick reads one quarter hour of samples, not a week.
- **Join key.** No new `messages.host` column was needed: `messages.endpoint` already carries it. `resolveMeshHost` maps an endpoint to a mesh node through `ENDPOINT_TO_NODE` first, then any sampled node by name or fqdn (`hostname-match.sameBox`), and a loopback endpoint to the node the sampler runs on. Rows whose provider is a cloud vendor are skipped.
- **Readers**, all through `readEnergyAttribution` over the tables, priced at each node's rate (`mesh-econ.kwhRateForHost`: saved node economics, else `mesh_default_electricity_kwh`, else `getKwhRate`; the cost report now reads its rate here too):
  - Dashboard Power column: measured where the node was sampled, the flat watts x GPU-seconds estimate for the share of tokens it was not (`energySource: measured | mixed | estimate`), and Saved recomputed from it. A line under the model table splits our nodes' power into standing, our sessions and other work. The old `meshObservedUSD` (a `gpu_util > 30%` scan of every snapshot inside the dashboard build) is gone.
  - `GET /api/mesh/history` carries `energy`; the fleet page draws a per-node table (idle W, standing $/mo, standing, our sessions, other work, total, with top projects, harnesses and models), and a node page shows its idle draw and standing cost in its cost hero.
  - Monthly cost report: each electricity line's detail says how its kWh divide (standing, serving our sessions, other work), and a new `electricityByProject` (page table and PDF section) says which client the measured electricity served. Both are shares of the line's own integral, so lines and totals are what they were.
- **Demo seed.** uncloseai and agnt sessions now call `http://demo-node:8000/v1`; demo-node's GPU idles near 20 W and draws ~250 W while those sessions run; `buildDemoPayloads` runs the attribution before the payloads. The dashboard, fleet page and node page all show populated figures under `make demo`. Nothing new renders an empty state: each new panel renders nothing until a node has been sampled.

Decisions made on the way:

- **Idle is the 10th percentile, weighted by time, of the node's whole draw (CPU + GPUs) over the seven UTC days before the bucket's day.** A low percentile rather than the minimum, because a probe that failed to read the GPU writes a dip no idle box draws (zero readings are skipped outright). Seven days, so the window holds nights and a weekend yet follows a hardware change within a week. The days before only, so a day's idle does not move as the day goes on. A node with under six sampled hours before that day (the first day we see it) widens the window into the day itself, up to now. Known limit: a node busy more than 90% of a week reads part of its work as standing.
- **Whole-node watts, not GPU only.** The cost report's electricity line integrates CPU + GPU, so the split does too: standing + active equals that line's kWh exactly, and inference CPU draw counts as active.
- **Split key is estimated GPU-seconds** (`pricing.selfHostWeight`, decode ~30x a prefill token, a cache read a tenth of a prefill one), not raw tokens, so a cache-heavy agent loop does not take the bill of the model actually generating. Message count when no group has a weight.
- **Active draw no message of ours explains stays unattributed** ("other work"): another client of the same vLLM, a training run, a build. When our messages are in the bucket, all of its active draw goes to them, a known overstatement while other clients share the node.
- **Granularity is model, project and harness**, not session: session keys would multiply rows by orders of magnitude for a view nobody asked for yet.
- **GPU summing** was already done per node by both probes; the two copies of the nvidia-smi loop are now one (`packages/core/gpu-sum.ts`), tested with multi-card and `[N/A]` rows. Per-device attribution waits on sampling `--query-compute-apps`.
- **The 5-minute sample gap rule is now inclusive** (`<= 5 min`), shared by the cost report and the attribution (`energy-attribution.integrable`). Real 15 s samples never sit exactly five minutes apart; the demo's 5-minute samples previously integrated to nothing. A rebuild (`rebuild=1`) of a month sampled at exactly 5-minute gaps reads that energy; filed months are served as filed and do not change, and a test holds a filed report unchanged after the attribution tables fill.

Not done: per-CUDA-device attribution (needs `--query-compute-apps` sampled), per-session energy, and the `electricity_rate_<host>` setting on the node page's Settings tab still differs from the node economics rate the report and this attribution use (a pre-existing split, left as found).
