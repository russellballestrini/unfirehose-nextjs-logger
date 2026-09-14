/* eslint-disable @typescript-eslint/no-explicit-any */
import { parseHarnessProcesses, countByHarness } from '@unturf/unfirehose/harness-procs';
import { parseCpuModel } from '@unturf/unfirehose/mesh-probe';
import { readWire, parseMemory, parseLoad, parseUptimeSeconds, parseSwap } from '@unturf/unfirehose/userland';
import {
  parseTemperatures, parseHwmon, mergeSensors, parseThrottle,
  parseNvidiaClocks, parseCpuTopology,
} from '@/lib/sensors';
import { num, int } from '@/lib/num';

/**
 * Parsers for our node probe's output.
 *
 * The probe runs a dozen commands over one SSH connection and returns their
 * output as a single stream split by markers. Everything a node detail page
 * shows comes out of these functions, so they carry the format quirks:
 * nvidia-smi printing an NVML driver-mismatch error into the same stream, a
 * ps command that itself contains spaces, a container name that does too.
 *
 * They live here rather than beside the handler because Next validates the
 * export surface of a `route.ts` — a named export there is a build error,
 * which also means anything defined there is unreachable from a test.
 */

export const SECTION_MARKERS = [
  'HOSTNAME', 'CPUINFO', 'ARCH', 'KERNEL', 'OS', 'NPROC', 'MEMINFO',
  'LOADAVG', 'UPTIME', 'DISK', 'PS', 'PS_TREE', 'CLAUDE_PS', 'UF', 'NVIDIA', 'NVIDIA_PS',
  'AMD_GPU', 'TEMPS', 'HWMON', 'THROTTLE', 'CPUTOPO', 'NVIDIA_CLOCKS', 'NET', 'NETSTAT', 'IOSTAT', 'DOCKER', 'DOCKER_STATE', 'CGROUP_STATS', 'PS_PPID', 'HARNESS_SESSIONS', 'TMUX', 'SCREEN', 'END',
];

export function parseSection(output: string, marker: string): string {
  const tag = `===SECTION:${marker}===`;
  const start = output.indexOf(tag);
  if (start === -1) return '';
  const afterMarker = output.indexOf('\n', start);
  if (afterMarker === -1) return '';
  // Find the next known section marker
  let end = output.length;
  for (const m of SECTION_MARKERS) {
    if (m === marker) continue;
    const idx = output.indexOf(`\n===SECTION:${m}===`, afterMarker);
    if (idx !== -1 && idx < end) end = idx;
  }
  return output.slice(afterMarker + 1, end).trim();
}

function round(n: number, d = 1): number {
  const f = Math.pow(10, d);
  return Math.round(n * f) / f;
}

export function parseCpuInfo(raw: string) {
  // Whichever field this architecture names the CPU in — see parseCpuModel.
  const model = parseCpuModel(raw) ?? 'Unknown';
  const mhz = raw.match(/cpu MHz\s*:\s*([\d.]+)/i)?.[1];
  const cacheSize = raw.match(/cache size\s*:\s*(.+)/i)?.[1]?.trim();
  return { model, mhz: mhz ? parseFloat(mhz) : undefined, cacheSize };
}

export function parseMeminfo(raw: string) {
  const get = (key: string) => parseInt(raw.match(new RegExp(`${key}:\\s+(\\d+)`))?.[1] ?? '0') / 1024 / 1024;
  return {
    totalGB: round(get('MemTotal')),
    availableGB: round(get('MemAvailable')),
    usedGB: round(get('MemTotal') - get('MemAvailable')),
    buffersGB: round(get('Buffers')),
    cachedGB: round(get('Cached')),
    swapTotalGB: round(get('SwapTotal')),
    swapUsedGB: round(get('SwapTotal') - get('SwapFree')),
    swapCachedGB: round(get('SwapCached')),
    shmemGB: round(get('Shmem')),
    sreclaimableGB: round(get('SReclaimable')),
    dirtyMB: round(parseInt(raw.match(/Dirty:\s+(\d+)/)?.[1] ?? '0') / 1024, 0),
  };
}

export function parseProcesses(raw: string) {
  if (!raw || raw === 'n/a') return [];
  const lines = raw.split('\n').filter(l => l.trim());
  if (lines.length < 2) return [];
  // Skip header line
  return lines.slice(1).map(line => {
    const parts = line.trim().split(/\s+/);
    if (parts.length < 11) return null;
    return {
      user: parts[0],
      pid: parseInt(parts[1]),
      cpu: parseFloat(parts[2]),
      mem: parseFloat(parts[3]),
      vsz: parseInt(parts[4]),
      rss: parseInt(parts[5]),
      tty: parts[6],
      stat: parts[7],
      start: parts[8],
      time: parts[9],
      command: parts.slice(10).join(' '),
    };
  }).filter(Boolean);
}

export interface ProcessTreeRow {
  pid: number;
  pgid: number;
  sid: number;
  tty: string;
  time: string;
  cmd: string;
  /** Nesting level: `ps -H` indents CMD by two spaces per generation. */
  depth: number;
}

/**
 * `ps -ejH` — every process with its group and session ids, ordered as a
 * tree with CMD indented two spaces per generation. The indent is the only
 * carrier of parentage (there is no PPID column), so it is measured before
 * the row is trimmed. CMD is `comm`, which can itself contain a space
 * ("tmux: server"), so the split stops after TIME.
 */
export function parseProcessTree(raw: string): ProcessTreeRow[] {
  if (!raw || raw === 'n/a') return [];
  const rows: ProcessTreeRow[] = [];
  for (const line of raw.split('\n')) {
    // One space separates TIME from the CMD field; everything after it is
    // CMD, including its hierarchy indent.
    const m = line.match(/^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\S+)\s+(\S+) (.*)$/);
    if (!m) continue;
    const field = m[6]!;
    const indent = field.length - field.trimStart().length;
    rows.push({
      pid: parseInt(m[1]!),
      pgid: parseInt(m[2]!),
      sid: parseInt(m[3]!),
      tty: m[4]!,
      time: m[5]!,
      cmd: field.trim(),
      depth: Math.floor(indent / 2),
    });
  }
  return rows;
}

export function parseNvidiaGpu(raw: string) {
  if (!raw || raw === 'none') return [];
  return raw.split('\n').filter(l => l.trim()).map(line => {
    const p = line.split(',').map(s => s.trim());
    if (p.length < 12) return null;
    return {
      index: parseInt(p[0]),
      name: p[1],
      tempC: num(p[2]),
      gpuUtil: num(p[3]),
      memUtil: num(p[4]),
      memTotalMB: num(p[5]),
      memUsedMB: num(p[6]),
      memFreeMB: num(p[7]),
      powerDrawW: num(p[8]),
      powerLimitW: num(p[9]),
      fanPct: num(p[10]),
      pstate: p[11],
    };
  }).filter(Boolean);
}

export function parseNvidiaProcesses(raw: string) {
  if (!raw || raw === 'none') return [];
  return raw.split('\n').filter(l => l.trim()).map(line => {
    const p = line.split(',').map(s => s.trim());
    if (p.length < 3) return null;
    return { pid: parseInt(p[0]), name: p[1], memMB: num(p[2]) };
  }).filter(Boolean);
}

export function parseAmdGpu(raw: string) {
  if (!raw || raw === 'none') return [];
  const lines = raw.split('\n').filter(l => l.trim());
  if (lines.length < 2) return [];
  const headers = lines[0].split(',').map(s => s.trim().toLowerCase());
  return lines.slice(1).map(line => {
    const vals = line.split(',').map(s => s.trim());
    const obj: Record<string, string> = {};
    headers.forEach((h, i) => { obj[h] = vals[i] ?? ''; });
    return obj;
  });
}

/** A bare kilobyte count (from `df -k`, where GNU's -h is missing) as -h would print it. */
function humanKB(v: string): string {
  if (!/^\d+$/.test(v)) return v;
  let n = parseInt(v, 10);
  for (const u of ['K', 'M', 'G', 'T', 'P']) {
    if (n < 1024) return `${n}${u}`;
    n = Math.round(n / 1024 * 10) / 10;
  }
  return `${n}E`;
}

export function parseDisk(raw: string) {
  if (!raw || raw === 'n/a') return [];
  return raw.split('\n').filter(l => l.trim()).map(line => {
    const parts = line.trim().split(/\s+/);
    if (parts.length < 6) return null;
    return {
      device: parts[0],
      size: humanKB(parts[1]),
      used: humanKB(parts[2]),
      avail: humanKB(parts[3]),
      usePct: int(parts[4]),
      mount: parts[5],
    };
  }).filter(Boolean);
}

export function parseNetInterfaces(raw: string) {
  if (!raw || raw === 'n/a') return [];
  return raw.split('\n').filter(l => l.trim()).map(line => {
    const parts = line.trim().split(/\s+/);
    return { name: parts[0], state: parts[1], addrs: parts.slice(2).join(' ') };
  });
}

export function parseNetDev(raw: string) {
  if (!raw || raw === 'n/a') return [];
  return raw.split('\n').filter(l => l.trim()).map(line => {
    const parts = line.trim().split(/[:\s]+/);
    if (parts.length < 17) return null;
    return {
      iface: parts[0],
      rxBytes: int(parts[1]),
      rxPackets: int(parts[2]),
      txBytes: int(parts[9]),
      txPackets: int(parts[10]),
    };
  }).filter(Boolean).filter(n => n!.rxBytes > 0 || n!.txBytes > 0);
}

export function parseDocker(raw: string) {
  if (!raw || raw === 'none') return [];
  return raw.split('\n').filter(l => l.trim()).map(line => {
    const parts = line.split('\t');
    // Ports is EMPTY for a --network host container, so its line ends
    // in a tab -- and parseSection trims the section, which eats the
    // trailing tab of the LAST line only. Requiring five fields
    // therefore dropped exactly one container, always the last one
    // listed, on any host running host-network containers. Observed
    // 2026-09-05: a fleet of eight rendered as seven.
    //
    // Ports is the only optional field, so four is the real minimum
    // and the fifth defaults to absent rather than deciding the row
    // is unreadable.
    if (parts.length < 4) return null;
    return {
      id: parts[0], name: parts[1], image: parts[2], status: parts[3],
      ports: parts[4] ?? '',
    };
  }).filter((c): c is NonNullable<typeof c> => c !== null);
}

/**
 * Docker's own zero time. A container that was created but never started
 * carries this as StartedAt; one still running carries it as FinishedAt.
 */
const DOCKER_NEVER = '0001-01-01T00:00:00Z';

export interface ContainerState {
  state: string;
  startedAt: string | null;
  finishedAt: string | null;
  exitCode: number | null;
  /** The container's init, as our host kernel numbers it. 0 when not running. */
  pid: number | null;
  /** HostConfig limits: cpus as a fraction (NanoCpus / 1e9), memory in bytes, pids. null is unlimited. */
  cpuLimit: number | null;
  memLimit: number | null;
  pidsLimit: number | null;
  cpuset: string | null;
  restartCount: number | null;
  oomKilled: boolean | null;
  /** healthy / unhealthy / starting, or null without a HEALTHCHECK. */
  health: string | null;
}

/**
 * `docker inspect` state lines, keyed by full container id. `docker ps`
 * prints the short id, so lookups go by prefix -- see `attachDockerState`.
 */
export function parseDockerState(raw: string): Map<string, ContainerState> {
  const out = new Map<string, ContainerState>();
  if (!raw || raw === 'none') return out;
  for (const line of raw.split('\n')) {
    const parts = line.split('\t');
    if (parts.length < 4 || !parts[0]) continue;
    const instant = (s: string | undefined) => (s && s !== DOCKER_NEVER && !Number.isNaN(Date.parse(s))) ? s : null;
    // A nil pointer prints "<no value>", an unset int prints 0. Both mean
    // "no limit" for the HostConfig fields, and num() turns them into null.
    const num = (v: string | undefined) => {
      if (v === undefined || v === '' || v === '<no value>') return null;
      const n = Number(v);
      return Number.isFinite(n) ? n : null;
    };
    const code = num(parts[4]);
    const nanoCpus = num(parts[6]);
    const memLimit = num(parts[7]);
    const pidsLimit = num(parts[8]);
    out.set(parts[0], {
      state: parts[1],
      startedAt: instant(parts[2]),
      finishedAt: instant(parts[3]),
      exitCode: code,
      pid: num(parts[5]) || null,
      cpuLimit: nanoCpus ? nanoCpus / 1e9 : null,
      memLimit: memLimit || null,
      pidsLimit: pidsLimit || null,
      cpuset: parts[9] || null,
      restartCount: num(parts[10]),
      oomKilled: parts[11] === undefined || parts[11] === '' ? null : parts[11] === 'true',
      health: parts[12] || null,
    });
  }
  return out;
}

/**
 * What our host kernel says one container is doing, read from its cgroup.
 * Every field is null when the kernel did not say -- a v1 hierarchy has no
 * PSI, a container without a quota has no throttling.
 */
export interface ContainerResources {
  /** CPU used across the sample, as a percentage of one core: 200 is two cores flat out. */
  cpuPct: number | null;
  /** Cores this container may use: the cgroup quota, or null when unbounded. */
  cpuQuota: number | null;
  /** Cores the cpuset lets it run on, e.g. "0-31". */
  cpuset: string | null;
  cpuThrottled: number | null;
  cpuThrottledUsec: number | null;
  /** memory.current less inactive file cache: what docker stats calls usage. */
  memUsed: number | null;
  /** memory.current as the kernel counts it, page cache included. */
  memTotal: number | null;
  memLimit: number | null;
  memPeak: number | null;
  memAnon: number | null;
  memFile: number | null;
  swapUsed: number | null;
  oomKills: number | null;
  /** Tasks (threads and processes) the pids controller counts, and its ceiling. */
  tasks: number | null;
  tasksMax: number | null;
  ioRead: number | null;
  ioWrite: number | null;
  ioReadOps: number | null;
  ioWriteOps: number | null;
  /** PSI "some" avg10 -- share of the last ten seconds a task waited on that resource. */
  psi: { cpu: number | null; memory: number | null; io: number | null };
  /** Host pids the cgroup owns, its child cgroups included. */
  pids: number[];
}

/**
 * The CGROUP_STATS section: `id|kind|fields...` lines keyed by full
 * container id, with two cpu readings (`a` then `b`) one `elapsed_ms` apart.
 * CPU percent is the usage delta over that interval, the way docker stats
 * and top compute it, so 100 is one core.
 */
export function parseCgroupStats(raw: string): Map<string, ContainerResources> {
  const out = new Map<string, ContainerResources>();
  if (!raw || raw === 'none') return out;
  const num = (v: string | undefined): number | null => {
    if (v === undefined || v === '' || v === 'max') return null;
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  };
  const psi = (v: string | undefined) => num(v?.replace(/^avg10=/, ''));
  const blank = (): ContainerResources => ({
    cpuPct: null, cpuQuota: null, cpuset: null, cpuThrottled: null, cpuThrottledUsec: null,
    memUsed: null, memTotal: null, memLimit: null, memPeak: null, memAnon: null, memFile: null,
    swapUsed: null, oomKills: null, tasks: null, tasksMax: null,
    ioRead: null, ioWrite: null, ioReadOps: null, ioWriteOps: null,
    psi: { cpu: null, memory: null, io: null }, pids: [],
  });
  const cpuA = new Map<string, number>();
  let elapsedMs = 1000;
  for (const line of raw.split('\n')) {
    const parts = line.split('|');
    if (parts[0] === 'elapsed_ms') { elapsedMs = num(parts[1]) || 1000; continue; }
    const id = parts[0];
    if (!id || parts.length < 2) continue;
    const r = out.get(id) ?? blank();
    out.set(id, r);
    switch (parts[1]) {
      case 'a': {
        const u = num(parts[2]);
        if (u !== null) cpuA.set(id, u);
        break;
      }
      case 'b': {
        const u = num(parts[2]);
        const a = cpuA.get(id);
        if (u !== null && a !== undefined && elapsedMs > 0) {
          r.cpuPct = Math.max(0, round((u - a) / (elapsedMs * 1000) * 100, 1));
        }
        r.cpuThrottled = num(parts[3]);
        r.cpuThrottledUsec = num(parts[4]);
        break;
      }
      case 'mem': {
        r.memTotal = num(parts[2]);
        r.memLimit = num(parts[3]);
        r.memPeak = num(parts[4]);
        r.memAnon = num(parts[5]);
        r.memFile = num(parts[6]);
        const inactive = num(parts[7]);
        r.memUsed = r.memTotal === null ? null : Math.max(0, r.memTotal - (inactive ?? 0));
        r.swapUsed = num(parts[8]);
        r.oomKills = num(parts[9]);
        break;
      }
      case 'pids':
        r.tasks = num(parts[2]);
        r.tasksMax = num(parts[3]);
        break;
      case 'cpumax': {
        // cpu.max is "quota period" or "max period".
        const [q, p] = (parts[2] ?? '').trim().split(/\s+/);
        const quota = num(q); const period = num(p);
        r.cpuQuota = quota !== null && period ? round(quota / period, 2) : null;
        r.cpuset = parts[3] || null;
        break;
      }
      case 'io':
        r.ioRead = num(parts[2]);
        r.ioWrite = num(parts[3]);
        r.ioReadOps = num(parts[4]);
        r.ioWriteOps = num(parts[5]);
        break;
      case 'psi':
        r.psi = { cpu: psi(parts[2]), memory: psi(parts[3]), io: psi(parts[4]) };
        break;
      case 'procs':
        r.pids = (parts[2] ?? '').trim().split(/\s+/).map(Number).filter((n) => Number.isFinite(n) && n > 0);
        break;
    }
  }
  return out;
}

export interface PsPpidRow {
  pid: number;
  ppid: number;
  user: string;
  cpu: number;
  mem: number;
  /** Resident set, in KiB as ps prints it. */
  rss: number;
  /** Seconds since exec (procps etimes), or null when only etime's clock form came back. */
  elapsed: number | null;
  cmd: string;
}

/**
 * `ps -eo pid,ppid,user,pcpu,pmem,rss,etimes,args`: every host process
 * with its parent, so any subtree can be cut out by pid. Everything after
 * the seventh column is the command, spaces and all.
 */
export function parsePsPpid(raw: string): PsPpidRow[] {
  if (!raw || raw === 'n/a') return [];
  const rows: PsPpidRow[] = [];
  for (const line of raw.split('\n')) {
    const m = line.match(/^\s*(\d+)\s+(\d+)\s+(\S+)\s+([\d.]+)\s+([\d.]+)\s+(\d+)\s+(\S+)\s+(.*)$/);
    if (!m) continue;
    const el = m[7]!;
    rows.push({
      pid: parseInt(m[1]!), ppid: parseInt(m[2]!), user: m[3]!,
      cpu: parseFloat(m[4]!), mem: parseFloat(m[5]!), rss: parseInt(m[6]!),
      elapsed: /^\d+$/.test(el) ? parseInt(el) : null,
      cmd: m[8]!.trim(),
    });
  }
  return rows;
}

export interface ContainerProcess extends PsPpidRow {
  /** Generations below the container's init. */
  depth: number;
}

/**
 * A container's process tree, as our host sees it: the cgroup's pids in
 * parent-first order, nested under the root. A pid whose parent is
 * outside the cgroup (the init itself, or a process the runtime
 * reparented) starts a new top-level branch. Pids the cgroup owns that
 * ps did not list -- one that exited between the two commands -- are
 * simply absent.
 */
export function containerProcessTree(pids: number[], all: PsPpidRow[]): ContainerProcess[] {
  if (pids.length === 0 || all.length === 0) return [];
  const own = new Set(pids);
  const byPid = new Map<number, PsPpidRow>();
  for (const p of all) if (own.has(p.pid)) byPid.set(p.pid, p);
  const children = new Map<number, PsPpidRow[]>();
  const roots: PsPpidRow[] = [];
  for (const p of byPid.values()) {
    if (byPid.has(p.ppid) && p.ppid !== p.pid) {
      const list = children.get(p.ppid) ?? [];
      list.push(p);
      children.set(p.ppid, list);
    } else {
      roots.push(p);
    }
  }
  const byPidAsc = (a: PsPpidRow, b: PsPpidRow) => a.pid - b.pid;
  const out: ContainerProcess[] = [];
  const walk = (p: PsPpidRow, depth: number) => {
    out.push({ ...p, depth });
    for (const c of (children.get(p.pid) ?? []).sort(byPidAsc)) walk(c, depth + 1);
  };
  for (const r of roots.sort(byPidAsc)) walk(r, 0);
  return out;
}

/**
 * Hang each container's kernel-side resources and host process tree on its
 * row. Stats are keyed by full id like the inspect lines, so the same
 * prefix match applies. A stopped container gets an empty tree and no
 * resources; a probe without CGROUP_STATS (older worker, non-Linux) leaves
 * both fields undefined and the tab says so.
 */
export function attachContainerResources<C extends { id: string; pid?: number | null }>(
  containers: C[], stats: Map<string, ContainerResources>, procs: PsPpidRow[],
): (C & { resources?: ContainerResources | null; processes?: ContainerProcess[] })[] {
  if (stats.size === 0 && procs.length === 0) return containers;
  const full = [...stats.keys()];
  return containers.map((c) => {
    const key = full.find((k) => k.startsWith(c.id));
    const r = key ? stats.get(key)! : null;
    return { ...c, resources: r, processes: r ? containerProcessTree(r.pids, procs) : [] };
  });
}

/** Marry each `docker ps` row to its inspect state. Rows without one keep the ps Status alone. */
export function attachDockerState<C extends { id: string }>(
  containers: C[], states: Map<string, ContainerState>,
): (C & Partial<ContainerState>)[] {
  if (states.size === 0) return containers;
  const full = [...states.keys()];
  return containers.map((c) => {
    const key = full.find((k) => k.startsWith(c.id));
    return key ? { ...c, ...states.get(key)! } : c;
  });
}

/** Where a harness process is writing, as far as our host can tell. */
export interface HarnessSession {
  sessionId: string;
  /** The JSONL on the node's disk. */
  path: string;
  /** Encoded project dir the file sits in: claude's `-home-fox-x`, a native harness's `home-fox-x`. */
  project: string;
  /** claude-code for ~/.claude/projects, else the dotdir name (uncloseai, agnt …). */
  harness: string;
  /**
   * How the file was chosen. `born` -- created within a minute after the
   * process started, the strongest tie; `written` -- newest file touched
   * since the process started; `nearest` -- nothing written since it
   * started (a resumed session at its prompt), so the newest file at all.
   */
  matched: 'named' | 'born' | 'written' | 'nearest';
}

interface HarnessSessionCandidate { path: string; mtime: number; birth: number | null; authoritative?: boolean }
interface HarnessSessionProc { start: number; cwd: string; files: HarnessSessionCandidate[] }

/**
 * The HARNESS_SESSIONS section: `pid|proc|start_epoch|cwd`, then
 * `pid|file|mtime|birth|path` for each JSONL in that cwd's project dirs.
 */
export function parseHarnessSessions(raw: string): Map<number, HarnessSessionProc> {
  const out = new Map<number, HarnessSessionProc>();
  if (!raw || raw === 'n/a') return out;
  for (const line of raw.split('\n')) {
    const parts = line.split('|');
    const pid = parseInt(parts[0] ?? '');
    if (!Number.isFinite(pid) || parts.length < 3) continue;
    if (parts[1] === 'proc') {
      out.set(pid, { start: parseInt(parts[2] ?? '') || 0, cwd: parts.slice(3).join('|'), files: [] });
    } else if ((parts[1] === 'file' || parts[1] === 'idfile') && parts.length >= 5) {
      const p = out.get(pid);
      if (!p) continue;
      const birth = parseInt(parts[3] ?? '');
      p.files.push({
        path: parts.slice(4).join('|'),
        mtime: parseInt(parts[2] ?? '') || 0,
        // stat prints 0 (or "-") for a filesystem that does not record birth.
        birth: Number.isFinite(birth) && birth > 0 ? birth : null,
        // An idfile is the file the command line resumes by id -- the tie is
        // exact, not inferred, so it wins over every heuristic below.
        authoritative: parts[1] === 'idfile',
      });
    }
  }
  return out;
}

/** What a path under ~/.claude/projects or ~/.<harness>/unfirehose says about itself. */
function sessionFromPath(path: string): Pick<HarnessSession, 'sessionId' | 'project' | 'harness'> | null {
  const m = path.match(/\/\.([^/]+)\/(?:projects|unfirehose)\/([^/]+)\/([^/]+)\.jsonl$/);
  if (!m) return null;
  return { sessionId: m[3]!, project: m[2]!, harness: m[1] === 'claude' ? 'claude-code' : m[1]! };
}

/**
 * The one file a process is writing, from the candidates the probe listed.
 * Ties go by birth first: a session file created within a minute of the
 * process starting is that process's session, however many others share
 * the cwd. Then the newest file written since it started; a subagent
 * forked into the same cwd lands on its parent's file this way, which is
 * where its lines go. Last, the newest file at all, marked as a guess.
 */
export function resolveHarnessSession(p: HarnessSessionProc, harness?: string): HarnessSession | null {
  // Only files of the process's own harness: an unclose run from a claude
  // session shares its cwd, and claude's file is the newest thing there,
  // but nothing unclose says lands in it. ps calls claude "claude"; the
  // dotdir is .claude and the harness key claude-code.
  const own = harness ? p.files.filter((f) => {
    const h = sessionFromPath(f.path)?.harness;
    return h === harness || (h === 'claude-code' && harness === 'claude');
  }) : p.files;
  if (own.length === 0) return null;
  // The command line named this session by id: exact, not inferred.
  const named = own.filter((f) => f.authoritative).sort((a, b) => b.mtime - a.mtime)[0];
  if (named) {
    const id = sessionFromPath(named.path);
    if (id) return { ...id, path: named.path, matched: 'named' };
  }
  const byMtimeDesc = [...own].sort((a, b) => b.mtime - a.mtime);
  const born = own
    .filter((f) => f.birth !== null && f.birth >= p.start - 5 && f.birth <= p.start + 60)
    .sort((a, b) => (a.birth! - p.start) - (b.birth! - p.start))[0];
  const pick = born
    ? { f: born, matched: 'born' as const }
    : byMtimeDesc[0]!.mtime >= p.start
      ? { f: byMtimeDesc[0]!, matched: 'written' as const }
      : { f: byMtimeDesc[0]!, matched: 'nearest' as const };
  const id = sessionFromPath(pick.f.path);
  return id ? { ...id, path: pick.f.path, matched: pick.matched } : null;
}

/** Hang a session on each harness process row that the probe could place. */
export function attachHarnessSessions<P extends { pid: number; harness?: string }>(
  procs: P[], sessions: Map<number, HarnessSessionProc>,
): (P & { cwd?: string; session?: HarnessSession | null })[] {
  if (sessions.size === 0) return procs;
  return procs.map((p) => {
    const s = sessions.get(p.pid);
    return s ? { ...p, cwd: s.cwd, session: resolveHarnessSession(s, p.harness) } : p;
  });
}

export function parseTmux(raw: string) {
  if (!raw || raw === 'none') return [];
  return raw.split('\n').filter(l => l.trim()).map(line => {
    const m = line.match(/^(\S+):\s+(\d+)\s+window/);
    return m ? { name: m[1], windows: parseInt(m[2]) } : null;
  }).filter(Boolean);
}

export function parseScreen(raw: string) {
  if (!raw || raw === 'none') return [];
  return raw.split('\n').filter(l => l.trim()).map(line => {
    const m = line.trim().match(/^(\d+)\.(\S+)/);
    return m ? { pid: m[1], name: m[2] } : null;
  }).filter(Boolean);
}


/**
 * One probe's output, as the object a node page renders.
 *
 * Every section above is read here exactly once, so a marker that moves
 * or a command that changed its format shows up as one field going quiet
 * rather than as a page that fails.
 */
export function parseProbeOutput(raw: string, host: string) {
  // The userland section is what every OS can say (see core/userland);
  // the Linux sections below it are richer where they exist. Each basic
  // reads Linux first and falls back to the userland's own words.
  const uf = readWire(parseSection(raw, 'UF'));
  const hostname = parseSection(raw, 'HOSTNAME') || uf.kv.hostname || host;
  let cpuInfo = parseCpuInfo(parseSection(raw, 'CPUINFO'));
  if (cpuInfo.model === 'Unknown' && uf.kv.cpu) {
    const m = uf.kv.cpu.includes(':') ? parseCpuModel(uf.kv.cpu) : uf.kv.cpu;
    cpuInfo = { ...cpuInfo, model: m || uf.kv.soc || uf.kv.model || 'Unknown' };
  }
  const arch = parseSection(raw, 'ARCH') || uf.kv.isa || uf.kv.arch || 'unknown';
  const kernel = parseSection(raw, 'KERNEL') || uf.kv.osrel || 'unknown';
  const osRaw = parseSection(raw, 'OS');
  const osName = osRaw.match(/PRETTY_NAME="?([^"\n]+)"?/)?.[1]
    ?? (uf.kv.os && uf.kv.os !== 'Linux' ? `${uf.kv.os} ${uf.kv.osrel ?? ''}`.trim() : 'Linux');
  const cpuCores = int(parseSection(raw, 'NPROC')) || parseInt(uf.kv.nproc?.match(/\d+/)?.[0] ?? '') || 0;
  let memory = parseMeminfo(parseSection(raw, 'MEMINFO'));
  if (!memory.totalGB && uf.shellRan) {
    const m = parseMemory(uf.kv); const sw = parseSwap(uf.kv);
    memory = {
      ...memory,
      totalGB: round(m.totalGB), availableGB: round(m.availableGB), usedGB: round(m.totalGB - m.availableGB),
      swapTotalGB: round(sw.totalGB), swapUsedGB: round(sw.usedGB),
    };
  }

  const loadRaw = parseSection(raw, 'LOADAVG').split(/\s+/);
  let loadAvg = [num(loadRaw[0]), num(loadRaw[1]), num(loadRaw[2])];
  if (!loadAvg.some(Boolean) && uf.shellRan) loadAvg = parseLoad(uf.kv.load, uf.kv.uptime_raw);
  const runnable = loadRaw[3] ?? '0/0';

  const uptimeRaw = parseSection(raw, 'UPTIME').split(/\s+/);
  const uptimeSeconds = num(uptimeRaw[0]) || (uf.shellRan ? Math.round(parseUptimeSeconds(uf.kv)) : 0);

  const disk = parseDisk(parseSection(raw, 'DISK'));
  const processes = parseProcesses(parseSection(raw, 'PS'));
  const processTree = parseProcessTree(parseSection(raw, 'PS_TREE'));
  // Named CLAUDE_PS for wire compatibility; it carries every harness now.
  const harnessProcesses = attachHarnessSessions(
    parseHarnessProcesses(parseSection(raw, 'CLAUDE_PS')),
    parseHarnessSessions(parseSection(raw, 'HARNESS_SESSIONS')),
  );
  const harnessCounts = countByHarness(harnessProcesses);
  // claudeProcesses stays claude-only so existing callers keep their meaning.
  const claudeProcesses = harnessProcesses.filter((p: { harness: string }) => p.harness === 'claude');
  const nvidiaClocks = parseNvidiaClocks(parseSection(raw, 'NVIDIA_CLOCKS'));
  const nvidiaGpus = parseNvidiaGpu(parseSection(raw, 'NVIDIA')).map((g: any) => ({
    ...g,
    ...(nvidiaClocks.get(g.index) ?? { clockMhz: null, clockMaxMhz: null, throttle: null }),
  }));
  const nvidiaProcesses = parseNvidiaProcesses(parseSection(raw, 'NVIDIA_PS'));
  const amdGpus = parseAmdGpu(parseSection(raw, 'AMD_GPU'));
  const temperatures = parseTemperatures(parseSection(raw, 'TEMPS'));
  const sensors = mergeSensors(parseHwmon(parseSection(raw, 'HWMON')), temperatures);
  const throttle = parseThrottle(parseSection(raw, 'THROTTLE'));
  const cpuTopology = parseCpuTopology(parseSection(raw, 'CPUTOPO'));
  const netInterfaces = parseNetInterfaces(parseSection(raw, 'NET'));
  const netDev = parseNetDev(parseSection(raw, 'NETSTAT'));
  const docker = attachContainerResources(
    attachDockerState(parseDocker(parseSection(raw, 'DOCKER')), parseDockerState(parseSection(raw, 'DOCKER_STATE'))),
    parseCgroupStats(parseSection(raw, 'CGROUP_STATS')),
    parsePsPpid(parseSection(raw, 'PS_PPID')),
  );
  const tmuxSessions = parseTmux(parseSection(raw, 'TMUX'));
  const screenSessions = parseScreen(parseSection(raw, 'SCREEN'));

  return {
    hostname,
    reachable: !!hostname,
    // Our probe prints SECTION:END last. Its absence means SSH was killed
    // mid-stream, so every section after the cut is empty for a reason that
    // has nothing to do with the hardware. Without this flag a truncated
    // probe is indistinguishable from a node that genuinely has no sensors,
    // no disks and no network — which is how a wedged mount on one box read
    // as "this machine reports no temperatures".
    truncated: !!hostname && !raw.includes('===SECTION:END==='),
    system: { arch, kernel, os: osName, cpuModel: cpuInfo.model, cpuMhz: cpuInfo.mhz, cpuCache: cpuInfo.cacheSize, cpuCores, userland: uf.kv.userland },
    memory,
    loadAvg,
    runnable,
    uptimeSeconds,
    disk,
    processes,
    processTree,
    claudeProcesses,
    harnessProcesses,
    harnessCounts,
    gpu: {
      nvidia: nvidiaGpus,
      nvidiaProcesses,
      amd: amdGpus,
      hasGpu: nvidiaGpus.length > 0 || amdGpus.length > 0,
    },
    // `temperatures` stays the raw ACPI zone list — the mesh overview page
    // reads that shape. `sensors` is the merged, labeled, limit-aware view.
    temperatures,
    sensors,
    throttle,
    cpuTopology,
    network: { interfaces: netInterfaces, throughput: netDev },
    containers: docker,
    sessions: { tmux: tmuxSessions, screen: screenSessions },
    probedAt: new Date().toISOString(),
  };
}
