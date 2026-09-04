/* eslint-disable @typescript-eslint/no-explicit-any */

/**
 * What a node card shows, derived once.
 *
 * A mesh probe answers differently depending on what the machine could tell
 * us and when the payload was recorded, so reading one meant a fallback on
 * almost every field. Twenty-five of those in a row inside a component is
 * how a card reaches fifty branches, and none of them could be checked
 * without rendering the card and looking at it.
 */

import { getEffectiveIspCost, type NodeEcon } from './mesh-score';

export interface NodeVitals {
  name: string;
  hostname?: string;
  reachable: boolean;
  /** Where its detail page lives — the name SSH knows it by. */
  probeHost: string;
  cpuCores: number;
  load1: number;
  /** Load as a share of cores, capped at 100. */
  loadPct: number;
  memTotalGB: number;
  memUsedGB: number;
  memPct: number;
  swapUsedGB: number;
  uptime?: string;
  agents: number;
  /** "3 claude, 1 codex" — empty when nothing is running. */
  agentLabel: string;
  hasGpu: boolean;
  gpuUtil: number;
  gpuVramUsedGB: number;
  gpuVramTotalGB: number;
  gpuVramPct: number;
}

const pct = (used: number, total: number) => (total > 0 ? Math.round((used / total) * 100) : 0);

export function nodeVitals(node: any, sshHost?: { name?: string; hostname?: string }): NodeVitals {
  const name = sshHost?.name ?? node?.hostname ?? '?';
  const cpuCores = node?.cpuCores ?? 0;
  const load1 = node?.loadAvg?.[0] ?? 0;
  const memTotalGB = node?.memTotalGB ?? 0;
  const memUsedGB = node?.memUsedGB ?? 0;

  // Every agent harness. claudeProcesses stays claude-only on older payloads,
  // so a node running five uncloseai-cli agents reported none until
  // harnessCounts arrived; it is preferred and the old field is the fallback.
  const counts: Record<string, number> = node?.harnessCounts ?? {};
  const fromCounts = Object.values(counts).reduce((a, b) => a + b, 0);

  const gpuUtil = node?.gpuUtil;
  const gpuMemTotalMB = node?.gpuMemTotalMB ?? 0;
  const gpuMemUsedMB = node?.gpuMemUsedMB ?? 0;

  return {
    name,
    hostname: sshHost?.hostname ?? node?.hostname,
    reachable: Boolean(node?.reachable),
    probeHost: sshHost?.hostname ?? sshHost?.name ?? node?.hostname ?? name,
    cpuCores,
    load1,
    loadPct: cpuCores > 0 ? Math.min(100, Math.round((load1 / cpuCores) * 100)) : 0,
    memTotalGB,
    memUsedGB,
    memPct: pct(memUsedGB, memTotalGB),
    swapUsedGB: node?.swapUsedGB ?? 0,
    uptime: node?.uptime,
    agents: fromCounts || (node?.claudeProcesses ?? 0),
    agentLabel: Object.entries(counts)
      .filter(([, n]) => n > 0)
      .map(([harness, n]) => `${n} ${harness}`)
      .join(', '),
    // A card with a GPU shows two more gauges; one that merely reports 0%
    // utilisation on no card should not.
    hasGpu: gpuMemTotalMB > 0 || (gpuUtil != null && gpuUtil > 0),
    gpuUtil: gpuUtil ?? 0,
    gpuVramUsedGB: gpuMemUsedMB / 1024,
    gpuVramTotalGB: gpuMemTotalMB / 1024,
    gpuVramPct: pct(gpuMemUsedMB, gpuMemTotalMB),
  };
}

export interface NodeCost {
  watts: number;
  gpuWatts: number;
  /** Dollars of electricity per month at this node's rate. */
  elecMonthly: number;
  /** This node's share of an ISP bill, which may be split with others. */
  ispMonthly: number;
  monthly: number;
  /** True when the line is shared, so the card can say so. */
  ispShared: boolean;
  /** Dollars per watt per month — what this node costs to keep running. */
  perWatt: number;
  /** Where the wattage came from: measured, estimated, or nowhere. */
  source: 'rapl' | 'tdp' | 'n/a';
}

const HOURS_PER_MONTH = 24 * 30;

export function nodeMonthlyCost(
  node: any,
  econ: NodeEcon,
  name: string,
  egressGroups?: Map<string, string[]>,
): NodeCost {
  const cpuWatts = node?.powerWatts ?? 0;
  const gpuWatts = node?.gpuPowerWatts ?? 0;
  const watts = cpuWatts + gpuWatts;

  const elecMonthly = ((watts * HOURS_PER_MONTH) / 1000) * econ.electricityCostKwh;
  // Nodes behind one connection split its bill; charging each the full line
  // rate would count the same money once per machine.
  const ispMonthly = egressGroups
    ? getEffectiveIspCost(name, econ.ispCostMonthly, egressGroups)
    : econ.ispCostMonthly;
  const monthly = elecMonthly + ispMonthly;

  return {
    watts,
    gpuWatts,
    elecMonthly,
    ispMonthly,
    monthly,
    ispShared: ispMonthly < econ.ispCostMonthly,
    perWatt: watts > 0 ? monthly / watts : 0,
    source: node?.powerSource === 'rapl' ? 'rapl' : node?.powerSource === 'tdp' ? 'tdp' : 'n/a',
  };
}

/**
 * A cloud container has no power meter, so its draw is estimated.
 *
 * Roughly 5W per core scaled by how busy it is, plus a little for memory,
 * plus whatever the GPU actually reports. The 20% floor is deliberate: a
 * container idling still occupies a host that is running, and billing it as
 * zero would make the fleet look free.
 */
export function estimateContainerWatts(probe: {
  cpuCores?: number; loadAvg?: number[]; memTotalGB?: number; gpuPowerWatts?: number;
} | undefined): number {
  const cores = probe?.cpuCores ?? 0;
  if (cores <= 0) return 0;

  const load = probe?.loadAvg?.[0] ?? 0;
  const busy = Math.max(0.2, load / cores);
  return Math.round(cores * 5 * busy + (probe?.memTotalGB ?? 0) * 0.4 + (probe?.gpuPowerWatts ?? 0));
}
