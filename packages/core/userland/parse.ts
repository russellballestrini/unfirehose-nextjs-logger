/* eslint-disable @typescript-eslint/no-explicit-any */
import { parseHarnessProcesses, countByHarness } from '../harness-procs';
import {
  type MeshNode, parseCpuModel, lookupCpuTdp, lookupCpuYear,
  calcSystemWatts, calcNonCpuWatts, memCapGB, formatUptime, round,
} from '../mesh-probe';
import { num } from '../num';

/**
 * The wire, read but not yet interpreted: every `key=value`, and the
 * prefixed line lists. Values are the remote command's own words — a
 * FreeBSD `{ 0.48 0.41 0.37 }`, a Solaris `16384 Megabytes`, an AIX
 * `512MB 1%` — and every interpreter below has to read all of them,
 * because the shell side was forbidden from doing arithmetic.
 */
export interface WireProbe {
  /** `uf=1` was seen: a POSIX shell ran our script at all. */
  shellRan: boolean;
  /** `END` was seen: the script ran to the end; otherwise it was cut. */
  complete: boolean;
  kv: Record<string, string>;
  disks: { name: string; rota: 0 | 1 | null }[];
  hprocs: string[];
  rapl: number[] | null;
  gpu: string[];
}

export function readWire(stdout: string): WireProbe {
  const w: WireProbe = { shellRan: false, complete: false, kv: {}, disks: [], hprocs: [], rapl: null, gpu: [] };
  for (const raw of stdout.split('\n')) {
    const line = raw.replace(/\r$/, '');
    if (line === 'uf=1') { w.shellRan = true; continue; }
    if (line === 'END') { w.complete = true; continue; }
    if (line.startsWith('DISK ')) {
      const [, name, r] = line.split(/\s+/);
      if (name) w.disks.push({ name, rota: r === '1' ? 1 : r === '0' ? 0 : null });
      continue;
    }
    if (line.startsWith('HPROC ')) { w.hprocs.push(line.slice(6)); continue; }
    if (line.startsWith('RAPL ')) { w.rapl = line.slice(5).trim().split(/\s+/).map(Number); continue; }
    if (line.startsWith('GPU ')) { w.gpu.push(line.slice(4)); continue; }
    const eq = line.indexOf('=');
    if (eq > 0 && /^[a-z_][a-z0-9_]*$/.test(line.slice(0, eq))) {
      // Last write wins: a plugin may refine a value `common` already set.
      w.kv[line.slice(0, eq)] = line.slice(eq + 1).trim();
    }
  }
  return w;
}

// ── interpreters for raw values ─────────────────────────────────────────

const UNIT_GB: [RegExp, number][] = [
  [/^(bytes?|b)$/i, 1 / 1024 ** 3],
  [/^(kb|k|kib|kbytes|kilobytes|1k-blocks)$/i, 1 / 1024 ** 2],
  [/^(mb|m|mib|mbytes|megabytes)$/i, 1 / 1024],
  [/^(gb|g|gib|gbytes|gigabytes)$/i, 1],
  [/^(tb|t|tib)$/i, 1024],
];

/**
 * "17179869184 B", "32791234 kB", "16384 Megabytes", "1024.00 M", "9012M",
 * "512MB", "3 4 5 pages" (summed, times the page size) — to gigabytes.
 * Unknown or missing unit is bytes when the number is huge, else kB: the
 * two sources that omit units (Linux SwapTotal has kB; sysctl has bytes)
 * are not ambiguous at any real machine size.
 */
export function sizeToGB(raw: string | undefined, pagesize = 4096): number {
  if (!raw) return 0;
  const s = raw.trim();
  const nums = s.match(/-?\d+(?:\.\d+)?/g)?.map(Number).filter(n => Number.isFinite(n)) ?? [];
  if (nums.length === 0) return 0;
  const unit = s.match(/([A-Za-z-]+)\s*$/)?.[1] ?? '';
  if (/^pages?$/i.test(unit)) return nums.reduce((a, b) => a + b, 0) * pagesize / 1024 ** 3;
  const n = nums[0]!;
  for (const [re, f] of UNIT_GB) if (re.test(unit)) return n * f;
  return n > 1e7 ? n / 1024 ** 3 : n / 1024 ** 2;
}

/** "0.5 0.4 0.3 1/900 123", "{ 0.5 0.4 0.3 }", "load average: 0.5, 0.4, 0.3", "load averages: 0.5 0.4 0.3". */
export function parseLoad(raw: string | undefined, uptimeRaw?: string, cpuPct?: string, nproc = 1): [number, number, number] {
  const from = (s: string | undefined): [number, number, number] | null => {
    if (!s) return null;
    const tail = s.match(/load averages?:\s*(.*)$/i)?.[1] ?? s;
    const n = tail.match(/\d+(?:[.,]\d+)?/g)?.map(x => parseFloat(x.replace(',', '.'))) ?? [];
    return n.length >= 3 ? [n[0]!, n[1]!, n[2]!] : null;
  };
  // Windows and network gear say "CPU 5%", not a run queue: a percentage
  // of the cores busy is the nearest thing to a load average.
  const pct = parseFloat(cpuPct ?? '');
  const fromPct: [number, number, number] | null = Number.isFinite(pct) ? [1, 1, 1].map(() => Math.round(pct / 100 * Math.max(1, nproc) * 100) / 100) as [number, number, number] : null;
  return from(raw) ?? from(uptimeRaw?.match(/load averages?:.*$/i)?.[0]) ?? fromPct ?? [0, 0, 0];
}

/** `[[dd-]hh:]mm:ss` from `ps -o etime`. */
export function parseEtime(raw: string | undefined): number | null {
  const m = raw?.trim().match(/^(?:(\d+)-)?(?:(\d+):)?(\d+):(\d+)$/);
  if (!m) return null;
  return (+(m[1] ?? 0)) * 86400 + (+(m[2] ?? 0)) * 3600 + (+m[3]!) * 60 + (+m[4]!);
}

/** "up 12 days, 3:04", "up 3:04", "up 12 days, 4 min", "up 5 mins", "up 1 day, 2 hrs, 3 mins". */
export function parseUptimeText(raw: string | undefined): number | null {
  const m = raw?.match(/\bup\s+(.*?)(?:,\s*\d+\s+users?|,\s*load|$)/i);
  if (!m) return null;
  const s = m[1]!;
  let secs = 0; let seen = false;
  const d = s.match(/(\d+)\s*days?/i); if (d) { secs += +d[1]! * 86400; seen = true; }
  const h = s.match(/(\d+)\s*(?:hrs?|hours?)/i); if (h) { secs += +h[1]! * 3600; seen = true; }
  const mi = s.match(/(\d+)\s*(?:mins?|minutes?)/i); if (mi) { secs += +mi[1]! * 60; seen = true; }
  const hm = s.match(/(\d+):(\d+)/); if (hm) { secs += +hm[1]! * 3600 + +hm[2]! * 60; seen = true; }
  return seen ? secs : null;
}

/**
 * Seconds since boot, from whichever the userland could say: an uptime,
 * a boot time in any of four notations, init's elapsed time, or the
 * `uptime` sentence. `now` is the remote clock when it gave one, so a box
 * with a wrong clock still reports a right uptime.
 */
export function parseUptimeSeconds(kv: Record<string, string>): number {
  const direct = parseFloat(kv.uptime_s ?? '');
  if (Number.isFinite(direct) && direct > 0) return direct;
  const now = Number.isFinite(parseFloat(kv.now ?? '')) && parseFloat(kv.now!) > 1e9 ? parseFloat(kv.now!) : Date.now() / 1000;
  const boot = kv.boottime?.trim();
  if (boot) {
    // FreeBSD/macOS: "{ sec = 1694000000, usec = 123 } Wed Sep ..."
    const sec = boot.match(/sec\s*=\s*(\d+)/)?.[1];
    if (sec) return Math.max(0, now - +sec);
    // OpenBSD/NetBSD/kstat: a bare epoch
    if (/^\d{9,11}(\.\d+)?$/.test(boot)) return Math.max(0, now - parseFloat(boot));
    // WMI: 20260912100000.500000-240 — local time, then the UTC offset in minutes.
    const wmi = boot.match(/^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})(?:\.\d+)?([+-]\d+)?/);
    if (wmi) {
      const local = Date.UTC(+wmi[1]!, +wmi[2]! - 1, +wmi[3]!, +wmi[4]!, +wmi[5]!, +wmi[6]!) / 1000;
      return Math.max(0, now - (local - (wmi[7] ? +wmi[7] * 60 : 0)));
    }
    // QNX and friends: a date sentence
    const t = Date.parse(boot);
    if (Number.isFinite(t) && t > 0) return Math.max(0, now - t / 1000);
  }
  const et = parseEtime(kv.etime1);
  if (et !== null && et > 0) return et;
  return parseUptimeText(kv.uptime_raw) ?? 0;
}

/** Swap total and used, in GB, from whichever form the userland speaks. */
export function parseSwap(kv: Record<string, string>): { totalGB: number; usedGB: number } {
  const g = (k: string) => sizeToGB(kv[k]);
  if (kv.swap_total) {
    const total = g('swap_total');
    const used = kv.swap_used ? g('swap_used') : kv.swap_free ? total - g('swap_free') : 0;
    return { totalGB: total, usedGB: Math.max(0, used) };
  }
  const raw = kv.swap_raw?.trim();
  if (!raw) return { totalGB: 0, usedGB: 0 };
  // macOS vm.swapusage: total = 2048.00M  used = 1077.31M  free = 970.69M
  let m = raw.match(/total\s*=\s*([\d.]+\s*[KMGT]?)\s+used\s*=\s*([\d.]+\s*[KMGT]?)/i);
  if (m) return { totalGB: sizeToGB(m[1]), usedGB: sizeToGB(m[2]) };
  // swapctl -sk: total: 1048576 1K-blocks allocated, 0 used, 1048576 available
  m = raw.match(/total:\s*(\d+)\s*1K-blocks\s+allocated,\s*(\d+)\s+used/i);
  if (m) return { totalGB: +m[1]! / 1024 ** 2, usedGB: +m[2]! / 1024 ** 2 };
  // Solaris/IRIX swap -s: ... = 1690k used, 7890k available
  m = raw.match(/([\d.]+)\s*([kmg]?)\s*used,\s*([\d.]+)\s*([kmg]?)\s*available/i);
  if (m) {
    const used = sizeToGB(`${m[1]} ${m[2] || 'k'}`), avail = sizeToGB(`${m[3]} ${m[4] || 'k'}`);
    return { totalGB: used + avail, usedGB: used };
  }
  // HP-UX swapinfo -tm: total   2048   1024   1024   50%   (Mb)
  m = raw.match(/^total\s+(\d+)\s+(\d+)\s+(\d+)/i);
  if (m) return { totalGB: +m[1]! / 1024, usedGB: +m[2]! / 1024 };
  // AIX lsps -s:   512MB   1%
  m = raw.match(/(\d+)\s*(MB|GB)\s+(\d+)%/i);
  if (m) { const t = sizeToGB(`${m[1]} ${m[2]}`); return { totalGB: t, usedGB: t * +m[3]! / 100 }; }
  // Tru64 swapon -s: Allocated space: 262144 pages (2048MB) ... Available space: 1000 pages (7MB)
  const alloc = raw.match(/Allocated space:.*?\((\d+)\s*(MB|GB|KB)\)/i);
  const avail = raw.match(/Available space:.*?\((\d+)\s*(MB|GB|KB)\)/i);
  if (alloc) {
    const t = sizeToGB(`${alloc[1]} ${alloc[2]}`);
    const a = avail ? sizeToGB(`${avail[1]} ${avail[2]}`) : 0;
    return { totalGB: t, usedGB: Math.max(0, t - a) };
  }
  return { totalGB: 0, usedGB: 0 };
}

/** Memory total and available, in GB. */
export function parseMemory(kv: Record<string, string>): { totalGB: number; availableGB: number } {
  const ps = parseInt(kv.pagesize ?? '') || 4096;
  let total = sizeToGB(kv.mem_total, ps);
  let avail = sizeToGB(kv.mem_avail, ps);
  // Pre-3.14 Linux has no MemAvailable: free + buffers + cached is the old estimate.
  if (!avail && (kv.mem_free || kv.mem_cached)) {
    avail = sizeToGB(kv.mem_free, ps) + sizeToGB(kv.mem_buffers, ps) + sizeToGB(kv.mem_cached, ps);
  }
  const raw = kv.mem_raw?.trim();
  if (raw && !total) {
    // Haiku sysinfo -mem: 4177920 bytes free (used/max 4211789824 / 8389709824)
    let m = raw.match(/used\/max\s+(\d+)\s*\/\s*(\d+)/i);
    if (m) { total = +m[2]! / 1024 ** 3; avail = (+m[2]! - +m[1]!) / 1024 ** 3; }
    // QNX pidin info: 2.5GB/8GB   (free/total)
    m = raw.match(/^([\d.]+\s*[KMGT]B?)\s*\/\s*([\d.]+\s*[KMGT]B?)$/i);
    if (m) { total = sizeToGB(m[2]); avail = sizeToGB(m[1]); }
  }
  return { totalGB: total, availableGB: Math.min(avail, total || avail) };
}

// ── the node ────────────────────────────────────────────────────────────

/**
 * One node, from the wire. `host` wins over the hostname the machine
 * reports when it carries a domain, because that is what our SSH config
 * calls it and what everything else keys on.
 *
 * Throws when no shell ran the script at all — that is a different fact
 * from "this box has no metrics", and probeRemote turns it into a reason.
 */
export function parseWireProbe(host: string, stdout: string): MeshNode {
  const w = readWire(stdout);
  if (!w.shellRan) throw new Error('no POSIX shell answered (sh not found on remote?)');
  const kv = w.kv;

  const remoteHostname = kv.hostname ?? '';
  const hostname = host.includes('.') ? host : (remoteHostname.includes('.') ? remoteHostname : host);
  const cpuCores = parseInt(kv.nproc?.match(/\d+/)?.[0] ?? '') || 0;

  // procfs plugins send the cpuinfo line itself; sysctl plugins send the name.
  const cpuRaw = kv.cpu?.trim() ?? '';
  let cpuModel: string | undefined = cpuRaw.includes(':') ? parseCpuModel(cpuRaw) ?? cpuRaw : cpuRaw;
  if (!cpuModel || /^(unknown|unknown\s+cpu)$/i.test(cpuModel)) cpuModel = kv.soc || kv.model || undefined;
  // `uname -p` on a BSD says the same thing as -m; that is not a model name.
  if (cpuModel && kv.userland === 'generic' && cpuModel === kv.arch) cpuModel = undefined;

  const arch = kv.isa || kv.arch || undefined;
  const mem = parseMemory(kv);
  const swap = parseSwap(kv);
  const loadAvg = parseLoad(kv.load, kv.uptime_raw, kv.cpu_pct, cpuCores);
  const kind: MeshNode['kind'] = kv.kind === 'network' || kv.kind === 'hypervisor' ? kv.kind : 'compute';
  const uptimeSeconds = Math.round(parseUptimeSeconds(kv));
  const uptime = formatUptime(uptimeSeconds);

  // Unknown rotation counts as spinning: the estimate errs toward more
  // heat and cost, not less, and the boxes that cannot say tend to be old.
  const spinningDisks = w.disks.filter(d => d.rota !== 0).length;
  const ssdCount = w.disks.filter(d => d.rota === 0).length;

  const remoteProcs = parseHarnessProcesses(w.hprocs.join('\n'));
  const harnessCounts = countByHarness(remoteProcs);
  const claudeProcesses = harnessCounts.claude ?? 0;

  // A switch or router's SoC is not in the CPU catalog and should not fall
  // to a desktop's 65W: a managed switch draws 10–40W idle, a router less.
  const cpuTdpWatts = cpuModel ? lookupCpuTdp(cpuModel) : null;
  const networkWatts = kind === 'network' ? 20 : null;
  const isServer = cpuModel ? /xeon|epyc|power\d|opteron|sparc/i.test(cpuModel) : false;
  const isLaptop = cpuModel ? /[0-9]U\b|[0-9]G[1-7]\b|[0-9]M\b/i.test(cpuModel) : false;
  let powerWatts: number | undefined;
  let gpuPowerWatts: number | undefined;
  let powerSource: MeshNode['powerSource'] | undefined;

  if (w.rapl && w.rapl.length >= 3 && !isNaN(w.rapl[0]!) && !isNaN(w.rapl[2]!)) {
    const [r1, r1b, r2, r2b, dtRaw] = w.rapl;
    const dt = dtRaw && dtRaw > 0 ? dtRaw : 0.1;
    let delta0 = r2! - r1!;
    if (delta0 < 0) delta0 += 2 ** 32;
    let delta1 = 0;
    if (!isNaN(r1b!) && !isNaN(r2b!)) { delta1 = r2b! - r1b!; if (delta1 < 0) delta1 += 2 ** 32; }
    const cpuWatts = round((delta0 + delta1) / (dt * 1e6));
    if (cpuWatts > 0 && cpuWatts < 10000) {
      powerWatts = round(cpuWatts + calcNonCpuWatts({ memTotalGB: mem.totalGB, spinningDisks, ssdCount, isServer, isLaptop }));
      powerSource = 'rapl';
    }
  }

  let gpuModel: string | undefined;
  let gpuMemTotalMB: number | undefined;
  let gpuMemUsedMB: number | undefined;
  let gpuUtil: number | undefined;
  if (w.gpu.length) {
    let totalPower = 0;
    for (const line of w.gpu) {
      const parts = line.split(',').map(s => s.trim());
      const watts = parseFloat(parts[0]!);
      if (!isNaN(watts)) totalPower += watts;
      if (!gpuModel && parts[1]) gpuModel = parts[1];
      if (parts[2]) gpuMemTotalMB = (gpuMemTotalMB ?? 0) + num(parts[2]);
      if (parts[3]) gpuMemUsedMB = (gpuMemUsedMB ?? 0) + num(parts[3]);
      if (parts[4]) gpuUtil = Math.max(gpuUtil ?? 0, num(parts[4]));
    }
    if (totalPower > 0) gpuPowerWatts = round(totalPower);
  }

  if (!powerWatts && networkWatts !== null) {
    powerWatts = networkWatts;
    powerSource = 'tdp';
  } else if (!powerWatts && cpuTdpWatts !== null) {
    powerWatts = calcSystemWatts({
      tdpWatts: cpuTdpWatts, cores: cpuCores, load1m: loadAvg[0],
      memTotalGB: mem.totalGB, spinningDisks, ssdCount, isServer, isLaptop,
    });
    powerSource = 'tdp';
  }

  return {
    hostname, reachable: true,
    cpuModel, cpuTdpWatts: cpuTdpWatts ?? undefined,
    spinningDisks, ssdCount, cpuCores,
    memTotalGB: round(mem.totalGB), memCapGB: memCapGB(mem.totalGB),
    memUsedGB: round(mem.totalGB - mem.availableGB), memAvailableGB: round(mem.availableGB),
    loadAvg, uptime, uptimeSeconds,
    cpuYear: cpuModel ? lookupCpuYear(cpuModel) ?? undefined : undefined,
    claudeProcesses, harnessCounts,
    swapTotalGB: round(swap.totalGB), swapUsedGB: round(swap.usedGB),
    powerWatts, gpuPowerWatts: gpuPowerWatts ?? undefined,
    gpuModel, gpuMemTotalMB: gpuMemTotalMB ? Math.round(gpuMemTotalMB) : undefined,
    gpuMemUsedMB: gpuMemUsedMB ? Math.round(gpuMemUsedMB) : undefined,
    gpuUtil, arch, powerSource,
    os: kv.os || undefined, osRelease: kv.osrel || undefined, userland: kv.userland || undefined,
    kind, vms: kv.vms ? parseInt(kv.vms) || 0 : undefined, model: kv.model || undefined,
    truncated: !w.complete || undefined,
  };
}
