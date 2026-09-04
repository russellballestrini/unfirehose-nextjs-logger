import { NextRequest, NextResponse } from 'next/server';
import { harnessPsAwk, parseHarnessProcesses, countByHarness } from '@unturf/unfirehose/harness-procs';
import {
  type MeshNode, deduplicateNodes, parseRemoteProbe,
  lookupCpuTdp, lookupCpuYear, parseCpuModel, countSpinningDisks,
  calcSystemWatts, calcNonCpuWatts, formatUptime, round, memCapGB,
} from '@/lib/mesh-probe';
import { execSync, execFile } from 'child_process';
import { readFileSync, readdirSync } from 'fs';
import { discoverNodes } from '@unturf/unfirehose/mesh';
import { Timing } from '@/lib/timing';

/* eslint-disable @typescript-eslint/no-explicit-any */

function readRaplWatts(): number | null {
  try {
    const basePath = '/sys/class/powercap/intel-rapl';
    const packages = readdirSync(basePath).filter((d: string) => /^intel-rapl:\d+$/.test(d));
    if (packages.length === 0) return null;

    // First reading
    const read1: number[] = [];
    for (const pkg of packages) {
      const val = readFileSync(`${basePath}/${pkg}/energy_uj`, 'utf-8').trim();
      read1.push(parseInt(val));
    }

    // Wait 100ms
    execSync('sleep 0.1');

    // Second reading
    const read2: number[] = [];
    for (const pkg of packages) {
      const val = readFileSync(`${basePath}/${pkg}/energy_uj`, 'utf-8').trim();
      read2.push(parseInt(val));
    }

    let totalUj = 0;
    for (let i = 0; i < packages.length; i++) {
      let delta = read2[i] - read1[i];
      if (delta < 0) delta += 2 ** 32; // counter wrapped
      totalUj += delta;
    }

    // Convert microjoules over 0.1s to watts: watts = uj / (interval_s * 1e6)
    return round(totalUj / (0.1 * 1e6));
  } catch {
    return null;
  }
}

/**
 * Read GPU power from nvidia-smi. Returns null if not available.
 */
function readNvidiaPowerWatts(): number | null {
  try {
    const output = execSync('nvidia-smi --query-gpu=power.draw --format=csv,noheader,nounits 2>/dev/null', {
      encoding: 'utf-8',
      timeout: 5000,
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    // Sum all GPUs
    const total = output.split('\n').reduce((sum, line) => {
      const w = parseFloat(line.trim());
      return sum + (isNaN(w) ? 0 : w);
    }, 0);
    return total > 0 ? round(total) : null;
  } catch {
    return null;
  }
}

/**
 * Look up TDP for a CPU model string. Returns watts or null if unknown.
 */
function getLocalStats(): MeshNode {
  try {
    let hostname = execSync('hostname', { encoding: 'utf-8' }).trim();
    try {
      const fqdn = execSync('hostname -f', { encoding: 'utf-8' }).trim();
      if (fqdn && fqdn.includes('.')) hostname = fqdn;
    } catch { /* no FQDN available */ }

    // CPU cores and model
    const cpuCores = parseInt(execSync('nproc', { encoding: 'utf-8' }).trim());
    const cpuinfo = readFileSync('/proc/cpuinfo', 'utf-8');
    const cpuModel = parseCpuModel(cpuinfo);

    // Memory from /proc/meminfo (more precise than free)
    const meminfo = readFileSync('/proc/meminfo', 'utf-8');
    const memTotal = parseInt(meminfo.match(/MemTotal:\s+(\d+)/)?.[1] ?? '0') / 1024 / 1024;
    const memAvailable = parseInt(meminfo.match(/MemAvailable:\s+(\d+)/)?.[1] ?? '0') / 1024 / 1024;
    const swapTotal = parseInt(meminfo.match(/SwapTotal:\s+(\d+)/)?.[1] ?? '0') / 1024 / 1024;
    const swapFree = parseInt(meminfo.match(/SwapFree:\s+(\d+)/)?.[1] ?? '0') / 1024 / 1024;

    // Load average
    const loadavg = readFileSync('/proc/loadavg', 'utf-8').trim().split(/\s+/);
    const loadAvg: [number, number, number] = [
      parseFloat(loadavg[0]),
      parseFloat(loadavg[1]),
      parseFloat(loadavg[2]),
    ];

    // Uptime
    const uptimeSeconds = parseFloat(readFileSync('/proc/uptime', 'utf-8').split(/\s/)[0]);
    const uptime = formatUptime(uptimeSeconds);

    // Agent harness processes. Counted per harness, not just claude:
    // uncloseai-cli runs as `python3 .../unclose`, so a basename match on
    // column 11 reported zero while five agents were running.
    let claudeProcesses = 0;
    let harnessCounts: Record<string, number> = {};
    try {
      const ps = execSync(
        `ps aux 2>/dev/null | awk '${harnessPsAwk()}' | sed 's/^/HPROC /'`,
        { encoding: 'utf-8', shell: '/bin/sh' },
      );
      const procs = parseHarnessProcesses(
        ps.split('\n').filter((l) => l.startsWith('HPROC ')).map((l) => l.slice(6)).join('\n'),
      );
      harnessCounts = countByHarness(procs);
      claudeProcesses = harnessCounts.claude ?? 0;
    } catch { /* no harnesses running */ }

    // Disk inventory
    let spinningDisks = 0;
    let ssdCount = 0;
    try {
      const lsblk = execSync('lsblk -d -o NAME,TYPE,SIZE,ROTA 2>/dev/null', { encoding: 'utf-8' });
      spinningDisks = countSpinningDisks(lsblk);
      ssdCount = lsblk.split('\n').filter(l => {
        const p = l.trim().split(/\s+/);
        return p[1] === 'disk' && p[p.length - 1] === '0';
      }).length;
    } catch { /* no lsblk */ }

    const isServer = cpuModel ? /xeon|epyc/i.test(cpuModel) : false;
    const isLaptop = cpuModel ? /[0-9]U\b|[0-9]G[1-7]\b/i.test(cpuModel) : false;

    // Architecture
    let arch: string | undefined;
    try { arch = execSync('uname -m', { encoding: 'utf-8' }).trim(); } catch { /* ignore */ }

    // Power monitoring: try RAPL first, then TDP-based system calc
    const raplWatts = readRaplWatts();
    const gpuWatts = readNvidiaPowerWatts();
    const cpuTdpWatts = cpuModel ? lookupCpuTdp(cpuModel) : null;

    // GPU details from nvidia-smi
    let gpuModel: string | undefined;
    let gpuMemTotalMB: number | undefined;
    let gpuMemUsedMB: number | undefined;
    let gpuUtil: number | undefined;
    try {
      const nvOut = execSync('nvidia-smi --query-gpu=name,memory.total,memory.used,utilization.gpu --format=csv,noheader,nounits 2>/dev/null', { encoding: 'utf-8', timeout: 5000 }).trim();
      if (nvOut) {
        for (const line of nvOut.split('\n')) {
          const parts = line.split(',').map(s => s.trim());
          if (!gpuModel && parts[0]) gpuModel = parts[0];
          if (parts[1]) gpuMemTotalMB = (gpuMemTotalMB ?? 0) + (parseFloat(parts[1]) || 0);
          if (parts[2]) gpuMemUsedMB = (gpuMemUsedMB ?? 0) + (parseFloat(parts[2]) || 0);
          if (parts[3]) gpuUtil = Math.max(gpuUtil ?? 0, parseFloat(parts[3]) || 0);
        }
      }
    } catch { /* no nvidia-smi */ }
    let powerWatts: number | undefined;
    let powerSource: MeshNode['powerSource'];

    if (raplWatts !== null) {
      // RAPL = CPU package only — add RAM, disks, baseline, PSU loss
      powerWatts = raplWatts + calcNonCpuWatts({ memTotalGB: memTotal, spinningDisks, ssdCount, isServer, isLaptop });
      powerSource = 'rapl';
    } else if (cpuTdpWatts !== null) {
      powerWatts = calcSystemWatts({
        tdpWatts: cpuTdpWatts, cores: cpuCores, load1m: loadAvg[0],
        memTotalGB: memTotal, spinningDisks, ssdCount, isServer, isLaptop,
      });
      powerSource = 'tdp';
    }

    return {
      hostname,
      reachable: true,
      cpuModel: cpuModel ?? undefined,
      cpuTdpWatts: cpuTdpWatts ?? undefined,
      spinningDisks,
      ssdCount,
      cpuCores,
      memTotalGB: round(memTotal),
      memCapGB: memCapGB(memTotal),
      memUsedGB: round(memTotal - memAvailable),
      memAvailableGB: round(memAvailable),
      loadAvg,
      uptime,
      uptimeSeconds,
      cpuYear: cpuModel ? lookupCpuYear(cpuModel) ?? undefined : undefined,
      claudeProcesses,
      harnessCounts,
      swapTotalGB: round(swapTotal),
      swapUsedGB: round(swapTotal - swapFree),
      powerWatts,
      gpuPowerWatts: gpuWatts ?? undefined,
      gpuModel,
      gpuMemTotalMB: gpuMemTotalMB ? Math.round(gpuMemTotalMB) : undefined,
      gpuMemUsedMB: gpuMemUsedMB ? Math.round(gpuMemUsedMB) : undefined,
      gpuUtil,
      arch,
      powerSource,
    };
  } catch (e: any) {
    return { hostname: 'localhost', reachable: false, error: String(e) };
  }
}

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
