/**
 * A node's mesh history, shaped for its charts.
 *
 * The derivation lived in a useMemo inside a 1,592-line page component, so
 * every rule in it — what a missing field falls back to, how GPU memory is
 * scaled, what an hour of electricity costs — could only be checked by
 * looking at a chart and deciding whether it seemed right.
 */

import { utcToLocalDate } from './local-time';

export interface NodeSeriesPoint {
  /** Charts read these by name, so a row has to be key-addressable. */
  [key: string]: number | string;
  /** Epoch milliseconds, which is what uPlot plots against. */
  tsMs: number;
  timestamp: string;
  watts: number;
  cpuWatts: number;
  gpuWatts: number;
  load: number;
  cores: number;
  memUsedGB: number;
  memTotalGB: number;
  memCapGB: number;
  claudes: number;
  agents: number;
  gpuUtil: number;
  gpuMemUsedGB: number;
  gpuMemTotalGB: number;
  elecCostPerHour: number;
}

interface Snapshot {
  timestamp: string;
  nodes?: Record<string, Record<string, number | undefined>>;
}

export interface SeriesOptions {
  memTotalGB: number;
  memCapGB: number;
  /** Dollars per kWh, for the cost series. */
  kwhRate: number;
}

const gb = (mb: number | undefined) => Math.round(((mb ?? 0) / 1024) * 10) / 10;

/**
 * One row per snapshot that mentions this host.
 *
 * Snapshots covering other nodes are dropped rather than plotted as zero: a
 * gap in a node's history is missing data, and drawing it as 0W would claim
 * the machine was off.
 */
export function toNodeSeries(
  timeline: Snapshot[] | undefined,
  host: string,
  { memTotalGB, memCapGB, kwhRate }: SeriesOptions,
): NodeSeriesPoint[] {
  if (!Array.isArray(timeline)) return [];

  return timeline
    .filter((t) => t.nodes?.[host])
    .map((t) => {
      const n = t.nodes![host];
      const watts = n.watts ?? 0;
      return {
        tsMs: utcToLocalDate(t.timestamp).getTime(),
        timestamp: t.timestamp,
        watts,
        // The CPU line is what is left after the GPU, so the two stack to
        // the total rather than double-counting it.
        cpuWatts: watts - (n.gpuWatts ?? 0),
        gpuWatts: n.gpuWatts ?? 0,
        load: n.load ?? 0,
        cores: n.cores ?? 0,
        memUsedGB: n.memUsed ?? 0,
        memTotalGB,
        memCapGB,
        claudes: n.claudes ?? 0,
        // Every harness. Falls back to the claude count for history recorded
        // before agent processes were counted, so old series still plot.
        agents: n.agents ?? n.claudes ?? 0,
        gpuUtil: n.gpuUtil ?? 0,
        gpuMemUsedGB: gb(n.gpuMemUsedMB),
        gpuMemTotalGB: gb(n.gpuMemTotalMB),
        elecCostPerHour: Math.round((watts / 1000) * kwhRate * 100) / 100,
      };
    });
}

/** The span a series covers, for pan and zoom decisions. */
export function seriesBounds(points: { tsMs: number }[]): { min: number; max: number } | null {
  if (points.length === 0) return null;
  return { min: points[0].tsMs, max: points[points.length - 1].tsMs };
}
