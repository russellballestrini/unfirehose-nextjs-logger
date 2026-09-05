import { NextRequest, NextResponse } from 'next/server';
import { harnessPsAwk, parseHarnessProcesses, countByHarness } from '@unturf/unfirehose/harness-procs';
import {
  type MeshNode, deduplicateNodes, parseRemoteProbe,
  lookupCpuTdp, lookupCpuYear, parseCpuModel, countSpinningDisks,
  calcSystemWatts, calcNonCpuWatts, formatUptime, round, memCapGB,
  countSsds, parseMeminfo, parseLoadavg,
} from '@/lib/mesh-probe';
import { execSync, execFile } from 'child_process';
import { readFileSync, readdirSync } from 'fs';
import { discoverNodes } from '@unturf/unfirehose/mesh';
import { Timing } from '@/lib/timing';
import { getLocalStats } from '@/lib/local-stats';

/* eslint-disable @typescript-eslint/no-explicit-any */


/**
 * Probe a remote node via a single SSH call that collects all stats,
 * RAPL power readings, and nvidia-smi data in one round-trip.
 */
function getRemoteStatsAsync(host: string): Promise<MeshNode> {
  // Single SSH command that gathers everything: stats, RAPL (with 100ms sleep), nvidia-smi
  // Use ; between sections so RAPL/GPU failures don't break the chain
  const remoteScript = [
    // Stats section (&&-chained — all must succeed)
    `{ hostname -f 2>/dev/null || hostname; } && nproc && grep -m1 "model name" /proc/cpuinfo && uname -m && { lsblk -d -o NAME,TYPE,SIZE,ROTA 2>/dev/null; echo "---LSBLK_END---"; } && cat /proc/meminfo && cat /proc/loadavg && cat /proc/uptime && ps aux 2>/dev/null | awk '${harnessPsAwk()}' | sed 's/^/HPROC /' && echo "---STATS_END---"`,
    // RAPL section (best-effort, semicolon-delimited)
    'R1=$(cat /sys/class/powercap/intel-rapl/intel-rapl:0/energy_uj 2>/dev/null); R1B=$(cat /sys/class/powercap/intel-rapl/intel-rapl:1/energy_uj 2>/dev/null); sleep 0.1; R2=$(cat /sys/class/powercap/intel-rapl/intel-rapl:0/energy_uj 2>/dev/null); R2B=$(cat /sys/class/powercap/intel-rapl/intel-rapl:1/energy_uj 2>/dev/null); echo "$R1 $R1B $R2 $R2B"; echo "---RAPL_END---"',
    // GPU section (best-effort)
    'nvidia-smi --query-gpu=power.draw,name,memory.total,memory.used,utilization.gpu --format=csv,noheader,nounits 2>/dev/null; echo "---GPU_END---"',
  ].join('; ');

  return new Promise((resolve) => {
    execFile('ssh', ['-o', 'ConnectTimeout=5', '-o', 'StrictHostKeyChecking=no', host, remoteScript],
      { encoding: 'utf-8', timeout: 12000 },
      (err, stdout) => {
        if (err) {
          resolve({
            hostname: host,
            reachable: false,
            error: err.message?.includes('ETIMEDOUT') ? 'Connection timed out' : 'Unreachable',
          });
          return;
        }

        try {
          resolve(parseRemoteProbe(host, stdout));
        } catch (parseErr: any) {
          resolve({ hostname: host, reachable: false, error: parseErr.message });
        }
      },
    );
  });
}

let meshCache: { data: any; ts: number } | null = null;
let refreshing = false;
const MESH_CACHE_TTL = 15_000; // 15 seconds

async function probeMesh(timing?: Timing) {
  const nodeHosts = discoverNodes();
  timing?.mark('discover');

  // Probe all nodes in parallel — local is sync, remote is async
  const rawResults = await Promise.all(
    nodeHosts.map(host =>
      host === 'localhost'
        ? Promise.resolve(getLocalStats())
        : getRemoteStatsAsync(host)
    )
  );
  timing?.mark('probe_all');

  const results = deduplicateNodes(rawResults);

  // Summary stats
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

  // Detect local hostname for clients to map mesh node → localhost
  let localHostname: string | undefined;
  try { localHostname = execSync('hostname', { encoding: 'utf-8' }).trim(); } catch {}
  timing?.mark('summarize');

  return {
    nodes: results,
    localHostname,
    summary: {
      totalNodes: nodeHosts.length,
      reachableNodes: reachable.length,
      totalClaudes,
      totalAgents,
      totalHarnessCounts,
      totalCores,
      totalMemGB: round(totalMemGB),
      totalMemUsedGB: round(totalMemUsedGB),
      totalPowerWatts: round(totalPowerWatts),
    },
  };
}

async function probeSingleHost(host: string) {
  // Reuses the same per-host helpers as probeMesh so the snapshot shape
  // matches what /api/mesh/history POST expects (flat MeshNode fields).
  // Bypasses the cache because callers want point-in-time samples.
  const node = host === 'localhost'
    ? getLocalStats()
    : await getRemoteStatsAsync(host);
  let localHostname: string | undefined;
  try { localHostname = execSync('hostname', { encoding: 'utf-8' }).trim(); } catch {}
  return { nodes: [node], localHostname, summary: undefined };
}

export async function GET(req: NextRequest) {
  const t = new Timing();
  // Single-host filter lets the headless worker stagger per-node probes
  // without changing the response shape clients consume (still { nodes: [...] }).
  const host = req.nextUrl.searchParams.get('host');
  if (host) {
    if (!/^[a-zA-Z0-9._-]+$/.test(host)) {
      return NextResponse.json({ error: 'Invalid host' }, { status: 400 });
    }
    const data = await probeSingleHost(host);
    t.mark('probe_single');
    return NextResponse.json(data, { headers: { 'Server-Timing': t.header() } });
  }

  const now = Date.now();

  // Fresh cache — serve immediately
  if (meshCache && (now - meshCache.ts) < MESH_CACHE_TTL) {
    t.mark('cache_fresh');
    return NextResponse.json(meshCache.data, { headers: { 'Server-Timing': t.header() } });
  }

  // Stale cache — serve stale, trigger background refresh
  if (meshCache && !refreshing) {
    refreshing = true;
    probeMesh().then(data => {
      meshCache = { data, ts: Date.now() };
      refreshing = false;
    }).catch(() => {
      refreshing = false;
    });
    t.mark('cache_stale_swr');
    return NextResponse.json(meshCache.data, { headers: { 'Server-Timing': t.header() } });
  }

  // Cold start (or stale + already refreshing) — probe synchronously
  const data = await probeMesh(t);
  meshCache = { data, ts: Date.now() };
  refreshing = false;
  return NextResponse.json(data, { headers: { 'Server-Timing': t.header() } });
}
