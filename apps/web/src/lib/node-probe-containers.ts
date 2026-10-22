import { round } from './node-probe-sections';

/**
 * Container parsers for our node probe: `docker ps`, `docker inspect`,
 * cgroup stats, the host process table a container's tree is cut from,
 * and the cgroup scan that finds containers when the socket is refused.
 */

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

/**
 * Containers discovered from the cgroup filesystem, when the docker socket
 * could not be reached. `id|rootpid|comm` per running container. This is the
 * only view of containers on a node where our user is not in the docker
 * group (cammy: fox is in sudo, not docker), so `docker ps` is refused; the
 * cgroups it cannot forbid still name every running container.
 */
export interface CgroupContainer {
  /** docker | lxc | nspawn -- which runtime owns this cgroup. */
  runtime: string;
  /** Short id (docker: 12-char hex; lxc/nspawn: the machine name). */
  id: string;
  /** Full id, for matching cgroup stats keyed by it. */
  fullId: string;
  rootPid: number;
  /** The root process's command name -- a stand-in for the image the socket would name. */
  rootComm: string;
}

/**
 * Containers found in the cgroup filesystem: `runtime|id|pid|comm` per line.
 * docker rows carry a 64-hex id; lxc/LXD and systemd-nspawn carry a human
 * machine name. The older two-field `id|pid|comm` shape (docker only) still
 * parses, read as runtime docker.
 */
/**
 * systemd escapes a machine unit name -- a hyphen becomes \x2d, so a libvirt
 * guest tracked by machined reads "qemu\x2d1\x2dvm". Decode for display; the
 * raw form stays the cgroup key.
 */
export function unescapeMachineName(v: string): string {
  return v.replace(/\\x([0-9a-fA-F]{2})/g, (_m, h) => String.fromCharCode(parseInt(h, 16)));
}

export function parseDockerCgroup(raw: string): CgroupContainer[] {
  if (!raw || raw === 'none') return [];
  const out: CgroupContainer[] = [];
  for (const line of raw.split('\n')) {
    const parts = line.split('|');
    let runtime: string, full: string, pidStr: string, comm: string;
    if (/^(docker|lxc|nspawn)$/.test(parts[0]?.trim() ?? '')) {
      runtime = parts[0]!.trim(); full = (parts[1] ?? '').trim(); pidStr = parts[2] ?? ''; comm = (parts[3] ?? '').trim();
    } else {
      runtime = 'docker'; full = (parts[0] ?? '').trim(); pidStr = parts[1] ?? ''; comm = (parts[2] ?? '').trim();
    }
    if (!full) continue;
    // A docker id must look like one; a named runtime's id is free text.
    if (runtime === 'docker' && !/^[0-9a-f]{12,}$/.test(full)) continue;
    const pid = parseInt(pidStr);
    // id stays raw -- it is the key cgroup stats are reported under, so it
    // must match byte for byte. The display name is decoded in the merge.
    const id = runtime === 'docker' ? full.slice(0, 12) : full;
    out.push({ runtime, id, fullId: full, rootPid: Number.isFinite(pid) ? pid : 0, rootComm: comm });
  }
  return out;
}

/**
 * Add the cgroup-discovered containers that `docker ps` did not list. When
 * the socket answered, its rows win (they carry names, images, ports); the
 * cgroup scan only fills in what the socket could not see -- which is
 * everything, on a node where the socket is denied. A synthesized row is
 * marked running (a cgroup means a live container) and named by its short
 * id, since the runtime's name lives behind the socket we were refused.
 */
export function mergeCgroupContainers<C extends { id: string; state?: string }>(
  docker: C[], cgroup: CgroupContainer[],
): (C | { id: string; name: string; image: string; status: string; ports: string; state: string; pid: number; rootComm: string; runtime: string; viaCgroup: true })[] {
  if (cgroup.length === 0) return docker;
  const have = docker.map((c) => c.id);
  const seen = (full: string) => have.some((h) => full.startsWith(h) || h.startsWith(full.slice(0, 12)));
  const extra = cgroup
    .filter((c) => !seen(c.fullId))
    .map((c) => ({
      // An lxc/nspawn cgroup already carries a human name; a docker one is a
      // hex id, so it reads better named by its root process ("postgres",
      // "uvicorn", "tini") with the id kept on the meta line. The runtime's
      // own name, where it has one, lives behind the socket we were refused.
      id: c.id,
      name: c.runtime === 'docker' ? (c.rootComm || c.id) : unescapeMachineName(c.id),
      image: '', status: 'running', ports: '',
      state: 'running', pid: c.rootPid, rootComm: c.rootComm,
      runtime: c.runtime, viaCgroup: true as const,
    }));
  return [...docker, ...extra];
}
