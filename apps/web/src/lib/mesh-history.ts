/* eslint-disable @typescript-eslint/no-explicit-any */

/**
 * Turning mesh snapshot rows into a timeline a chart can draw.
 *
 * Three rules live here, each of which was a defect before it was a rule,
 * and all three sat inside a route handler where nothing could reach them:
 *
 *   dedup      a node can appear several times in one bucket, because the
 *              dashboard POSTs snapshots from every open page. Summing every
 *              row multiplies the fleet's wattage by the number of tabs.
 *   peaks      decimation keeps the real sample with the highest draw in each
 *              bucket rather than averaging. Averaging flattens exactly the
 *              spikes the chart exists to show, and every point that survives
 *              is still a measurement that actually happened.
 *   fallbacks  a column added later reads as its predecessor for older rows,
 *              so history recorded before it existed still plots.
 */

export interface SnapshotRow {
  timestamp: string;
  hostname: string;
  cpu_cores?: number;
  load_avg_1?: number;
  mem_total_gb?: number;
  mem_used_gb?: number;
  power_watts?: number;
  gpu_power_watts?: number;
  gpu_util?: number;
  gpu_mem_used_mb?: number;
  gpu_mem_total_mb?: number;
  claude_processes?: number;
  agent_processes?: number;
  harness_counts?: string;
}

export interface TimelinePoint {
  timestamp: string;
  totalWatts: number;
  cpuWatts: number;
  gpuWatts: number;
  avgLoad: number;
  totalLoad: number;
  totalCores: number;
  memUsedGB: number;
  memTotalGB: number;
  gpuUtil: number;
  gpuMemUsedGB: number;
  gpuMemTotalGB: number;
  claudes: number;
  nodeCount: number;
  nodes?: Record<string, any>;
}

const round1 = (n: number) => Math.round(n * 10) / 10;

/** Round a SQLite timestamp down to the start of its bucket. */
export function bucketTimestamp(ts: string, bucketSec: number): string {
  const isoMs = Date.parse(`${ts.replace(' ', 'T')}Z`);
  if (!isoMs) return ts.slice(0, 16);
  const bucketMs = Math.floor(isoMs / (bucketSec * 1000)) * bucketSec * 1000;
  return new Date(bucketMs).toISOString().replace('T', ' ').slice(0, 19);
}

/**
 * Fleet totals per bucket, from rows ordered oldest first.
 *
 * Within a bucket the last row for a hostname wins, so a node reported five
 * times contributes once.
 */
export function rollupTimeline(rows: SnapshotRow[], bucketSec = 15): TimelinePoint[] {
  const byTime = new Map<string, Map<string, any>>();

  for (const r of rows) {
    const bucket = bucketTimestamp(r.timestamp, bucketSec);
    let nodes = byTime.get(bucket);
    if (!nodes) { nodes = new Map(); byTime.set(bucket, nodes); }

    nodes.set(r.hostname, {
      cpuWatts: r.power_watts ?? 0,
      gpuWatts: r.gpu_power_watts ?? 0,
      watts: (r.power_watts ?? 0) + (r.gpu_power_watts ?? 0),
      load: r.load_avg_1 ?? 0,
      cores: r.cpu_cores ?? 0,
      memUsed: r.mem_used_gb ?? 0,
      memTotal: r.mem_total_gb ?? 0,
      claudes: r.claude_processes ?? 0,
      agents: r.agent_processes ?? r.claude_processes ?? 0,
      harnessCounts: parseHarnessCounts(r.harness_counts),
      gpuUtil: r.gpu_util ?? undefined,
      gpuMemUsedMB: r.gpu_mem_used_mb ?? 0,
      gpuMemTotalMB: r.gpu_mem_total_mb ?? 0,
    });
  }

  return [...byTime.entries()].map(([timestamp, nodes]) => {
    const list = [...nodes.values()];
    const sum = (pick: (n: any) => number) => list.reduce((s, n) => s + pick(n), 0);

    const cpuWatts = sum((n) => n.cpuWatts);
    const gpuWatts = sum((n) => n.gpuWatts);
    const totalLoad = sum((n) => n.load);
    const totalCores = sum((n) => n.cores);

    // Only nodes that have a GPU at all, so a fleet average is not dragged
    // toward zero by the machines that could never report one.
    const gpuNodes = list.filter((n) => n.gpuUtil != null || n.gpuMemTotalMB > 0);
    const gpuSum = (pick: (n: any) => number) => gpuNodes.reduce((s, n) => s + pick(n), 0);

    return {
      timestamp,
      totalWatts: round1(cpuWatts + gpuWatts),
      cpuWatts: round1(cpuWatts),
      gpuWatts: round1(gpuWatts),
      avgLoad: totalCores > 0 ? Math.round((totalLoad / totalCores) * 100) / 100 : 0,
      totalLoad: round1(totalLoad),
      totalCores,
      memUsedGB: round1(sum((n) => n.memUsed)),
      memTotalGB: round1(sum((n) => n.memTotal)),
      gpuUtil: gpuNodes.length > 0 ? round1(gpuSum((n) => n.gpuUtil ?? 0) / gpuNodes.length) : 0,
      gpuMemUsedGB: round1(gpuSum((n) => n.gpuMemUsedMB) / 1024),
      gpuMemTotalGB: round1(gpuSum((n) => n.gpuMemTotalMB) / 1024),
      claudes: sum((n) => n.claudes),
      nodeCount: list.length,
      nodes: Object.fromEntries(nodes),
    };
  });
}

function parseHarnessCounts(raw: string | undefined): Record<string, number> | undefined {
  if (!raw) return undefined;
  try { return JSON.parse(raw); } catch { return undefined; }
}

/**
 * At most `maxPoints`, keeping the busiest real sample from each bucket.
 *
 * Measured 2026-09-04: 24h returned 5,646 points at 15 fields plus a
 * per-node breakdown, 7.97 MB, polled every 6 seconds into a chart about
 * 1,100px wide. Four of every five points could not be drawn.
 */
export function decimatePeaks(timeline: TimelinePoint[], maxPoints: number): TimelinePoint[] {
  if (timeline.length <= maxPoints) return timeline;

  const bucketSize = timeline.length / maxPoints;
  const picked: TimelinePoint[] = [];

  for (let b = 0; b < maxPoints; b++) {
    const start = Math.floor(b * bucketSize);
    const end = Math.min(timeline.length, Math.floor((b + 1) * bucketSize));
    if (end <= start) continue;

    let best = timeline[start];
    for (let i = start + 1; i < end; i++) {
      if (timeline[i].totalWatts > best.totalWatts) best = timeline[i];
    }
    picked.push(best);
  }

  return picked;
}

/**
 * Distinct hostnames, without the short form of a name we also have in full.
 *
 * A node reached as both `cammy` and `cammy.foxhop.net` is one machine, and
 * listing both offers a filter that splits its own history in half.
 */
export function distinctHostnames(rows: { hostname: string }[]): string[] {
  const all = [...new Set(rows.map((r) => r.hostname))];
  return all.filter((h) => !all.some((other) => other !== h && other.startsWith(`${h}.`)));
}
