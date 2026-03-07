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
  cpuModel?: string;
  cpuTdpWatts?: number;
  spinningDisks?: number;
  ssdCount?: number;
  powerWatts?: number;
  gpuPowerWatts?: number;
  powerSource?: 'rapl' | 'nvidia' | 'tdp';
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
 * TDP lookup table — maps CPU model substrings to TDP in watts.
 * Checked against Intel ARK / AMD product specs.
 */
const CPU_TDP_TABLE: [RegExp, number][] = [
  // Intel mobile U-series (ultrabook)
  [/i[357]-[0-9]{4}U/i, 15],
  [/i[357]-1[0-3]\d{2}U/i, 15],   // 10th-13th gen U
  [/i[357]-1[0-3]\d{2}G[1-7]/i, 15], // Ice Lake G-series
  // Intel mobile P-series
  [/i[357]-1[2-4]\d{2}P/i, 28],
  // Intel mobile H-series
  [/i[357]-[0-9]{4}H\b/i, 45],
  [/i[357]-1[0-3]\d{2}H\b/i, 45],
  [/i[79]-1[0-3]\d{2}H\b/i, 45],
  [/i[79]-[0-9]{4}HK/i, 45],
  [/i[79]-1[0-3]\d{2}HK/i, 45],
  [/i[79]-1[0-3]\d{2}HX/i, 55],
  // Intel desktop T-series (low power)
  [/i[357]-[0-9]{4}T/i, 35],
  // Intel desktop S-series (standard)
  [/i[357]-[0-9]{4}\b/i, 65],
  [/i[357]-1[0-3]\d{3}\b/i, 65],
  [/i7-[0-9]{4}K/i, 91],
  [/i9-[0-9]{4}K/i, 125],
  [/i9-1[0-4]\d{3}K/i, 125],
  // Intel Xeon E5 v1/v2/v3/v4
  [/Xeon.*E5-26[0-9]{2}\s*v4/i, 105],
  [/Xeon.*E5-26[0-9]{2}\s*v3/i, 120],
  [/Xeon.*E5-26[0-9]{2}\s*v2/i, 95],
  [/Xeon.*E5-26[0-9]{2}(\s+0|\s+@)/i, 115],  // v1 (E5-2670 0 @ or E5-2680 @)
  [/Xeon.*E5-24[0-9]{2}/i, 80],
  // Intel Xeon E3
  [/Xeon.*E3-12[0-9]{2}/i, 80],
  // Intel Xeon W
  [/Xeon.*W-[0-9]{4}/i, 140],
  // Intel Xeon Scalable (Gold/Silver/Platinum)
  [/Xeon.*Gold/i, 150],
  [/Xeon.*Silver/i, 85],
  [/Xeon.*Platinum/i, 205],
  // AMD Ryzen mobile
  [/Ryzen [357] [0-9]{4}U/i, 15],
  [/Ryzen [79] [0-9]{4}U/i, 15],
  [/Ryzen [357] [0-9]{4}H/i, 35],
  [/Ryzen [79] [0-9]{4}H/i, 45],
  [/Ryzen [79] [0-9]{4}HX/i, 55],
  // AMD Ryzen desktop
  [/Ryzen [357] [0-9]{4}X?\b/i, 65],
  [/Ryzen [79] [0-9]{4}X?\b/i, 105],
  [/Ryzen 9 [0-9]{4}X3D/i, 120],
  // AMD EPYC
  [/EPYC\s+7[0-9]{3}/i, 155],
  [/EPYC\s+9[0-9]{3}/i, 200],
  // ARM / Apple (if ever showing up)
  [/Cortex-A7[0-9]/i, 5],
  [/Neoverse/i, 60],
];

/**
 * Look up TDP for a CPU model string. Returns watts or null if unknown.
 */
function lookupCpuTdp(model: string): number | null {
  for (const [pattern, tdp] of CPU_TDP_TABLE) {
    if (pattern.test(model)) return tdp;
  }
  return null;
}

/**
 * Read CPU model name from /proc/cpuinfo text.
 */
function parseCpuModel(cpuinfoOrText: string): string | null {
  const match = cpuinfoOrText.match(/model name\s*:\s*(.+)/i);
  return match ? match[1].trim() : null;
}

/**
 * Count spinning disks (ROTA=1, not loop devices) from lsblk.
 */
function countSpinningDisks(lsblkOutput: string): number {
  return lsblkOutput.split('\n').filter(l => {
    const parts = l.trim().split(/\s+/);
    return parts[1] === 'disk' && parts[parts.length - 1] === '1';
  }).length;
}

/**
 * Calculate total system power draw from components:
 * - CPU: TDP scaled by load (20% idle to 100% at full load)
 * - RAM: ~4W per DIMM (estimate 1 DIMM per 32GB for servers, per 8GB for desktops)
 * - Spinning disks: ~8W each
 * - SSDs/NVMe: ~3W each
 * - Motherboard + fans: ~25W server, ~5W laptop
 * - PSU efficiency loss: ~10% (servers/desktops only, laptops use DC adapter)
 */
function calcSystemWatts(opts: {
  tdpWatts: number;
  cores: number;
  load1m: number;
  memTotalGB: number;
  spinningDisks: number;
  ssdCount: number;
  isServer: boolean;
  isLaptop: boolean;
}): number {
  const cpuIdle = 0.2;
  const utilization = Math.min(opts.load1m / opts.cores, 1.1);
  const cpuWatts = opts.tdpWatts * (cpuIdle + utilization * (1 - cpuIdle));

  // RAM: servers use larger DIMMs (~3W each), laptops use SODIMMs (~2W each)
  const dimmSize = opts.isServer ? 32 : 8;
  const wattsPerDimm = opts.isLaptop ? 2 : 3;
  const ramWatts = Math.ceil(opts.memTotalGB / dimmSize) * wattsPerDimm;
  const hddWatts = opts.spinningDisks * 8;
  const ssdWatts = opts.ssdCount * 3;
  const baselineWatts = opts.isLaptop ? 5 : (opts.isServer ? 25 : 15);

  const subtotal = cpuWatts + ramWatts + hddWatts + ssdWatts + baselineWatts;
  return round(opts.isLaptop ? subtotal : subtotal / 0.9);
}

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

    // Claude processes
    let claudeProcesses = 0;
    try {
      const ps = execSync("ps aux | grep -i '[c]laude' | wc -l", { encoding: 'utf-8' });
      claudeProcesses = parseInt(ps.trim()) || 0;
    } catch { /* no claudes */ }

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

    // Power monitoring: try RAPL first, then TDP-based system calc
    const raplWatts = readRaplWatts();
    const gpuWatts = readNvidiaPowerWatts();
    const cpuTdpWatts = cpuModel ? lookupCpuTdp(cpuModel) : null;
    let powerWatts: number | undefined;
    let powerSource: MeshNode['powerSource'];

    if (raplWatts !== null) {
      powerWatts = raplWatts;
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
    // Main stats command (includes cpuinfo model name and disk inventory)
    const cmd = `ssh -o ConnectTimeout=5 -o StrictHostKeyChecking=no ${host} 'hostname -f 2>/dev/null || hostname && nproc && grep -m1 "model name" /proc/cpuinfo && lsblk -d -o NAME,TYPE,SIZE,ROTA 2>/dev/null && echo "---LSBLK_END---" && cat /proc/meminfo && cat /proc/loadavg && cat /proc/uptime && ps aux | grep -i "[c]laude" | wc -l'`;
    const output = execSync(cmd, { encoding: 'utf-8', timeout: 10000 });
    const lines = output.trim().split('\n');

    // Prefer the SSH config host if it's a FQDN, otherwise use what the remote reported
    const remoteHostname = lines[0];
    const hostname = host.includes('.') ? host : (remoteHostname.includes('.') ? remoteHostname : host);
    const cpuCores = parseInt(lines[1]);

    // CPU model is on line 2 (grep output: "model name : ...")
    const cpuModel = parseCpuModel(lines[2]);

    // Find the lsblk section (between line 3 and ---LSBLK_END---)
    const lsblkEndIdx = lines.findIndex(l => l.trim() === '---LSBLK_END---');
    let spinningDisks = 0;
    let ssdCount = 0;
    if (lsblkEndIdx > 3) {
      const lsblkText = lines.slice(3, lsblkEndIdx).join('\n');
      spinningDisks = countSpinningDisks(lsblkText);
      ssdCount = lsblkText.split('\n').filter(l => {
        const p = l.trim().split(/\s+/);
        return p[1] === 'disk' && p[p.length - 1] === '0';
      }).length;
    }

    // Parse meminfo from remote (starts after lsblk end marker)
    const meminfoLines = lines.slice(lsblkEndIdx > 0 ? lsblkEndIdx + 1 : 3);
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

    // Power monitoring
    const cpuTdpWatts = cpuModel ? lookupCpuTdp(cpuModel) : null;
    const isServer = cpuModel ? /xeon|epyc/i.test(cpuModel) : false;
    const isLaptop = cpuModel ? /[0-9]U\b|[0-9]G[1-7]\b/i.test(cpuModel) : false;
    let powerWatts: number | undefined;
    let gpuPowerWatts: number | undefined;
    let powerSource: MeshNode['powerSource'] | undefined;

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

    // Fall back to TDP-based system calculation
    if (!powerWatts && cpuTdpWatts !== null) {
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

  // Detect local hostname for clients to map mesh node → localhost
  let localHostname: string | undefined;
  try { localHostname = execSync('hostname', { encoding: 'utf-8' }).trim(); } catch {}

  return NextResponse.json({
    nodes: results,
    localHostname,
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
