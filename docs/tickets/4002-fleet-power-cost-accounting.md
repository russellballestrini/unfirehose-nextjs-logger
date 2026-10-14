# 4002 — Fleet power-cost accounting (CPU + GPU watts)

**Status:** done (2026-10-14)
**Project:** unfirehose-nextjs-logger
**Owner:** blackops

## Problem

GPU wattage is already collected (`nvidia-smi --query-gpu=power.draw` in
`apps/web/src/app/api/mesh/route.ts`) and persisted to `mesh_snapshots`. Per-node
cards and the per-node Economics tab already fold electricity into their dollar
figures. But the **fleet-level** accounting on `/permacomputer` drops power
entirely:

- `computeMeshScore.totalMonthlyCost` sums **only ISP cost** — no electricity, CPU or GPU.
- The "By Provider" breakdown is ISP-only too.
- The node efficiency score uses `powerWatts` only, ignoring `gpuPowerWatts`, so GPU nodes look artificially efficient.
- No fleet-level chart to gauge power/cost over time (charts exist only on node-detail + usage pages).
- Price-per-watt ($/W·mo) lives only in the Economics tab, not on the grid cards or fleet summary.

## Plan

All edits in `apps/web/src/app/permacomputer/page.tsx` (single file).

1. `computeMeshScore`: compute per-node electricity (`(cpuW+gpuW)*24*30/1000 * $/kWh`),
   roll into `totalMonthlyCost`, and return `totalElecCost`, `totalIspCost`,
   `totalWatts`, `totalGpuWatts`. Derive a blended fleet `$/kWh` for charting.
2. Efficiency score: use `cpuW + gpuW`.
3. `byProvider`: add electricity to per-provider cost so the breakdown matches the all-in total.
4. Mesh Economics summary grid: keep all-in Monthly Cost (with elec/isp sub-split),
   add **Power (W)** and **$/W·mo** stats.
5. Grid `NodeCard`: add **$/W·mo** to the power+cost row.
6. Add a fleet **Power & Cost** chart section (uPlot, not recharts) to `MeshEconomicsPanel`,
   sourced from `/api/mesh/history?hours=24&hostname=all` (CPU+GPU stacked watts +
   electricity $/hr using the blended rate).

## Single source of truth

Blended fleet `$/kWh` = `totalElecCost * 1000 / (totalWatts * 24 * 30)` — derived from
real per-node rates so the chart's cost line stays consistent with the headline number.

## What shipped

Steps 1, 2, 4 and 5 had already landed when this was picked back up on
2026-10-14: `computeMeshScore` (since moved to `apps/web/src/lib/mesh-score.ts`)
returns `totalElecCost`, `totalIspCost`, `totalWatts`, `totalGpuWatts` and a
`blendedKwhRate`; efficiency scores `nodeTotalWatts` (CPU + GPU); the summary
grid shows the elec/isp split, Power with its GPU share, and $/W·mo; the node
card shows $/W·mo via `nodeMonthlyCost`. The fleet chart existed as
`FleetMetricsChart` on uPlot (`UPlotTimeChart`), fed by
`/api/mesh/history?hours=N&hostname=all`, which the route accepts.

Closed out on 2026-10-14, all in `apps/web/src/app/permacomputer/page.tsx`:

- **Step 3.** `byProvider` was still ISP-only while its percentages divided by
  the all-in total, so the bars never summed to the headline. It now adds
  `nodeElecMonthly` per node; each row's tooltip carries the elec/isp split.
- **Step 6.** The fleet Power chart drew the total and per-host lines but
  never the CPU/GPU split it had already computed. Dashed CPU and GPU series
  now appear whenever any node reports GPU draw, and the heading shows the
  GPU share. The $/hr series falls back to `getKwhRate()` from
  `@unturf/unfirehose/pricing` when no node has reported watts yet, so it is
  never flat at $0 before the first probe.
- Tests in `panels.test.tsx`: GPU share in the heading, $/hr at the blended
  rate, the rate fallback, and the provider breakdown matching the headline.

Not done here: `HARDCODED_DEFAULTS.electricityCostKwh` in `lib/mesh-score.ts`
is 0.31 while core `DEFAULT_KWH_RATE` is 0.33. Per-node settings override it
so the fleet numbers are right whenever econ is configured, but the two
defaults should become one.
