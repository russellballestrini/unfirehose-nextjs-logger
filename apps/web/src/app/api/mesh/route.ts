import { NextResponse } from 'next/server';
import { execSync } from 'child_process';
import { readFileSync, readdirSync } from 'fs';
import { discoverNodes } from '@unfirehose/core/mesh';

/* eslint-disable @typescript-eslint/no-explicit-any */

interface MeshNode {
  hostname: string;
  reachable: boolean;
  cpuCores?: number;
  memTotalGB?: number;
  memUsedGB?: number;
  memAvailableGB?: number;
  loadAvg?: [number, number, number];
  uptime?: string;
  claudeProcesses?: number;
  swapUsedGB?: number;
  swapTotalGB?: number;
  powerWatts?: number;
  gpuPowerWatts?: number;
  powerSource?: 'rapl' | 'nvidia' | 'estimate';
  error?: string;
}

// Deduplicate nodes that resolve to the same host
function deduplicateNodes(nodes: MeshNode[]): MeshNode[] {
  const seen = new Map<string, MeshNode>();
  for (const node of nodes) {
    if (!node.reachable) {
      // Only add unreachable if we don't already have a reachable version
      if (!seen.has(node.hostname)) seen.set(node.hostname, node);
    } else {
      // Reachable always wins
      seen.set(node.hostname, node);
    }
  }
  return [...seen.values()];
}

/**
 * Read RAPL energy counters — requires readable /sys/class/powercap/intel-rapl/
 * Takes two readings 100ms apart and computes watts from delta.
 * Returns null if RAPL is unavailable or unreadable.
 */
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
    const output = execSync('nvidia-smi --query-gpu=power.draw --format=csv,noheader,nounits', {
      encoding: 'utf-8',
      timeout: 5000,
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
 * Estimate power from CPU cores and load average.
 * Rough model: idle ~10W/core, loaded ~40W/core, linear interpolation.
 */
function estimateWattsFromLoad(cores: number, load1m: number): number {
  const idlePerCore = 10;
  const loadedPerCore = 40;
  const utilization = Math.min(load1m / cores, 1);
  return round(cores * (idlePerCore + utilization * (loadedPerCore - idlePerCore)));
}

function getLocalStats(): MeshNode {
  try {
    const hostname = execSync('hostname', { encoding: 'utf-8' }).trim();

    // CPU cores
    const cpuCores = parseInt(execSync('nproc', { encoding: 'utf-8' }).trim());

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

    // Claude processes
    let claudeProcesses = 0;
    try {
      const ps = execSync("ps aux | grep -i '[c]laude' | wc -l", { encoding: 'utf-8' });
      claudeProcesses = parseInt(ps.trim()) || 0;
    } catch { /* no claudes */ }

    // Power monitoring: try RAPL, then nvidia-smi, then estimate
    const raplWatts = readRaplWatts();
    const gpuWatts = readNvidiaPowerWatts();
    let powerWatts: number | undefined;
    let powerSource: MeshNode['powerSource'];

    if (raplWatts !== null) {
      powerWatts = raplWatts;
      powerSource = 'rapl';
    } else {
      powerWatts = estimateWattsFromLoad(cpuCores, loadAvg[0]);
      powerSource = 'estimate';
    }

    return {
      hostname,
      reachable: true,
      cpuCores,
      memTotalGB: round(memTotal),
      memUsedGB: round(memTotal - memAvailable),
      memAvailableGB: round(memAvailable),
      loadAvg,
      uptime,
      claudeProcesses,
      swapTotalGB: round(swapTotal),
      swapUsedGB: round(swapTotal - swapFree),
      powerWatts,
      gpuPowerWatts: gpuWatts ?? undefined,
      powerSource,
    };
  } catch (e: any) {
    return { hostname: 'localhost', reachable: false, error: String(e) };
  }
}

function getRemoteStats(host: string): MeshNode {
  try {
    // Main stats command
    const cmd = `ssh -o ConnectTimeout=5 -o StrictHostKeyChecking=no ${host} 'hostname && nproc && cat /proc/meminfo && cat /proc/loadavg && cat /proc/uptime && ps aux | grep -i "[c]laude" | wc -l'`;
    const output = execSync(cmd, { encoding: 'utf-8', timeout: 10000 });
    const lines = output.trim().split('\n');

    const hostname = lines[0];
    const cpuCores = parseInt(lines[1]);

    // Parse meminfo from remote
    const meminfoLines = lines.slice(2);
    const meminfoText = meminfoLines.join('\n');
    const memTotal = parseInt(meminfoText.match(/MemTotal:\s+(\d+)/)?.[1] ?? '0') / 1024 / 1024;
    const memAvailable = parseInt(meminfoText.match(/MemAvailable:\s+(\d+)/)?.[1] ?? '0') / 1024 / 1024;
    const swapTotal = parseInt(meminfoText.match(/SwapTotal:\s+(\d+)/)?.[1] ?? '0') / 1024 / 1024;
    const swapFree = parseInt(meminfoText.match(/SwapFree:\s+(\d+)/)?.[1] ?? '0') / 1024 / 1024;

    // Find loadavg line (5 space-separated numbers/fractions)
    const loadLine = meminfoLines.find(l => /^\d+\.\d+\s+\d+\.\d+\s+\d+\.\d+/.test(l));
    const loadParts = loadLine?.split(/\s+/) ?? ['0', '0', '0'];
    const loadAvg: [number, number, number] = [
      parseFloat(loadParts[0]),
      parseFloat(loadParts[1]),
      parseFloat(loadParts[2]),
    ];

    // Find uptime line (single or two numbers)
    const uptimeLine = meminfoLines.find(l => /^\d+\.\d+\s+\d+\.\d+$/.test(l.trim()));
    const uptimeSeconds = parseFloat(uptimeLine?.split(/\s/)[0] ?? '0');
    const uptime = formatUptime(uptimeSeconds);

    // Last line is claude count
    const claudeProcesses = parseInt(lines[lines.length - 1]) || 0;

    // Power monitoring via separate SSH calls (non-blocking — we don't want to slow down the main stats)
    let powerWatts: number | undefined;
    let gpuPowerWatts: number | undefined;
    let powerSource: MeshNode['powerSource'] = 'estimate';

    // Try RAPL on remote (two readings 100ms apart)
    try {
      const raplCmd = `ssh -o ConnectTimeout=3 -o StrictHostKeyChecking=no ${host} 'R1=$(cat /sys/class/powercap/intel-rapl/intel-rapl:0/energy_uj 2>/dev/null); R1B=$(cat /sys/class/powercap/intel-rapl/intel-rapl:1/energy_uj 2>/dev/null); sleep 0.1; R2=$(cat /sys/class/powercap/intel-rapl/intel-rapl:0/energy_uj 2>/dev/null); R2B=$(cat /sys/class/powercap/intel-rapl/intel-rapl:1/energy_uj 2>/dev/null); echo "$R1 $R1B $R2 $R2B"'`;
      const raplOut = execSync(raplCmd, { encoding: 'utf-8', timeout: 8000 }).trim();
      const parts = raplOut.split(/\s+/).map(Number);
      if (parts.length >= 2 && !isNaN(parts[0]) && !isNaN(parts[2])) {
        let delta0 = parts[2] - parts[0];
        if (delta0 < 0) delta0 += 2 ** 32;
        let delta1 = 0;
        if (!isNaN(parts[1]) && !isNaN(parts[3])) {
          delta1 = parts[3] - parts[1];
          if (delta1 < 0) delta1 += 2 ** 32;
        }
        const watts = round((delta0 + delta1) / (0.1 * 1e6));
        if (watts > 0 && watts < 10000) { // sanity check
          powerWatts = watts;
          powerSource = 'rapl';
        }
      }
    } catch { /* RAPL not available */ }

    // Try nvidia-smi on remote
    try {
      const nvCmd = `ssh -o ConnectTimeout=3 -o StrictHostKeyChecking=no ${host} 'nvidia-smi --query-gpu=power.draw --format=csv,noheader,nounits 2>/dev/null'`;
      const nvOut = execSync(nvCmd, { encoding: 'utf-8', timeout: 8000 }).trim();
      if (nvOut) {
        const total = nvOut.split('\n').reduce((sum, line) => {
          const w = parseFloat(line.trim());
          return sum + (isNaN(w) ? 0 : w);
        }, 0);
        if (total > 0) gpuPowerWatts = round(total);
      }
    } catch { /* no nvidia-smi */ }

    // Fall back to estimation
    if (!powerWatts) {
      powerWatts = estimateWattsFromLoad(cpuCores, loadAvg[0]);
      powerSource = 'estimate';
    }

    return {
      hostname,
      reachable: true,
      cpuCores,
      memTotalGB: round(memTotal),
      memUsedGB: round(memTotal - memAvailable),
      memAvailableGB: round(memAvailable),
      loadAvg,
      uptime,
      claudeProcesses,
      swapTotalGB: round(swapTotal),
      swapUsedGB: round(swapTotal - swapFree),
      powerWatts,
      gpuPowerWatts: gpuPowerWatts ?? undefined,
      powerSource,
    };
  } catch (e: any) {
    return {
      hostname: host,
      reachable: false,
      error: e.message?.includes('ETIMEDOUT') ? 'Connection timed out' : 'Unreachable',
    };
  }
}

function formatUptime(seconds: number): string {
  const days = Math.floor(seconds / 86400);
  const hours = Math.floor((seconds % 86400) / 3600);
  const mins = Math.floor((seconds % 3600) / 60);
  if (days > 0) return `${days}d ${hours}h`;
  if (hours > 0) return `${hours}h ${mins}m`;
  return `${mins}m`;
}

function round(n: number): number {
  return Math.round(n * 10) / 10;
}

export async function GET() {
  const nodeHosts = discoverNodes();

  const rawResults: MeshNode[] = [];

  for (const host of nodeHosts) {
    if (host === 'localhost') {
      rawResults.push(getLocalStats());
    } else {
      rawResults.push(getRemoteStats(host));
    }
  }

  const results = deduplicateNodes(rawResults);

  // Summary stats
  const reachable = results.filter(n => n.reachable);
  const totalClaudes = reachable.reduce((s, n) => s + (n.claudeProcesses ?? 0), 0);
  const totalCores = reachable.reduce((s, n) => s + (n.cpuCores ?? 0), 0);
  const totalMemGB = reachable.reduce((s, n) => s + (n.memTotalGB ?? 0), 0);
  const totalMemUsedGB = reachable.reduce((s, n) => s + (n.memUsedGB ?? 0), 0);
  const totalPowerWatts = reachable.reduce((s, n) => s + (n.powerWatts ?? 0) + (n.gpuPowerWatts ?? 0), 0);

  return NextResponse.json({
    nodes: results,
    summary: {
      totalNodes: nodeHosts.length,
      reachableNodes: reachable.length,
      totalClaudes,
      totalCores,
      totalMemGB: round(totalMemGB),
      totalMemUsedGB: round(totalMemUsedGB),
      totalPowerWatts: round(totalPowerWatts),
    },
  });
}
