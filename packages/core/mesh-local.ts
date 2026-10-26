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
 * Asynchronous, and in two halves. The worker samples this node every
 * fifteen seconds on the thread that also ingests and builds every payload;
 * as nine execSync calls and a blocking `sleep 0.1` it held that thread for
 * ~0.6 s a sample (measured 2026-09-17, ~7 s of every three minutes). The
 * facts that cannot change while the process lives — hostname, cores, CPU
 * model, disks, architecture — are read once. What moves is read each
 * sample, concurrently, through execFile with no shell.
 *
 * Separate from the route because Next validates a `route.ts` export
 * surface — a named export there fails the build, and with it goes any way
 * to reach this from a test.
 */

import { execFile } from 'child_process';
import { readFile, readdir } from 'fs/promises';
import { cpus, type as osType, release as osRelease } from 'os';
import { setTimeout as sleep } from 'timers/promises';
import { raplCounters } from './userland/parse';
import { harnessPsAwk, parseHarnessProcesses, countByHarness } from './harness-procs';
import {
  type MeshNode, lookupCpuTdp, lookupCpuYear, parseCpuModel, countSpinningDisks,
  calcSystemWatts, calcNonCpuWatts, formatUptime, round, memCapGB, countSsds,
  parseMeminfo, parseLoadavg,
} from './mesh-probe';
import { sumNvidiaRows } from './gpu-sum';

/** A command's trimmed stdout, or null for any failure: absent, timed out, non-zero. */
function run(file: string, args: string[], opts: { timeoutMs?: number; shell?: boolean } = {}): Promise<string | null> {
  return new Promise((resolve) => {
    execFile(file, args, { encoding: 'utf-8', timeout: opts.timeoutMs ?? 5000, shell: opts.shell ?? false }, (err, stdout) => {
      resolve(err ? null : String(stdout).trim());
    });
  });
}

const readText = (p: string) => readFile(p, 'utf-8').catch(() => null);

/**
 * Package energy over a 100 ms window. The wait is a timer, not a child
 * process sleeping while the event loop cannot turn.
 */
async function readRapl(): Promise<{ watts: number | null; counters?: MeshNode['cpuEnergy'] }> {
  const basePath = '/sys/class/powercap/intel-rapl';
  const packages = (await readdir(basePath).catch(() => [] as string[])).filter((d) => /^intel-rapl:\d+$/.test(d));
  if (packages.length === 0) return { watts: null };
  const readAll = () => Promise.all(packages.map((pkg) => readText(`${basePath}/${pkg}/energy_uj`)));
  const read1 = await readAll();
  await sleep(100);
  const [read2, maxes] = await Promise.all([
    readAll(),
    Promise.all(packages.map((pkg) => readText(`${basePath}/${pkg}/max_energy_range_uj`))),
  ]);
  // The second read is the counter we keep (4013): differenced against the
  // next sample's it is exact energy, where the watts are a 100 ms estimate.
  const counters = raplCounters(read2.map((v) => (v === null ? NaN : parseInt(v))), maxes.map((v) => (v === null ? NaN : parseInt(v))));
  return { watts: raplWatts(read1, read2, 0.1), counters };
}

/** NVML's cumulative GPU energy, millijoules summed over GPUs; null where the bindings are not installed. */
async function readNvmlEnergyMj(): Promise<number | null> {
  const out = await run('python3', ['-c',
    'import pynvml as n;n.nvmlInit();print(" ".join(str(n.nvmlDeviceGetTotalEnergyConsumption(n.nvmlDeviceGetHandleByIndex(i))) for i in range(n.nvmlDeviceGetCount())))'],
    { timeoutMs: 3000 });
  if (!out) return null;
  const vals = out.trim().split(/\s+/).map(Number);
  if (!vals.length || !vals.every((v) => Number.isFinite(v) && v >= 0)) return null;
  return vals.reduce((a, v) => a + v, 0);
}

/**
 * Watts from two reads of every package's energy_uj, `intervalS` apart.
 * Null when any package could not be read either time: a partial sum would
 * understate the machine. Each counter is 32 bits and wraps.
 */
export function raplWatts(read1: (string | null)[], read2: (string | null)[], intervalS: number): number | null {
  let totalUj = 0;
  for (let i = 0; i < read1.length; i++) {
    if (read1[i] === null || read2[i] === null) return null;
    let delta = parseInt(read2[i]!) - parseInt(read1[i]!);
    if (delta < 0) delta += 2 ** 32; // counter wrapped
    totalUj += delta;
  }
  // Microjoules over the interval to watts: uj / (interval_s * 1e6).
  return round(totalUj / (intervalS * 1e6));
}

export interface NvidiaReading { watts: number | null; model?: string; memTotalMB?: number; memUsedMB?: number; util?: number }

/** One nvidia-smi call carries power and utilisation for every GPU. */
async function readNvidia(): Promise<NvidiaReading> {
  return parseNvidiaSmi(await run('nvidia-smi', ['--query-gpu=power.draw,name,memory.total,memory.used,utilization.gpu', '--format=csv,noheader,nounits']));
}

/**
 * `nvidia-smi --query-gpu=power.draw,name,memory.total,memory.used,utilization.gpu
 * --format=csv,noheader,nounits`, one line per GPU. Every card in this box,
 * summed: a node is the unit we price (gpu-sum.ts).
 */
export function parseNvidiaSmi(out: string | null): NvidiaReading {
  if (!out) return { watts: null };
  const g = sumNvidiaRows(out.split('\n'));
  return { watts: g.watts != null ? round(g.watts) : null, model: g.model, memTotalMB: g.memTotalMB, memUsedMB: g.memUsedMB, util: g.util };
}

interface StaticFacts {
  hostname: string;
  cpuCores: number;
  cpuModel: string | null;
  spinningDisks: number;
  ssdCount: number;
  arch?: string;
}

let staticFacts: Promise<StaticFacts> | null = null;

/** What does not change while this process lives. Read once, kept. */
function localStaticFacts(): Promise<StaticFacts> {
  if (staticFacts) return staticFacts;
  staticFacts = (async () => {
    const [short, fqdn, cpuinfo, lsblk, arch] = await Promise.all([
      run('hostname', []),
      run('hostname', ['-f']),
      readText('/proc/cpuinfo'),
      run('lsblk', ['-d', '-o', 'NAME,TYPE,SIZE,ROTA']),
      run('uname', ['-m']),
    ]);
    if (!short) throw new Error('hostname unavailable');
    return {
      hostname: fqdn && fqdn.includes('.') ? fqdn : short,
      cpuCores: cpus().length,
      cpuModel: cpuinfo ? parseCpuModel(cpuinfo) : null,
      spinningDisks: lsblk ? countSpinningDisks(lsblk) : 0,
      ssdCount: lsblk ? countSsds(lsblk) : 0,
      arch: arch ?? undefined,
    };
  })();
  // A failed first read is not kept: the next sample tries again.
  staticFacts.catch(() => { staticFacts = null; });
  return staticFacts;
}

/** Tests only: forget the static facts so they are read again. */
export function forgetLocalStaticFacts(): void { staticFacts = null; }

export async function getLocalStats(): Promise<MeshNode> {
  try {
    const [facts, meminfo, loadavg, uptimeRaw, ps, rapl, nv, gpuEnergyMj] = await Promise.all([
      localStaticFacts(),
      readText('/proc/meminfo'),
      readText('/proc/loadavg'),
      readText('/proc/uptime'),
      // Agent harness processes. Counted per harness, not just claude:
      // uncloseai-cli runs as `python3 .../unclose`, so a basename match on
      // column 11 reported zero while five agents were running.
      run('/bin/sh', ['-c', `ps aux 2>/dev/null | awk '${harnessPsAwk()}' | sed 's/^/HPROC /'`]),
      readRapl(),
      readNvidia(),
      readNvmlEnergyMj(),
    ]);
    const { hostname, cpuCores, cpuModel, spinningDisks, ssdCount, arch } = facts;

    // Memory from /proc/meminfo (more precise than free), through the same
    // parsers the remote probe uses — the two read identical formats.
    const mem = parseMeminfo(meminfo ?? '');
    const memTotal = mem.totalGB;
    const memAvailable = mem.availableGB;
    const swapTotal = mem.swapTotalGB;
    const swapFree = mem.swapFreeGB;
    const loadAvg = parseLoadavg(loadavg ?? '');
    const uptimeSeconds = parseFloat((uptimeRaw ?? '0').split(/\s/)[0]);
    const uptime = formatUptime(uptimeSeconds);

    let claudeProcesses = 0;
    let harnessCounts: Record<string, number> = {};
    if (ps) {
      const procs = parseHarnessProcesses(
        ps.split('\n').filter((l) => l.startsWith('HPROC ')).map((l) => l.slice(6)).join('\n'),
      );
      harnessCounts = countByHarness(procs);
      claudeProcesses = harnessCounts.claude ?? 0;
    }

    const isServer = cpuModel ? /xeon|epyc/i.test(cpuModel) : false;
    const isLaptop = cpuModel ? /[0-9]U\b|[0-9]G[1-7]\b/i.test(cpuModel) : false;
    const cpuTdpWatts = cpuModel ? lookupCpuTdp(cpuModel) : null;

    // Power monitoring: RAPL first, then TDP-based system calc.
    let powerWatts: number | undefined;
    let powerSource: MeshNode['powerSource'];
    if (rapl.watts !== null) {
      // RAPL = CPU package only — add RAM, disks, baseline, PSU loss
      powerWatts = rapl.watts + calcNonCpuWatts({ memTotalGB: memTotal, spinningDisks, ssdCount, isServer, isLaptop });
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
      cpuEnergy: rapl.counters,
      gpuEnergyMj: gpuEnergyMj ?? undefined,
      gpuPowerWatts: nv.watts ?? undefined,
      gpuModel: nv.model,
      gpuMemTotalMB: nv.memTotalMB ? Math.round(nv.memTotalMB) : undefined,
      gpuMemUsedMB: nv.memUsedMB ? Math.round(nv.memUsedMB) : undefined,
      gpuUtil: nv.util,
      arch,
      powerSource,
      // The local node is read in-process, not through the userland
      // script; say what it would have said so the fleet reads alike.
      os: osType(), osRelease: osRelease(), userland: 'linux-gnu', kind: 'compute',
    };
  } catch (e: any) {
    return { hostname: 'localhost', reachable: false, error: String(e) };
  }
}
