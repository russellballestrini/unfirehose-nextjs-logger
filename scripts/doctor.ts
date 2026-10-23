/**
 * `make doctor`: is this machine ready to run unfirehose, and if not, what
 * to do about it.
 *
 * This file only gathers facts (versions, sockets, processes, directories);
 * every green / yellow / red decision is in doctor-checks.ts, where it is
 * tested against fixtures. Read-only, no sudo, no network. Exits non-zero
 * only when something is red.
 *
 *   make doctor
 *   NO_COLOR=1 make doctor
 */
import { spawnSync } from 'child_process';
import { accessSync, constants, existsSync, readdirSync, readFileSync, readlinkSync, statSync, statfsSync } from 'fs';
import { createRequire } from 'module';
import net from 'net';
import path from 'path';
import { detectHarnesses } from '@unturf/unfirehose/harness-detect';
import { UNFIREHOSE_DIR } from '@unturf/unfirehose/db/data-dir';
import {
  type Check, type PortOwner, type ProcessInfo,
  checkNode, ciNodeVersion, dockerNodeVersion, checkSqlite, checkDataDir, checkDisk,
  parseSs, parseLsof, classifyPort, findDevStack, classifyWorker, checkHarnesses,
  formatReport, exitCode,
} from './doctor-checks';

const PORT = 3000;

function readText(p: string): string | null {
  try { return readFileSync(p, 'utf8'); } catch { return null; }
}

/** The nearest ancestor holding our root package.json (name "unfirehose"). */
function unfirehoseRootOf(dir: string): string | null {
  let d = path.resolve(dir);
  for (;;) {
    const pkg = readText(path.join(d, 'package.json'));
    if (pkg) {
      try { if (JSON.parse(pkg).name === 'unfirehose') return d; } catch { /* not json */ }
    }
    const up = path.dirname(d);
    if (up === d) return null;
    d = up;
  }
}

const repoRoot = unfirehoseRootOf(process.cwd()) ?? process.cwd();

function run(cmd: string, args: string[]): { ok: boolean; missing: boolean; stdout: string } {
  const r = spawnSync(cmd, args, { encoding: 'utf8', timeout: 5000 });
  const missing = (r.error as NodeJS.ErrnoException | undefined)?.code === 'ENOENT';
  return { ok: !r.error && r.status === 0, missing, stdout: r.stdout ?? '' };
}

// ---------------------------------------------------------------- facts

function nodeCheck(): Check {
  const corePkg = readText(path.join(repoRoot, 'packages/core/package.json'));
  let engines: string | null = null;
  try { engines = corePkg ? JSON.parse(corePkg).engines?.node ?? null : null; } catch { /* keep null */ }
  const ci = ciNodeVersion(readText(path.join(repoRoot, '.gitlab-ci.yml')) ?? '');
  const docker = dockerNodeVersion(readText(path.join(repoRoot, 'Dockerfile')) ?? '');
  return checkNode(process.version, engines, ci, docker);
}

function sqliteCheck(): Check {
  try {
    const req = createRequire(path.join(repoRoot, 'packages/core/package.json'));
    const Database = req('better-sqlite3');
    const db = new Database(':memory:');
    const version = (db.prepare('select sqlite_version() as v').get() as { v: string }).v;
    db.close();
    return checkSqlite({ ok: true, version });
  } catch (e) {
    return checkSqlite({ ok: false, error: e instanceof Error ? e.message : String(e) });
  }
}

function canAccess(p: string, mode: number): boolean {
  try { accessSync(p, mode); return true; } catch { return false; }
}

function nearestExisting(p: string): string {
  let d = path.resolve(p);
  while (!existsSync(d) && path.dirname(d) !== d) d = path.dirname(d);
  return d;
}

function dataDirChecks(): { checks: Check[]; dbPath: string } {
  const dir = UNFIREHOSE_DIR;
  // Same rule as db/schema.ts, which we cannot import: it loads
  // better-sqlite3 at the top, and a broken native build is one of the
  // things this script exists to report rather than die of.
  const dbPath = process.env.UNFIREHOSE_DB_PATH || path.join(dir, 'unfirehose.db');
  let isDir = false;
  const exists = existsSync(dir);
  try { isDir = statSync(dir).isDirectory(); } catch { /* missing */ }
  const checks = checkDataDir({
    dir, exists, isDir,
    writable: exists && canAccess(dir, constants.W_OK | constants.X_OK),
    parentWritable: canAccess(nearestExisting(path.dirname(dir)), constants.W_OK | constants.X_OK),
    dbPath,
    dbExists: existsSync(dbPath),
  });
  return { checks, dbPath };
}

function diskCheck(dbPath: string): Check {
  const at = nearestExisting(path.dirname(dbPath));
  try {
    const s = statfsSync(at);
    return checkDisk(at, Number(s.bavail) * Number(s.bsize));
  } catch {
    return checkDisk(at, null);
  }
}

/** Can we bind the port ourselves? Catches holders ss/lsof cannot see. */
function portInUse(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const srv = net.createServer();
    srv.once('error', (e: NodeJS.ErrnoException) => resolve(e.code === 'EADDRINUSE'));
    srv.once('listening', () => srv.close(() => resolve(false)));
    srv.listen(port);
  });
}

function procCmdline(pid: number): string | null {
  const raw = readText(`/proc/${pid}/cmdline`);
  return raw ? raw.replace(/\0+$/, '').replace(/\0/g, ' ') : null;
}

function procCwd(pid: number): string | null {
  try { return readlinkSync(`/proc/${pid}/cwd`); } catch { return null; }
}

function portOwners(port: number): PortOwner[] {
  let owners: PortOwner[] = [];
  const ss = run('ss', ['-ltnpH']);
  if (ss.ok) owners = parseSs(ss.stdout, port);
  else {
    const lsof = run('lsof', ['-nP', `-iTCP:${port}`, '-sTCP:LISTEN', '-Fpc']);
    owners = parseLsof(lsof.stdout);
  }
  return owners.map((o) => {
    if (o.pid === null) return o;
    const cmd = procCmdline(o.pid);
    const cwd = procCwd(o.pid);
    const root = cwd ? unfirehoseRootOf(cwd) : null;
    return { ...o, command: cmd || o.command, cwd, unfirehose: root !== null, thisCheckout: root === repoRoot };
  });
}

function processes(): ProcessInfo[] {
  let pids: number[] = [];
  try { pids = readdirSync('/proc').filter((n) => /^\d+$/.test(n)).map(Number); } catch { /* no procfs */ }
  if (pids.length) {
    return pids.map((pid) => ({ pid, cmd: procCmdline(pid) ?? '' })).filter((p) => p.cmd);
  }
  // macOS and friends: ps, which every POSIX box has.
  return run('ps', ['-eo', 'pid=,args=']).stdout.split('\n').flatMap((line) => {
    const m = /^\s*(\d+)\s+(.*)$/.exec(line);
    return m ? [{ pid: Number(m[1]), cmd: m[2] }] : [];
  });
}

function workerCheck(): Check {
  const r = run('systemctl', ['--user', 'is-active', 'unfirehose-worker']);
  // is-active exits non-zero for anything but active and still prints the
  // state; no output at all means there is no user manager to ask.
  const state = r.missing ? null : r.stdout.trim().split('\n')[0] || null;
  const known = state && /^(active|inactive|failed|activating|deactivating|reloading|unknown)$/.test(state) ? state : null;
  return classifyWorker(known, findDevStack(processes(), process.pid));
}

// ---------------------------------------------------------------- main

async function main() {
  const checks: Check[] = [nodeCheck(), sqliteCheck()];
  const { checks: dirChecks, dbPath } = dataDirChecks();
  checks.push(...dirChecks, diskCheck(dbPath));
  checks.push(classifyPort(PORT, await portInUse(PORT), portOwners(PORT)));
  checks.push(workerCheck());
  checks.push(...checkHarnesses(detectHarnesses(), Date.now()));

  const color = process.stdout.isTTY && !process.env.NO_COLOR;
  console.log(formatReport(checks, { color }));
  process.exitCode = exitCode(checks);
}

main().catch((e) => {
  console.error('doctor itself failed:', e instanceof Error ? e.stack : e);
  process.exitCode = 2;
});
