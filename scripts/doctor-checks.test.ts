import { describe, it, expect } from 'vitest';

/**
 * `make doctor`'s rules, fed fixtures rather than this machine: a doctor
 * that only ever ran against its author's box would pass on its author's box.
 */

import {
  parseVersion, compareVersions, ciNodeVersion, dockerNodeVersion, checkNode,
  checkSqlite, checkDataDir, checkDisk, GiB,
  parseSs, parseLsof, looksLikeNext, classifyPort,
  findDevStack, classifyWorker, checkHarnesses, formatReport, exitCode,
  type HarnessFacts,
} from './doctor-checks';

describe('versions', () => {
  it('parses node, engines and partial versions', () => {
    expect(parseVersion('v22.22.0')).toEqual([22, 22, 0]);
    expect(parseVersion('>=18')).toEqual([18, 0, 0]);
    expect(parseVersion('^20.1')).toEqual([20, 1, 0]);
    expect(parseVersion('banana')).toBeNull();
  });

  it('compares numerically, not as strings', () => {
    expect(compareVersions([22, 10, 0], [22, 9, 9])).toBe(1);
    expect(compareVersions([18, 0, 0], [18, 0, 0])).toBe(0);
    expect(compareVersions([9, 0, 0], [18, 0, 0])).toBe(-1);
  });

  it('reads what CI and the Dockerfile pin', () => {
    expect(ciNodeVersion('  NODE_VERSION="22.23.4"\n')).toBe('22.23.4');
    expect(ciNodeVersion('nothing here')).toBeNull();
    expect(dockerNodeVersion('FROM node:24.22.1-alpine@sha256:abc AS builder\n')).toBe('24.22.1');
    expect(dockerNodeVersion('FROM alpine:3')).toBeNull();
  });

  it('red below engines, yellow below the CI major, green otherwise', () => {
    expect(checkNode('v16.20.0', '>=18', '22.23.4', null).level).toBe('red');
    expect(checkNode('v16.20.0', '>=18', '22.23.4', null).fix).toMatch(/nvm install 22/);
    expect(checkNode('v20.11.0', '>=18', '22.23.4', null).level).toBe('yellow');
    expect(checkNode('v22.1.0', '>=18', '22.23.4', '24.22.1').level).toBe('green');
    expect(checkNode('v24.0.0', '>=18', '22.23.4', null).level).toBe('green');
    expect(checkNode('v20.0.0', null, null, null).level).toBe('green');
    expect(checkNode('???', '>=18', null, null).level).toBe('red');
  });
});

describe('better-sqlite3', () => {
  it('green when it loads; red with the rebuild command when not', () => {
    expect(checkSqlite({ ok: true, version: '3.51.2' }).level).toBe('green');
    const bad = checkSqlite({ ok: false, error: 'The module was compiled against NODE_MODULE_VERSION 115.\nmore' });
    expect(bad.level).toBe('red');
    expect(bad.detail).not.toMatch(/more/);
    expect(bad.fix).toMatch(/npm rebuild better-sqlite3/);
  });
});

describe('data dir', () => {
  const base = { dir: '/h/.unfirehose', exists: true, isDir: true, writable: true, parentWritable: true, dbPath: '/h/.unfirehose/unfirehose.db', dbExists: true };

  it('all green when present, writable, with a database', () => {
    expect(checkDataDir(base).map((c) => c.level)).toEqual(['green', 'green']);
  });

  it('a first run is yellow, not red', () => {
    expect(checkDataDir({ ...base, exists: false, isDir: false, writable: false, dbExists: false }).map((c) => c.level)).toEqual(['yellow', 'yellow']);
  });

  it('red when it cannot be written or created', () => {
    expect(checkDataDir({ ...base, writable: false })[0].level).toBe('red');
    expect(checkDataDir({ ...base, exists: false, isDir: false, parentWritable: false })[0].level).toBe('red');
    expect(checkDataDir({ ...base, isDir: false })[0].level).toBe('red');
  });
});

describe('disk', () => {
  it('red under 1 GiB, yellow under 10 GiB', () => {
    expect(checkDisk('/', 0.5 * GiB).level).toBe('red');
    expect(checkDisk('/', 0.5 * GiB).fix).toBeTruthy();
    expect(checkDisk('/', 3 * GiB).level).toBe('yellow');
    // Under 10 GiB warns: a few months of growth, and room for a VACUUM's copy.
    expect(checkDisk('/', 9.5 * GiB).level).toBe('yellow');
    expect(checkDisk('/', 9.5 * GiB).fix).toContain('make vacuum');
    expect(checkDisk('/', 10 * GiB).level).toBe('green');
    expect(checkDisk('/', 50 * GiB).level).toBe('green');
    expect(checkDisk('/', null).level).toBe('yellow');
  });
});

describe('port 3000', () => {
  // `ss -ltnpH` as a non-root user sees: its own sockets with users:(…),
  // another user's with none.
  const ss = [
    'LISTEN 0      511          0.0.0.0:22         0.0.0.0:*    users:(("sshd",pid=812,fd=3))',
    'LISTEN 0      511                *:3000             *:*    users:(("python3",pid=4242,fd=3))',
    'LISTEN 0      4096       127.0.0.1:30000      0.0.0.0:*    users:(("other",pid=9,fd=3))',
  ].join('\n');

  it('parses the holder out of ss, and only on our port', () => {
    expect(parseSs(ss, 3000)).toEqual([{ pid: 4242, command: 'python3' }]);
    expect(parseSs(ss, 30)).toEqual([]);
  });

  it('handles the header, IPv6, a forked server sharing one socket, and a hidden owner', () => {
    const out = [
      'State  Recv-Q Send-Q Local Address:Port Peer Address:Port Process',
      'LISTEN 0      511             [::]:3000          [::]:*    users:(("next-server (v1",pid=100,fd=20),("next-server (v1",pid=101,fd=20))',
      'LISTEN 0      511          0.0.0.0:3000       0.0.0.0:*    users:(("next-server (v1",pid=100,fd=21))',
    ].join('\n');
    expect(parseSs(out, 3000).map((o) => o.pid)).toEqual([100, 101]);
    expect(parseSs('LISTEN 0 511 [::ffff:127.0.0.1]:3000 [::]:*', 3000)).toEqual([{ pid: null, command: '' }]);
  });

  it('parses lsof -Fpc', () => {
    expect(parseLsof('p4242\ncnode\nf3\np77\ncpython3\n')).toEqual([
      { pid: 4242, command: 'node' }, { pid: 77, command: 'python3' },
    ]);
  });

  it('knows a Next.js server when it sees one', () => {
    expect(looksLikeNext('next-server (v15.5.4)')).toBe(true);
    expect(looksLikeNext('node /repo/node_modules/.bin/next dev')).toBe(true);
    expect(looksLikeNext('node /repo/node_modules/next/dist/bin/next start')).toBe(true);
    expect(looksLikeNext('python3 -m http.server 3000')).toBe(false);
  });

  it('free is green', () => {
    expect(classifyPort(3000, false, []).level).toBe('green');
  });

  it('held by something else is red and names the process', () => {
    const owners = parseSs(ss, 3000).map((o) => ({ ...o, command: 'python3 -m http.server 3000', cwd: '/tmp', unfirehose: false }));
    const c = classifyPort(3000, true, owners);
    expect(c.level).toBe('red');
    expect(c.detail).toContain('pid 4242');
    expect(c.detail).toContain('python3 -m http.server 3000');
    expect(c.fix).toContain('kill 4242');
  });

  it('held by our own web is green and says so', () => {
    const c = classifyPort(3000, true, [{ pid: 100, command: 'next-server (v15.5.4)', cwd: '/repo/apps/web', unfirehose: true, thisCheckout: true }]);
    expect(c.level).toBe('green');
    expect(c.detail).toMatch(/our own web, this checkout/);
    const other = classifyPort(3000, true, [{ pid: 100, command: 'next-server (v15.5.4)', cwd: '/main/apps/web', unfirehose: true, thisCheckout: false }]);
    expect(other.level).toBe('green');
    expect(other.detail).toMatch(/another unfirehose checkout/);
  });

  it('another Next.js app is not ours', () => {
    expect(classifyPort(3000, true, [{ pid: 5, command: 'next-server (v14)', cwd: '/blog', unfirehose: false }]).level).toBe('red');
  });

  it('taken with no visible owner is red, and the fix never runs sudo for us', () => {
    const hidden = classifyPort(3000, true, [{ pid: null, command: '' }]);
    expect(hidden.level).toBe('red');
    expect(hidden.detail).toMatch(/cannot see/);
    const unknown = classifyPort(3000, true, []);
    expect(unknown.level).toBe('red');
    expect(unknown.fix).toMatch(/by hand/);
  });
});

describe('worker', () => {
  const procs = [
    { pid: 1, cmd: '/sbin/init' },
    { pid: 10, cmd: 'node /repo/node_modules/.bin/turbo dev' },
    { pid: 11, cmd: 'node /repo/node_modules/tsx/dist/cli.mjs watch --include ../../packages/core/**/*.ts src/main.ts' },
    { pid: 12, cmd: 'node /repo/node_modules/.bin/tsx src/main.ts' },
    { pid: 13, cmd: 'vim scripts/doctor.ts' },
  ];

  it('finds make dev processes and not a production worker', () => {
    expect(findDevStack(procs).map((p) => p.pid)).toEqual([10, 11]);
    expect(findDevStack(procs, 10).map((p) => p.pid)).toEqual([11]);
  });

  it('red if both run, yellow if neither, green for exactly one', () => {
    const dev = findDevStack(procs);
    expect(classifyWorker('active', dev).level).toBe('red');
    expect(classifyWorker('active', dev).detail).toMatch(/double-ingest/);
    expect(classifyWorker('active', []).level).toBe('green');
    expect(classifyWorker('inactive', dev).level).toBe('green');
    expect(classifyWorker(null, dev).level).toBe('green');
    expect(classifyWorker('inactive', []).level).toBe('yellow');
    expect(classifyWorker(null, []).level).toBe('yellow');
  });

  it('a failed unit is red with where to look', () => {
    const c = classifyWorker('failed', []);
    expect(c.level).toBe('red');
    expect(c.fix).toMatch(/service-logs/);
  });
});

describe('harnesses', () => {
  const now = 1_800_000_000_000;
  const h = (over: Partial<HarnessFacts>): HarnessFacts => ({
    id: 'x', label: 'X', root: '/h/.x', doc: 'harnesses/x.md',
    found: false, readable: false, files: 0, newestMs: null, truncated: false, ...over,
  });
  const claude = h({ id: 'claude-code', label: 'Claude Code', root: '/h/.claude/projects', doc: 'harnesses/claude-code.md', start: 'cd ~/your/repo && claude' });

  it('found and readable is green with count and age', () => {
    const [c] = checkHarnesses([{ ...claude, found: true, readable: true, files: 12, newestMs: now - 3 * 3600_000 }], now);
    expect(c.level).toBe('green');
    expect(c.detail).toMatch(/12 session files, newest 3h ago/);
  });

  it('found but unreadable is red with a chmod', () => {
    const [c] = checkHarnesses([{ ...claude, found: true, readable: false }], now);
    expect(c.level).toBe('red');
    expect(c.fix).toMatch(/chmod -R u\+rX \/h\/\.claude\/projects/);
  });

  it('nothing found anywhere is yellow, with how to start one', () => {
    const cs = checkHarnesses([claude, h({ label: 'Fetch', doc: 'harnesses/fetch.md' })], now);
    expect(cs.map((c) => c.level)).toEqual(['yellow', 'yellow']);
    expect(cs[0].fix).toMatch(/cd ~\/your\/repo && claude/);
    expect(cs[1].fix).toMatch(/packages\/schema\/docs\/harnesses\/fetch\.md/);
  });

  it('an unused harness beside a working one is listed, not flagged', () => {
    const cs = checkHarnesses([{ ...claude, found: true, readable: true, files: 1, newestMs: now }, h({ label: 'Fetch' })], now);
    expect(cs.map((c) => c.level)).toEqual(['green', 'skip']);
    expect(exitCode(cs)).toBe(0);
  });
});

describe('report', () => {
  it('prints the fix under each red and exits non-zero only on red', () => {
    const checks = [
      { name: 'node', level: 'green' as const, detail: 'v22' },
      { name: 'port 3000', level: 'red' as const, detail: 'held by pid 1 x', fix: 'kill 1' },
      { name: 'worker', level: 'yellow' as const, detail: 'idle', fix: 'make dev' },
    ];
    const out = formatReport(checks);
    expect(out).toMatch(/\[FAIL\] port 3000 +held by pid 1 x\n +fix: kill 1/);
    expect(out).toMatch(/\[warn\] worker/);
    expect(out).toMatch(/1 ok, 1 warn, 1 fail/);
    expect(out).not.toMatch(/\x1b\[/);
    expect(formatReport(checks, { color: true })).toMatch(/\x1b\[31m/);
    expect(exitCode(checks)).toBe(1);
    expect(exitCode(checks.filter((c) => c.level !== 'red'))).toBe(0);
  });
});
