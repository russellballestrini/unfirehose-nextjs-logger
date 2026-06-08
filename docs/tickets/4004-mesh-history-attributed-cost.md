# 4004: Mesh-history-attributed cost for self-hosted models

**Status:** open
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
