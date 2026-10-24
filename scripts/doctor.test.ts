import { describe, it, expect, vi, beforeEach, afterEach, afterAll } from 'vitest';
import { EventEmitter } from 'events';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';

/**
 * `make doctor` end to end: the fact-gathering half.
 *
 * doctor-checks.test.ts proves every rule against fixtures. This proves the
 * gatherer hands those rules the right facts — what ss, lsof, systemctl and
 * ps said, whether :3000 binds, what the data directory looks like — by
 * replacing each command and the socket, and reading the report it prints.
 * The data directory is a real one in a temp dir; better-sqlite3 and the
 * repo's version pins are read for real, as doctor reads them.
 */

const s = vi.hoisted(() => ({
  dataDir: '',
  ss: { status: 0, stdout: '' } as { status: number; stdout: string; enoent?: boolean },
  lsof: '',
  systemctl: { status: 0, stdout: 'active\n' } as { status: number; stdout: string; enoent?: boolean },
  ps: '',
  portBusy: false,
  harnesses: [] as unknown[],
  harnessError: null as Error | null,
}));

vi.mock('child_process', async (orig) => {
  const real = await orig<typeof import('child_process')>();
  const reply = (r: { status: number; stdout: string; enoent?: boolean }) =>
    r.enoent ? { status: null, stdout: '', error: Object.assign(new Error('spawn ENOENT'), { code: 'ENOENT' }) } : { status: r.status, stdout: r.stdout };
  return {
    ...real,
    spawnSync: (cmd: string) => {
      if (cmd === 'ss') return reply(s.ss);
      if (cmd === 'lsof') return reply({ status: 0, stdout: s.lsof });
      if (cmd === 'systemctl') return reply(s.systemctl);
      if (cmd === 'ps') return reply({ status: 0, stdout: s.ps });
      throw new Error(`unexpected command ${cmd}`);
    },
  };
});

// No procfs listing, so the worker check reads `ps`, which we control.
// /proc/<pid>/cmdline and cwd stay real.
vi.mock('fs', async (orig) => {
  const real = await orig<typeof import('fs')>();
  const readdirSync = ((p: string, ...rest: unknown[]) => {
    if (p === '/proc') throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
    return (real.readdirSync as (...a: unknown[]) => unknown)(p, ...rest);
  }) as typeof real.readdirSync;
  return { ...real, default: { ...real, readdirSync }, readdirSync };
});

vi.mock('net', () => {
  const createServer = () => {
    const srv = new EventEmitter() as EventEmitter & { listen: (port: number) => void; close: (cb: () => void) => void };
    srv.listen = () => queueMicrotask(() => (s.portBusy
      ? srv.emit('error', Object.assign(new Error('in use'), { code: 'EADDRINUSE' }))
      : srv.emit('listening')));
    srv.close = (cb) => cb();
    return srv;
  };
  return { default: { createServer }, createServer };
});

vi.mock('@unturf/unfirehose/harness-detect', () => ({
  detectHarnesses: () => { if (s.harnessError) throw s.harnessError; return s.harnesses; },
}));
vi.mock('@unturf/unfirehose/db/data-dir', () => ({ get UNFIREHOSE_DIR() { return s.dataDir; } }));

const tmp = mkdtempSync(path.join(tmpdir(), 'doctor-'));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

const claude = (found: boolean) => ({
  id: 'claude-code', label: 'Claude Code', root: '/home/x/.claude/projects', doc: 'claude-code.md',
  found, readable: found, files: found ? 3 : 0, newestMs: found ? Date.now() - 5_000 : null, truncated: false,
});

let log: ReturnType<typeof vi.spyOn>;
let err: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  vi.resetModules();
  vi.stubEnv('NO_COLOR', '1');
  vi.stubEnv('UNFIREHOSE_DB_PATH', '');
  s.dataDir = path.join(tmp, `data-${Math.random().toString(36).slice(2)}`);
  s.ss = { status: 0, stdout: '' };
  s.lsof = '';
  s.systemctl = { status: 0, stdout: 'active\n' };
  s.ps = '    1 /sbin/init\n';
  s.portBusy = false;
  s.harnesses = [claude(true)];
  s.harnessError = null;
  log = vi.spyOn(console, 'log').mockImplementation(() => {});
  err = vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => {
  // doctor sets the exit code for `make`; it must not leak into the test run.
  process.exitCode = undefined;
  vi.unstubAllEnvs();
});

/** Import doctor (which runs it) and hand back what it printed and the exit code it chose. */
async function runDoctor(): Promise<{ report: string; line: (name: string) => string; exitCode: number | undefined }> {
  await import('./doctor');
  await vi.waitFor(() => { if (log.mock.calls.length === 0 && err.mock.calls.length === 0) throw new Error('not yet'); }, { timeout: 10_000 });
  const report = String(log.mock.calls[0]?.[0] ?? '');
  const exitCode = process.exitCode as number | undefined;
  process.exitCode = undefined;
  const line = (name: string) => report.split('\n').find((l) => l.slice(7).startsWith(name)) ?? `(no ${name} line)`;
  return { report, line, exitCode };
}

describe('doctor', () => {
  it('reports a ready machine: data dir and database there, port free, worker unit active, a harness found', async () => {
    mkdirSync(s.dataDir);
    writeFileSync(path.join(s.dataDir, 'unfirehose.db'), '');
    const { report, line } = await runDoctor();
    expect(line('better-sqlite3')).toMatch(/^\[ ok \].*native module loads, sqlite \d+\.\d+/);
    expect(line('node')).toContain(process.version);
    expect(line('data dir')).toMatch(/^\[ ok \].*writable/);
    expect(line('database')).toMatch(/^\[ ok \].*unfirehose\.db/);
    expect(line('disk')).toMatch(/GiB free at /);
    expect(line('port 3000')).toMatch(/^\[ ok \].*free$/);
    expect(line('worker')).toMatch(/^\[ ok \].*unfirehose-worker is active/);
    expect(line('harness Claude Code')).toMatch(/^\[ ok \].*3 session files, newest \d+s ago/);
    expect(report).toMatch(/\d+ ok, \d+ warn, \d+ fail$/);
  });

  it('names whoever holds the port, through lsof when ss is not there, and sees make dev through ps', async () => {
    // A data dir not made yet, under a parent we can write: a first run.
    s.ss = { status: 1, stdout: '', enoent: true };
    s.lsof = `p${process.pid}\ncnode\n`;
    s.portBusy = true;
    s.systemctl = { status: 0, stdout: '', enoent: true };
    s.ps = `    1 /sbin/init\n 4242 node /x/node_modules/.bin/turbo run dev\n`;
    const { line, exitCode } = await runDoctor();
    expect(line('data dir')).toMatch(/^\[warn\].*not created yet/);
    expect(line('database')).toMatch(/^\[warn\].*first run/);
    // This test runner is no Next.js server: red, by pid, with its command line.
    expect(line('port 3000')).toMatch(new RegExp(`^\\[FAIL\\] .*held by pid ${process.pid} \\S*node`));
    expect(line('worker')).toMatch(/^\[ ok \].*make dev stack running \(pid 4242\)/);
    expect(exitCode).toBe(1);
  });

  it('finds the holder in ss output, and flags a failed worker unit and a data dir that is a file', async () => {
    writeFileSync(s.dataDir, 'not a directory');
    s.ss = { status: 0, stdout: `LISTEN 0 511 *:3000 *:* users:(("node",pid=${process.pid},fd=20))\n` };
    s.portBusy = true;
    s.systemctl = { status: 3, stdout: 'failed\n' };
    const { line, report, exitCode } = await runDoctor();
    expect(line('data dir')).toMatch(/^\[FAIL\].*is a file, not a directory/);
    expect(line('port 3000')).toContain(`pid ${process.pid}`);
    expect(line('worker')).toMatch(/^\[FAIL\].*has failed/);
    expect(report).toContain('fix: make service-logs');
    expect(exitCode).toBe(1);
  });

  it('warns that nothing will ever be ingested when no harness is found and no worker runs', async () => {
    mkdirSync(s.dataDir);
    s.harnesses = [claude(false)];
    s.systemctl = { status: 3, stdout: 'inactive\n' };
    const { line } = await runDoctor();
    expect(line('harness Claude Code')).toMatch(/^\[warn\].*not found at/);
    expect(line('worker')).toMatch(/^\[warn\].*unit inactive, no make dev/);
  });

  it('treats unrecognised systemctl output as no user manager to ask', async () => {
    mkdirSync(s.dataDir);
    s.systemctl = { status: 1, stdout: 'Failed to connect to bus\n' };
    const { line } = await runDoctor();
    expect(line('worker')).toMatch(/no systemd user session to ask/);
  });

  it('says so, and exits 2, when doctor itself fails', async () => {
    mkdirSync(s.dataDir);
    s.harnessError = new Error('boom');
    await import('./doctor');
    await vi.waitFor(() => expect(err).toHaveBeenCalled(), { timeout: 10_000 });
    expect(err.mock.calls[0][0]).toBe('doctor itself failed:');
    expect(String(err.mock.calls[0][1])).toContain('boom');
    expect(process.exitCode).toBe(2);
  });
});
