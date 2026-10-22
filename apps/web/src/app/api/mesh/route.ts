import { NextRequest, NextResponse } from 'next/server';
import {
  type MeshNode, deduplicateNodes, formatUptime, round, memCapGB,
} from '@/lib/mesh-probe';
import { execSync } from 'child_process';
import { discoverNodes } from '@unturf/unfirehose/mesh';
import { probeRemote } from '@unturf/unfirehose/mesh-remote';
import { getDb } from '@unturf/unfirehose/db/schema';
import { human } from '@unturf/unfirehose/ago';
import { Timing } from '@/lib/timing';
import { getLocalStats } from '@/lib/local-stats';

/* eslint-disable @typescript-eslint/no-explicit-any */

/**
 * GET /api/mesh — every node at once, and the totals across them.
 *
 * The worker's sampler (apps/worker/src/sampler.ts) already probes every
 * node every fifteen seconds and writes a mesh_snapshots row per node that
 * answered. This route serves the newest of those rows per host and does
 * not ssh on the request thread while any of them is fresh. Only when none
 * is — the worker is down, or just started — does it probe inline, as it
 * did before, with a short cache in front. `?live=1` forces that probe.
 *
 * A snapshot carries what moves: load, memory, watts, GPU, agents. What does
 * not — CPU model and year, disks, uptime, OS, containers, kind — is read
 * from the last full probe and laid under the snapshot, and that probe runs
 * behind a response, never in front of one.
 */

/**
 * How old a node's newest row may be and still be served.
 *
 * The sampler's interval is 15 s; a probe that fails writes nothing, and one
 * ssh attempt may take up to its 15 s timeout (core mesh-remote). Measured
 * 2026-10-14 over seven days of rows: the p99 gap between a host's samples
 * was 16 s; each host had 3–8 gaps between 30 and 60 s (one missed or slow
 * sample); every gap over 60 s was the sampler itself being down. Four
 * intervals rides through the former and reports the latter.
 */
const SNAPSHOT_FRESH_MS = 60_000;
/**
 * How often, at most, the full probe runs behind a snapshot-served response
 * to refresh the static facts. One ssh fan-out every five minutes while a
 * page is open, where it was one every fifteen seconds.
 */
const FACTS_REFRESH_MS = 5 * 60_000;
/** How long a live probe's answer is served as-is when no snapshot is fresh. */
const MESH_CACHE_TTL = 15_000;

/** Fields a snapshot row does not carry and a full probe does. */
const STATIC_FIELDS: readonly (keyof MeshNode)[] = [
  'cpuModel', 'cpuTdpWatts', 'cpuYear', 'arch', 'os', 'osRelease', 'userland', 'kind',
  'vms', 'containers', 'containersRunning', 'model', 'spinningDisks', 'ssdCount',
  'memCapGB', 'swapUsedGB', 'swapTotalGB', 'gpuModel',
];

interface MeshPayload {
  nodes: MeshNode[];
  localHostname: string | undefined;
  summary: ReturnType<typeof summarize>;
}

interface SnapshotRow {
  id: number;
  timestamp: string;
  hostname: string;
  cpu_cores: number | null;
  load_avg_1: number | null;
  load_avg_5: number | null;
  load_avg_15: number | null;
  mem_total_gb: number | null;
  mem_used_gb: number | null;
  power_watts: number | null;
  gpu_power_watts: number | null;
  gpu_util: number | null;
  gpu_mem_used_mb: number | null;
  gpu_mem_total_mb: number | null;
  power_source: string | null;
  claude_processes: number | null;
  harness_counts: string | null;
}

/** The last full probe: served when nothing fresher exists, mined for facts otherwise. */
let meshCache: { data: MeshPayload; ts: number } | null = null;
let refreshing = false;
/** ssh alias → the hostname its node answered with, learned from full probes. */
const probedHostname = new Map<string, string>();
let localHostnameMemo: string | undefined;

/** `hostname`, once per process: it was 14 ms of blocked request thread per call. */
function localHostname(): string | undefined {
  if (localHostnameMemo === undefined) {
    try { localHostnameMemo = execSync('hostname', { encoding: 'utf-8' }).trim(); } catch {}
  }
  return localHostnameMemo;
}

function summarize(results: MeshNode[], totalNodes: number) {
  const reachable = results.filter(n => n.reachable);
  const totalClaudes = reachable.reduce((s, n) => s + (n.claudeProcesses ?? 0), 0);
  // Fleet-wide per-harness totals. totalClaudes stays claude-only so existing
  // callers keep their meaning; totalAgents is what the pages should show.
  const totalHarnessCounts: Record<string, number> = {};
  for (const n of reachable) {
    for (const [k, v] of Object.entries(n.harnessCounts ?? {})) {
      totalHarnessCounts[k] = (totalHarnessCounts[k] ?? 0) + (v as number);
    }
  }
  const totalAgents = Object.values(totalHarnessCounts).reduce((a, b) => a + b, 0) || totalClaudes;
  const totalCores = reachable.reduce((s, n) => s + (n.cpuCores ?? 0), 0);
  const totalMemGB = reachable.reduce((s, n) => s + (n.memTotalGB ?? 0), 0);
  const totalMemUsedGB = reachable.reduce((s, n) => s + (n.memUsedGB ?? 0), 0);
  const totalPowerWatts = reachable.reduce((s, n) => s + (n.powerWatts ?? 0) + (n.gpuPowerWatts ?? 0), 0);
  return {
    totalNodes,
    reachableNodes: reachable.length,
    totalClaudes,
    totalAgents,
    totalHarnessCounts,
    totalCores,
    totalMemGB: round(totalMemGB),
    totalMemUsedGB: round(totalMemUsedGB),
    totalPowerWatts: round(totalPowerWatts),
  };
}

async function probeMesh(timing?: Timing): Promise<MeshPayload> {
  const nodeHosts = discoverNodes();
  timing?.mark('discover');

  // Probe all nodes in parallel.
  const rawResults = await Promise.all(
    nodeHosts.map(host =>
      host === 'localhost'
        ? getLocalStats()
        : probeRemote(host)
    )
  );
  timing?.mark('probe_all');
  rawResults.forEach((n, i) => { if (n.reachable) probedHostname.set(nodeHosts[i], n.hostname); });

  const results = deduplicateNodes(rawResults);
  const summary = summarize(results, nodeHosts.length);
  timing?.mark('summarize');

  return { nodes: results, localHostname: localHostname(), summary };
}

function refreshInBackground(): void {
  refreshing = true;
  probeMesh()
    .then(data => { meshCache = { data, ts: Date.now() }; })
    .catch(() => {})
    .finally(() => { refreshing = false; });
}

// ── Snapshots ────────────────────────────────────────────────────────────────

/** mesh_snapshots.timestamp is datetime('now'): 'YYYY-MM-DD HH:MM:SS', UTC. */
const sqliteTime = (ms: number) => new Date(ms).toISOString().replace('T', ' ').slice(0, 19);
const parseSqliteTime = (s: string) => Date.parse(s.replace(' ', 'T') + 'Z');

/** The newest row per host written inside the freshness bound. */
function freshSnapshots(now: number): Map<string, SnapshotRow> {
  // A range on the timestamp index: a minute of rows is a few dozen. The
  // `GROUP BY hostname` form of this walked the whole (hostname, timestamp)
  // index for the same answer — 117 ms over 444k rows, measured 2026-10-14.
  const rows = getDb().prepare(`
    SELECT id, timestamp, hostname, cpu_cores, load_avg_1, load_avg_5, load_avg_15,
           mem_total_gb, mem_used_gb, power_watts, gpu_power_watts, gpu_util,
           gpu_mem_used_mb, gpu_mem_total_mb, power_source, claude_processes, harness_counts
    FROM mesh_snapshots WHERE timestamp > ?
  `).all(sqliteTime(now - SNAPSHOT_FRESH_MS)) as SnapshotRow[];
  const latest = new Map<string, SnapshotRow>();
  for (const r of rows) {
    const cur = latest.get(r.hostname);
    if (!cur || r.id > cur.id) latest.set(r.hostname, r);
  }
  return latest;
}

/** When any of these names was last sampled, or null if never. An index seek per call. */
function lastSampleAt(names: string[]): number | null {
  const unique = [...new Set(names.filter(Boolean))];
  if (unique.length === 0) return null;
  const row = getDb().prepare(
    `SELECT MAX(timestamp) AS ts FROM mesh_snapshots WHERE hostname IN (${unique.map(() => '?').join(',')})`,
  ).get(...unique) as { ts: string | null } | undefined;
  return row?.ts ? parseSqliteTime(row.ts) : null;
}

/**
 * The same box under two names: an alias and the fqdn the box reports, or
 * `hostname` against `hostname -f`. Mesh hostnames and ssh hostnames do not
 * line up, so a page matches them this way too.
 */
function sameBox(a: string, b: string): boolean {
  return a === b || a.startsWith(b + '.') || b.startsWith(a + '.');
}

function nodeFromSnapshot(row: SnapshotRow, facts: MeshNode | undefined, factsAgeMs: number): MeshNode {
  const node: MeshNode = { hostname: row.hostname, reachable: true };
  if (facts) {
    for (const k of STATIC_FIELDS) {
      if (facts[k] !== undefined) (node as any)[k] = facts[k];
    }
    if (facts.uptimeSeconds !== undefined) {
      // Uptime kept counting since the probe that read it.
      node.uptimeSeconds = Math.round(facts.uptimeSeconds + factsAgeMs / 1000);
      node.uptime = formatUptime(node.uptimeSeconds);
    }
  }
  const memTotal = row.mem_total_gb ?? 0;
  const memUsed = row.mem_used_gb ?? 0;
  // A probe leaves these undefined when it has no figure; the row stores 0.
  node.cpuCores = row.cpu_cores || undefined;
  node.memTotalGB = memTotal;
  node.memUsedGB = memUsed;
  node.memAvailableGB = round(memTotal - memUsed);
  node.memCapGB ??= memCapGB(memTotal);
  node.loadAvg = [row.load_avg_1 ?? 0, row.load_avg_5 ?? 0, row.load_avg_15 ?? 0];
  node.powerWatts = row.power_watts || undefined;
  node.gpuPowerWatts = row.gpu_power_watts || undefined;
  if (row.gpu_util !== null) node.gpuUtil = row.gpu_util;
  if (row.gpu_mem_used_mb !== null) node.gpuMemUsedMB = row.gpu_mem_used_mb;
  // A card's memory is a capacity, and a page decides it has a GPU by it; a
  // sample that missed nvidia-smi (6 rows in 13,906 this week) keeps it.
  const gpuMemTotal = row.gpu_mem_total_mb ?? facts?.gpuMemTotalMB;
  if (gpuMemTotal !== undefined && gpuMemTotal !== null) node.gpuMemTotalMB = gpuMemTotal;
  // insertMeshSnapshots writes 'estimate' where the probe had no source.
  if (row.power_source && row.power_source !== 'estimate') node.powerSource = row.power_source as MeshNode['powerSource'];
  node.claudeProcesses = row.claude_processes ?? 0;
  if (row.harness_counts) {
    try { node.harnessCounts = JSON.parse(row.harness_counts); } catch {}
  }
  return node;
}

/**
 * The mesh as the worker last saw it, or null when no node has a row inside
 * the bound. A discovered host with no fresh row is reported the way a
 * failed probe reports it — unreachable, with a reason — not probed here.
 */
function fromSnapshots(now: number, t: Timing): { payload: MeshPayload; computedAt: number } | null {
  const hosts = discoverNodes();
  t.mark('discover');
  const fresh = freshSnapshots(now);
  t.mark('snapshots');
  if (fresh.size === 0) return null;

  const local = localHostname();
  const facts = new Map<string, MeshNode>();
  for (const n of meshCache?.data.nodes ?? []) if (n.reachable) facts.set(n.hostname, n);
  const factsAge = meshCache ? now - meshCache.ts : 0;

  // Walk ssh config order, the order the live path answers in. The rows
  // themselves arrive in timestamp order, so taking them as they came put
  // whichever host had sampled earliest inside the window first — and the
  // sampler's phases rotate against the window, so the fleet page shuffled
  // its cards on every reload.
  const nodes: MeshNode[] = [];
  let oldest = now;
  const unclaimed = new Map(fresh);
  const take = (row: SnapshotRow) => {
    unclaimed.delete(row.hostname);
    nodes.push(nodeFromSnapshot(row, facts.get(row.hostname), factsAge));
    oldest = Math.min(oldest, parseSqliteTime(row.timestamp));
  };
  for (const host of hosts) {
    const name = probedHostname.get(host) ?? (host === 'localhost' ? local : undefined) ?? host;
    const key = [...unclaimed.keys()].find(s => sameBox(s, name));
    if (key) { take(unclaimed.get(key)!); continue; }
    const last = lastSampleAt([name, host, name.split('.')[0]]);
    nodes.push({
      hostname: name,
      reachable: false,
      error: last === null ? 'No sample yet' : `Last sample ${human(last)}`,
    });
  }
  // A box ssh config no longer lists but the sampler still wrote: shown
  // after the configured ones, in a fixed order.
  for (const row of [...unclaimed.values()].sort((a, b) => a.hostname.localeCompare(b.hostname))) take(row);
  const results = deduplicateNodes(nodes);
  t.mark('assemble');
  return {
    payload: { nodes: results, localHostname: local, summary: summarize(results, hosts.length) },
    computedAt: oldest,
  };
}

// ── Route ────────────────────────────────────────────────────────────────────

async function probeSingleHost(host: string) {
  // Reuses the same per-host helpers as probeMesh so the snapshot shape
  // matches what /api/mesh/history POST expects (flat MeshNode fields).
  // Bypasses the cache because callers want point-in-time samples.
  const node = host === 'localhost'
    ? await getLocalStats()
    : await probeRemote(host);
  return { nodes: [node], localHostname: localHostname(), summary: undefined };
}

export async function GET(req: NextRequest) {
  const t = new Timing();
  const params = req.nextUrl.searchParams;
  // Single-host filter lets the headless worker stagger per-node probes
  // without changing the response shape clients consume (still { nodes: [...] }).
  const host = params.get('host');
  if (host) {
    if (!/^[a-zA-Z0-9._-]+$/.test(host)) {
      return NextResponse.json({ error: 'Invalid host' }, { status: 400 });
    }
    const data = await probeSingleHost(host);
    t.mark('probe_single');
    return NextResponse.json(data, { headers: { 'Server-Timing': t.header() } });
  }

  const now = Date.now();
  // X-Computed-At is the oldest sample the answer rests on, so staleness is
  // visible from a terminal; X-Mesh-Source says which path answered.
  const respond = (data: MeshPayload, source: 'snapshots' | 'cache' | 'live', computedAt: number) =>
    NextResponse.json(data, {
      headers: {
        'Server-Timing': t.header(),
        'X-Mesh-Source': source,
        'X-Computed-At': new Date(computedAt).toISOString(),
      },
    });

  // ?live=1 — the inline probe, for when the worker's view is in doubt.
  if (params.get('live') === '1') {
    const data = await probeMesh(t);
    meshCache = { data, ts: Date.now() };
    return respond(data, 'live', meshCache.ts);
  }

  // The worker's snapshots, with static facts from the last full probe laid
  // under them. A database fault here is not a reason to answer nothing.
  let snap: ReturnType<typeof fromSnapshots> = null;
  try {
    snap = fromSnapshots(now, t);
  } catch (err) {
    console.error('[mesh] snapshot read failed, probing live:', err);
  }
  if (snap) {
    if ((!meshCache || now - meshCache.ts > FACTS_REFRESH_MS) && !refreshing) refreshInBackground();
    return respond(snap.payload, 'snapshots', snap.computedAt);
  }

  // No fresh snapshot: the sampler is down or has not finished its first
  // pass. Probe as before, with a short cache and stale-while-revalidate.
  if (meshCache && (now - meshCache.ts) < MESH_CACHE_TTL) {
    t.mark('cache_fresh');
    return respond(meshCache.data, 'cache', meshCache.ts);
  }
  if (meshCache && !refreshing) {
    refreshInBackground();
    t.mark('cache_stale_swr');
    return respond(meshCache.data, 'cache', meshCache.ts);
  }
  const data = await probeMesh(t);
  meshCache = { data, ts: Date.now() };
  refreshing = false;
  return respond(data, 'live', meshCache.ts);
}
