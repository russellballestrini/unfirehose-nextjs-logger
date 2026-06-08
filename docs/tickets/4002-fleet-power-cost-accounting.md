# 4002 — Fleet power-cost accounting (CPU + GPU watts)

**Status:** in progress
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
6. Add a fleet **Power & Cost** chart section (recharts) to `MeshEconomicsPanel`,
   sourced from `/api/mesh/history?hours=24&hostname=all` (CPU+GPU stacked watts +
   electricity $/hr using the blended rate).

## Single source of truth

Blended fleet `$/kWh` = `totalElecCost * 1000 / (totalWatts * 24 * 30)` — derived from
real per-node rates so the chart's cost line stays consistent with the headline number.
