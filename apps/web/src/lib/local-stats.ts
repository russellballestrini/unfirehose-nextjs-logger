/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * This machine, described the same way a probed node is.
 *
 * The mesh summary treats localhost as one node among the rest, so whatever
 * SSH brings back from a remote box has to be produced here from /proc,
 * /sys and a few commands. Power is the part that differs: RAPL and
 * nvidia-smi are real measurements available only locally, and everything
 * else on the mesh is a TDP estimate.
 *
 * Separate from the route because Next validates a `route.ts` export
 * surface — a named export there fails the build, and with it goes any way
 * to reach this from a test.
 */

import { execSync } from 'child_process';
import { readFileSync, readdirSync } from 'fs';
import { harnessPsAwk, parseHarnessProcesses, countByHarness } from '@unturf/unfirehose/harness-procs';
import {
  type MeshNode, lookupCpuTdp, lookupCpuYear, parseCpuModel, countSpinningDisks,
  calcSystemWatts, calcNonCpuWatts, formatUptime, round, memCapGB, countSsds,
  parseMeminfo, parseLoadavg,
} from '@/lib/mesh-probe';

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
export function getLocalStats(): MeshNode {
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

    // Memory from /proc/meminfo (more precise than free), through the same
    // parsers the remote probe uses — the two read identical formats.
    const mem = parseMeminfo(readFileSync('/proc/meminfo', 'utf-8'));
    const memTotal = mem.totalGB;
    const memAvailable = mem.availableGB;
    const swapTotal = mem.swapTotalGB;
    const swapFree = mem.swapFreeGB;

    const loadAvg = parseLoadavg(readFileSync('/proc/loadavg', 'utf-8'));

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
      ssdCount = countSsds(lsblk);
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
