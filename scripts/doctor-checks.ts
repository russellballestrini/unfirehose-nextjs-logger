/**
 * The decisions behind `make doctor`, with no I/O in them.
 *
 * scripts/doctor.ts gathers facts off this machine (node's version, what
 * `ss` says holds :3000, whether the worker unit is active, what
 * detectHarnesses() found) and hands them here. Everything that turns a fact
 * into green, yellow or red lives in this file, so each rule can be tested
 * against fixture input instead of whatever box the tests happen to run on.
 */

export type Level = 'green' | 'yellow' | 'red' | 'skip';

export interface Check {
  name: string;
  level: Level;
  /** What we saw, in one line. */
  detail: string;
  /** What to do about it. Always present on red. */
  fix?: string;
}

// ---------------------------------------------------------------- versions

export type Version = [number, number, number];

/** "v22.3.1", "22.3", ">=18", "^20.1" → [22, 3, 1]; null when nothing numeric. */
export function parseVersion(text: string): Version | null {
  const m = /(\d+)(?:\.(\d+))?(?:\.(\d+))?/.exec(text);
  if (!m) return null;
  return [Number(m[1]), Number(m[2] ?? 0), Number(m[3] ?? 0)];
}

export function compareVersions(a: Version, b: Version): number {
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] < b[i] ? -1 : 1;
  return 0;
}

/** NODE_VERSION="22.23.4" out of .gitlab-ci.yml. */
export function ciNodeVersion(gitlabCi: string): string | null {
  const m = /NODE_VERSION\s*[=:]\s*["']?(\d+\.\d+\.\d+)/.exec(gitlabCi);
  return m ? m[1] : null;
}

/** `FROM node:24.22.1-alpine@sha256:…` out of a Dockerfile. */
export function dockerNodeVersion(dockerfile: string): string | null {
  const m = /^FROM\s+node:(\d+(?:\.\d+){0,2})/m.exec(dockerfile);
  return m ? m[1] : null;
}

/**
 * Red below `engines` (it will not run), yellow below the major CI tests on
 * (it may run, nobody checks that it does), green at or above it.
 */
export function checkNode(current: string, engines: string | null, ci: string | null, docker: string | null): Check {
  const cur = parseVersion(current);
  const min = engines ? parseVersion(engines) : null;
  const pin = ci ? parseVersion(ci) : null;
  const pins = [ci && `CI ${ci}`, docker && `Docker ${docker}`, engines && `engines ${engines}`].filter(Boolean).join(', ');
  const detail = `${current}${pins ? ` (${pins})` : ''}`;
  const fix = `install node ${pin ? `${pin[0]}.x` : 'LTS'} (nvm install ${pin ? pin[0] : '--lts'}), then npm ci`;
  if (!cur) return { name: 'node', level: 'red', detail: `unreadable version "${current}"`, fix };
  if (min && compareVersions(cur, min) < 0) return { name: 'node', level: 'red', detail: `${detail}: below our minimum`, fix };
  if (pin && cur[0] < pin[0]) return { name: 'node', level: 'yellow', detail: `${detail}: older major than CI tests`, fix };
  return { name: 'node', level: 'green', detail };
}

// ---------------------------------------------------------------- sqlite

export function checkSqlite(result: { ok: true; version: string } | { ok: false; error: string }): Check {
  if (result.ok) return { name: 'better-sqlite3', level: 'green', detail: `native module loads, sqlite ${result.version}` };
  const firstLine = result.error.split('\n')[0].slice(0, 160);
  return {
    name: 'better-sqlite3',
    level: 'red',
    detail: `native module does not load: ${firstLine}`,
    fix: 'npm rebuild better-sqlite3 (at the repo root; after a node upgrade, or npm ci)',
  };
}

// ---------------------------------------------------------------- data dir

export interface DataDirFacts {
  dir: string;
  exists: boolean;
  isDir: boolean;
  writable: boolean;
  /** For a missing dir: can we create it? */
  parentWritable: boolean;
  dbPath: string;
  dbExists: boolean;
}

export function checkDataDir(f: DataDirFacts): Check[] {
  const out: Check[] = [];
  if (f.exists && !f.isDir) {
    out.push({ name: 'data dir', level: 'red', detail: `${f.dir} is a file, not a directory`, fix: `mv ${f.dir} ${f.dir}.bak` });
  } else if (!f.exists) {
    out.push(f.parentWritable
      ? { name: 'data dir', level: 'yellow', detail: `${f.dir} not created yet (first run makes it)`, fix: 'make dev, or make service-start' }
      : { name: 'data dir', level: 'red', detail: `${f.dir} missing and its parent is not writable`, fix: 'set UNFIREHOSE_DIR to a directory you own' });
  } else if (!f.writable) {
    out.push({ name: 'data dir', level: 'red', detail: `${f.dir} is not writable by this user`, fix: `chmod u+rwx ${f.dir} (as its owner), or set UNFIREHOSE_DIR` });
  } else {
    out.push({ name: 'data dir', level: 'green', detail: `${f.dir} writable` });
  }
  out.push(f.dbExists
    ? { name: 'database', level: 'green', detail: f.dbPath }
    : { name: 'database', level: 'yellow', detail: `${f.dbPath} not there yet: first run`, fix: 'start our worker (make dev) and it creates and fills it' });
  return out;
}

// ---------------------------------------------------------------- disk

export const GiB = 1024 ** 3;
export const DISK_RED_BYTES = 1 * GiB;
export const DISK_YELLOW_BYTES = 5 * GiB;

export function checkDisk(path: string, freeBytes: number | null): Check {
  if (freeBytes === null) return { name: 'disk', level: 'yellow', detail: `could not read free space at ${path}` };
  const gb = (freeBytes / GiB).toFixed(1);
  if (freeBytes < DISK_RED_BYTES) {
    return { name: 'disk', level: 'red', detail: `${gb} GiB free at ${path}`, fix: 'free space, or move UNFIREHOSE_DIR to a bigger disk; SQLite fails writes when full' };
  }
  if (freeBytes < DISK_YELLOW_BYTES) {
    return { name: 'disk', level: 'yellow', detail: `${gb} GiB free at ${path}`, fix: 'our database grows with every session; consider freeing space' };
  }
  return { name: 'disk', level: 'green', detail: `${gb} GiB free at ${path}` };
}

// ---------------------------------------------------------------- port

export interface PortOwner {
  pid: number | null;
  /** Short name (ss's comm, lsof's c field), or the full command line once known. */
  command: string;
  /** /proc/<pid>/cwd, when this user may read it. */
  cwd?: string | null;
  /** cwd sits inside an unfirehose checkout (this one or another). */
  unfirehose?: boolean;
  /** …and that checkout is the one doctor runs from. */
  thisCheckout?: boolean;
}

/** Does a "Local Address:Port" field name this port? Handles *:p, 0.0.0.0:p, [::]:p, [::ffff:1.2.3.4]:p, 127.0.0.1%lo:p. */
function addressHasPort(addr: string, port: number): boolean {
  const i = addr.lastIndexOf(':');
  return i >= 0 && addr.slice(i + 1) === String(port);
}

/**
 * Listeners on `port` from `ss -ltnpH` (or `ss -ltnp` with its header).
 * One socket may list several processes (a forked server shares the fd);
 * each is returned once. A socket owned by another user carries no
 * `users:` field, so it comes back with pid null.
 */
export function parseSs(output: string, port: number): PortOwner[] {
  const owners: PortOwner[] = [];
  const seen = new Set<string>();
  for (const line of output.split('\n')) {
    const cols = line.trim().split(/\s+/);
    if (cols.length < 4 || cols[0] === 'State') continue;
    // State Recv-Q Send-Q Local Peer [Process]
    if (!addressHasPort(cols[3], port)) continue;
    const procs = [...line.matchAll(/\("([^"]*)",pid=(\d+)/g)];
    if (procs.length === 0) {
      if (!seen.has('?')) { seen.add('?'); owners.push({ pid: null, command: '' }); }
      continue;
    }
    for (const p of procs) {
      const key = p[2];
      if (seen.has(key)) continue;
      seen.add(key);
      owners.push({ pid: Number(p[2]), command: p[1] });
    }
  }
  return owners;
}

/** `lsof -nP -iTCP:<port> -sTCP:LISTEN -Fpc`: lines of p<pid> then c<command>. */
export function parseLsof(output: string): PortOwner[] {
  const owners: PortOwner[] = [];
  let cur: PortOwner | null = null;
  for (const line of output.split('\n')) {
    if (line.startsWith('p')) {
      cur = { pid: Number(line.slice(1)), command: '' };
      if (!owners.some((o) => o.pid === cur!.pid)) owners.push(cur);
    } else if (line.startsWith('c') && cur) {
      cur.command = line.slice(1);
    }
  }
  return owners;
}

/** Next.js names its server process "next-server (v15.x)"; `next dev`/`next start` before that. */
export function looksLikeNext(command: string): boolean {
  return /next-server|\bnext(?:\/dist\/bin\/next)?\s+(?:dev|start)\b|node_modules\/\.bin\/next\b/.test(command);
}

function describe(o: PortOwner): string {
  if (o.pid === null) return 'a process this user cannot see (another user, or a container)';
  return `pid ${o.pid} ${o.command || '(unknown command)'}${o.cwd ? ` in ${o.cwd}` : ''}`;
}

/**
 * Free → green. Held by our Next.js web → green, and say so. Anything else
 * → red, naming every holder so a person knows what to stop.
 */
export function classifyPort(port: number, inUse: boolean, owners: PortOwner[]): Check {
  const name = `port ${port}`;
  if (!inUse && owners.length === 0) return { name, level: 'green', detail: 'free' };
  if (owners.length === 0) {
    return {
      name, level: 'red',
      detail: 'in use, and neither ss nor lsof could name the holder',
      fix: `sudo ss -ltnp 'sport = :${port}' to see who (by hand; doctor never sudos), or PORT=3001 make dev`,
    };
  }
  const ours = owners.every((o) => o.pid !== null && o.unfirehose && looksLikeNext(o.command));
  if (ours) {
    const o = owners[0];
    const where = o.thisCheckout ? 'this checkout' : `another unfirehose checkout${o.cwd ? ` (${o.cwd})` : ''}`;
    return { name, level: 'green', detail: `held by our own web, ${where}: pid ${owners.map((x) => x.pid).join(', ')}` };
  }
  const foreign = owners.filter((o) => !(o.pid !== null && o.unfirehose && looksLikeNext(o.command)));
  const pids = foreign.map((o) => o.pid).filter((p): p is number => p !== null);
  return {
    name, level: 'red',
    detail: `held by ${foreign.map(describe).join('; ')}`,
    fix: pids.length ? `stop it (kill ${pids.join(' ')}), or run ours elsewhere: PORT=3001 make dev` : `run ours elsewhere: PORT=3001 make dev`,
  };
}

// ---------------------------------------------------------------- worker

export interface ProcessInfo { pid: number; cmd: string }

/**
 * `make dev` processes: turbo's dev task and the worker's `tsx watch …
 * src/main.ts`. Same shapes the Makefile's service-start guard looks for.
 */
export function findDevStack(procs: ProcessInfo[], selfPid?: number): ProcessInfo[] {
  return procs.filter((p) => p.pid !== selfPid && (
    /\bturbo(?:\.js)?\s+(?:run\s+)?dev\b/.test(p.cmd)
    || /\btsx\b.*\bwatch\b.*(?:worker\/)?src\/main(?:\.ts)?\b/.test(p.cmd)
  ));
}

/**
 * `systemctl --user is-active unfirehose-worker` prints active, inactive,
 * failed, activating…; null when there is no user manager to ask.
 */
export function classifyWorker(unitState: string | null, dev: ProcessInfo[]): Check {
  const name = 'worker';
  const unitUp = unitState === 'active' || unitState === 'activating' || unitState === 'reloading';
  const devUp = dev.length > 0;
  const devPids = dev.map((p) => p.pid).join(', ');
  if (unitUp && devUp) {
    return {
      name, level: 'red',
      detail: `systemd unit is ${unitState} AND make dev is running (pid ${devPids}): two workers double-ingest`,
      fix: 'stop one: Ctrl-C our make dev, or make service-stop',
    };
  }
  if (unitUp) return { name, level: 'green', detail: `systemd user unit unfirehose-worker is ${unitState}` };
  if (devUp) return { name, level: 'green', detail: `make dev stack running (pid ${devPids})` };
  if (unitState === 'failed') {
    return { name, level: 'red', detail: 'systemd user unit unfirehose-worker has failed', fix: 'make service-logs to see why, then make service-restart' };
  }
  const unitNote = unitState === null ? 'no systemd user session to ask' : `unit ${unitState}`;
  return {
    name, level: 'yellow',
    detail: `not running (${unitNote}, no make dev): nothing is ingesting`,
    fix: 'make dev, or make service-install && make build && make service-start',
  };
}

// ---------------------------------------------------------------- harnesses

export interface HarnessFacts {
  id: string;
  label: string;
  root: string;
  doc: string;
  start?: string;
  found: boolean;
  readable: boolean;
  files: number;
  newestMs: number | null;
  truncated: boolean;
}

function ageWords(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 90) return `${s}s ago`;
  const m = Math.round(s / 60);
  if (m < 90) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 36) return `${h}h ago`;
  return `${Math.round(h / 24)}d ago`;
}

/**
 * Found and readable: green. Found but unreadable: red, a permissions
 * problem we can name. Not found: yellow when no harness is found at all
 * (nothing will ever be ingested); when some other harness is, an absent one
 * is just a harness this person does not use, listed but not flagged, so a
 * healthy box reads all green.
 */
export function checkHarnesses(list: HarnessFacts[], now: number, docRoot = 'packages/schema/docs'): Check[] {
  const anyFound = list.some((h) => h.found && h.readable);
  return list.map((h): Check => {
    const name = `harness ${h.label}`;
    if (h.found && !h.readable) {
      return { name, level: 'red', detail: `${h.root} exists but this user cannot read it`, fix: `chmod -R u+rX ${h.root} (as its owner)` };
    }
    if (h.found) {
      const files = `${h.files}${h.truncated ? '+' : ''} session file${h.files === 1 ? '' : 's'}`;
      const newest = h.newestMs !== null ? `, newest ${ageWords(now - h.newestMs)}` : '';
      return { name, level: 'green', detail: `${h.root}: ${files}${newest}` };
    }
    const how = h.start ? `run: ${h.start}` : `see ${docRoot}/${h.doc}`;
    return anyFound
      ? { name, level: 'skip', detail: `not on this machine (${h.root})`, fix: how }
      : { name, level: 'yellow', detail: `not found at ${h.root}`, fix: `${how}${h.start ? ` (adapters: ${docRoot}/${h.doc})` : ''}` };
  });
}

// ---------------------------------------------------------------- report

const MARK: Record<Level, string> = { green: ' ok ', yellow: 'warn', red: 'FAIL', skip: ' -- ' };
const COLOR: Record<Level, string> = { green: '\x1b[32m', yellow: '\x1b[33m', red: '\x1b[31m', skip: '\x1b[2m' };
const RESET = '\x1b[0m';

export function formatReport(checks: Check[], opts: { color?: boolean } = {}): string {
  const width = Math.max(...checks.map((c) => c.name.length), 4);
  const lines: string[] = [];
  for (const c of checks) {
    const mark = opts.color ? `${COLOR[c.level]}[${MARK[c.level]}]${RESET}` : `[${MARK[c.level]}]`;
    lines.push(`${mark} ${c.name.padEnd(width)}  ${c.detail}`);
    if (c.fix && c.level !== 'green') lines.push(`${' '.repeat(7 + width)}  ${c.level === 'skip' ? 'how' : 'fix'}: ${c.fix}`);
  }
  const n = (l: Level) => checks.filter((c) => c.level === l).length;
  lines.push('');
  lines.push(`${n('green')} ok, ${n('yellow')} warn, ${n('red')} fail`);
  return lines.join('\n');
}

/** Non-zero only when something is red. */
export function exitCode(checks: Check[]): number {
  return checks.some((c) => c.level === 'red') ? 1 : 0;
}
