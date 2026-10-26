// Energy from cumulative counters (ticket 4013, grade B).
//
// A probe keeps two counters beside its watts estimate: RAPL energy_uj per
// CPU package, which wraps at the package's max_energy_range_uj (about
// 262 kJ, an hour at 80 W), and NVML's total energy consumption in
// millijoules, 64-bit, which only ever goes backwards when the driver
// reloads. Differencing either between two samples gives exact joules for
// the interval however long it was; integrating a watts reading sampled
// every 15 s does not.
//
// Pure. Shared by the energy ledger (energy-attribution.ts) and the mesh
// rollup in the worker, so hot and cold rows agree on what "measured" means.

export interface EnergyCounters {
  /** RAPL per package: the counter and its wrap point, both µJ. */
  cpu?: Array<{ uj: number; max: number }> | null;
  /** NVML millijoules, summed over a node's GPUs. */
  gpuMj?: number | null;
}

export type EnergyGrade = 'B' | 'C';

/** A bucket is grade B when at least this share of its sampled time came from counters. */
export const MEASURED_COVERAGE = 0.95;

const UJ_PER_WH = 3.6e9;
const MJ_PER_WH = 3.6e6;

/** Parse the cpu_energy_json column; anything malformed is "no counter". */
export function parseCpuEnergyJson(raw: string | null | undefined): EnergyCounters['cpu'] {
  if (!raw) return null;
  try {
    const v = JSON.parse(raw);
    if (!Array.isArray(v)) return null;
    const out: Array<{ uj: number; max: number }> = [];
    for (const p of v) {
      if (!p || typeof p.uj !== 'number' || typeof p.max !== 'number' || !(p.max > 0)) return null;
      out.push({ uj: p.uj, max: p.max });
    }
    return out.length ? out : null;
  } catch { return null; }
}

/**
 * Energy between two samples from their counters. `cpuWh` is null when
 * either sample lacks RAPL or the package list changed shape; a negative
 * package delta is a wrap and adds that package's range once. `gpuWh` is
 * null when either lacks NVML, or when the counter went backwards, which is
 * a driver reload: that interval is unknown, not guessed.
 */
export function counterDeltaWh(prev: EnergyCounters, next: EnergyCounters): { cpuWh: number | null; gpuWh: number | null } {
  let cpuWh: number | null = null;
  if (prev.cpu && next.cpu && prev.cpu.length > 0 && prev.cpu.length === next.cpu.length) {
    let uj = 0;
    let ok = true;
    for (let i = 0; i < prev.cpu.length; i++) {
      let d = next.cpu[i].uj - prev.cpu[i].uj;
      if (d < 0) d += prev.cpu[i].max;
      // Still negative, or more than one full range: not the same counter.
      if (d < 0 || d > prev.cpu[i].max) { ok = false; break; }
      uj += d;
    }
    if (ok) cpuWh = uj / UJ_PER_WH;
  }
  let gpuWh: number | null = null;
  if (prev.gpuMj != null && next.gpuMj != null && Number.isFinite(prev.gpuMj) && Number.isFinite(next.gpuMj)) {
    const d = next.gpuMj - prev.gpuMj;
    gpuWh = d >= 0 ? d / MJ_PER_WH : null;
  }
  return { cpuWh, gpuWh };
}

/**
 * Whether an interval between two samples is measured end to end: the CPU
 * counter moved, and the GPU counter did too wherever the node reports GPU
 * power at all. A node without a GPU is measured by RAPL alone.
 */
export function measuredIntervalWh(
  prev: EnergyCounters & { gpuWatts?: number }, next: EnergyCounters & { gpuWatts?: number },
): { wh: number; gpuWh: number } | null {
  const d = counterDeltaWh(prev, next);
  if (d.cpuWh == null) return null;
  const hasGpu = (prev.gpuWatts ?? 0) > 0 || (next.gpuWatts ?? 0) > 0 || prev.gpuMj != null || next.gpuMj != null;
  if (hasGpu && d.gpuWh == null) return null;
  const gpuWh = d.gpuWh ?? 0;
  return { wh: d.cpuWh + gpuWh, gpuWh };
}

/** B when measured time covers the sampled time; C otherwise, including nothing sampled. */
export function gradeFor(measuredHours: number, sampledHours: number): EnergyGrade {
  return sampledHours > 0 && measuredHours / sampledHours >= MEASURED_COVERAGE ? 'B' : 'C';
}
