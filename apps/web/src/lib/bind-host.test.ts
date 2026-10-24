import { describe, it, expect, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { spawnSync } from 'child_process';
import {
  resolveBind, parseSaved, saveChoice, isLoopback, isValidHost, hostFromArgs, bindFilePath, runningHost,
} from './bind-host.mjs';
import { nextArgs, banner } from '../../scripts/serve.mjs';

const dirs: string[] = [];
function tmpDir(): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'uf-bind-'));
  dirs.push(d);
  return d;
}
afterEach(() => { for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true }); });

const none = () => null;

describe('resolveBind', () => {
  it('is this machine only by default', () => {
    const b = resolveBind({ env: { UNFIREHOSE_DIR: '/x' }, read: none });
    expect(b).toMatchObject({ host: '127.0.0.1', lan: false, source: 'default', override: null, warning: null, file: '/x/web-bind.json' });
  });

  it('opens every interface once Settings → Phone saved {"lan": true}', () => {
    const b = resolveBind({ env: { UNFIREHOSE_DIR: '/x' }, read: () => '{"lan":true,"setAt":"2026-10-24T00:00:00Z"}' });
    expect(b).toMatchObject({ host: '0.0.0.0', lan: true, source: 'settings', saved: { lan: true, setAt: '2026-10-24T00:00:00Z' } });
  });

  it('lets UNFIREHOSE_HOST decide alone, either way', () => {
    expect(resolveBind({ env: { UNFIREHOSE_HOST: '127.0.0.1' }, read: () => '{"lan":true}' }))
      .toMatchObject({ host: '127.0.0.1', lan: false, source: 'env', override: '127.0.0.1', saved: { lan: true } });
    expect(resolveBind({ env: { UNFIREHOSE_HOST: '0.0.0.0' }, read: none })).toMatchObject({ host: '0.0.0.0', lan: true, source: 'env' });
    expect(resolveBind({ env: { UNFIREHOSE_HOST: '192.168.1.20' }, read: none })).toMatchObject({ host: '192.168.1.20', lan: true });
  });

  it('refuses a UNFIREHOSE_HOST that is not a host, and stays on loopback', () => {
    const b = resolveBind({ env: { UNFIREHOSE_HOST: '0.0.0.0; rm -rf /' }, read: () => '{"lan":true}' });
    expect(b.host).toBe('127.0.0.1');
    expect(b.lan).toBe(false);
    expect(b.warning).toContain('not an address or host name');
  });

  it('ignores an empty UNFIREHOSE_HOST', () => {
    expect(resolveBind({ env: { UNFIREHOSE_HOST: '  ' }, read: none }).source).toBe('default');
  });
});

describe('parseSaved', () => {
  it('reads anything but {"lan": true} as this machine only', () => {
    expect(parseSaved(null).lan).toBe(false);
    expect(parseSaved('').lan).toBe(false);
    expect(parseSaved('not json').lan).toBe(false);
    expect(parseSaved('[true]').lan).toBe(false);
    expect(parseSaved('{"lan":"true"}').lan).toBe(false);
    expect(parseSaved('{"lan":1}').lan).toBe(false);
    expect(parseSaved('{"lan":true}').lan).toBe(true);
  });
});

describe('saveChoice', () => {
  it('writes the file 0600 under UNFIREHOSE_DIR, which resolveBind then reads', () => {
    const dir = path.join(tmpDir(), 'data');
    const env = { UNFIREHOSE_DIR: dir };
    saveChoice(true, { env, now: new Date('2026-10-24T12:00:00Z') });
    const file = bindFilePath(env);
    expect(JSON.parse(fs.readFileSync(file, 'utf8'))).toEqual({ lan: true, setAt: '2026-10-24T12:00:00.000Z' });
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
    expect(resolveBind({ env }).host).toBe('0.0.0.0');
    saveChoice(false, { env });
    expect(resolveBind({ env }).host).toBe('127.0.0.1');
    expect(fs.readdirSync(dir)).toEqual(['web-bind.json']);
  });
});

describe('host helpers', () => {
  it('knows loopback', () => {
    expect(['127.0.0.1', '127.1.2.3', 'localhost', '::1', '[::1]'].every(isLoopback)).toBe(true);
    expect(['0.0.0.0', '::', '192.168.1.2', 'box.local'].some(isLoopback)).toBe(false);
  });

  it('accepts addresses and host names, nothing else', () => {
    expect(['127.0.0.1', '0.0.0.0', '::', '::1', 'fe80::1', 'localhost', 'box.lan'].every(isValidHost)).toBe(true);
    expect(['', '256.0.0.1', 'a b', '-x', 'x;y', '$(id)'].some(isValidHost)).toBe(false);
  });

  it('finds a host already on the command line', () => {
    expect(hostFromArgs(['-p', '3010'])).toBeNull();
    expect(hostFromArgs(['-H', '0.0.0.0'])).toBe('0.0.0.0');
    expect(hostFromArgs(['--hostname', '::'])).toBe('::');
    expect(hostFromArgs(['--hostname=10.0.0.5', '-p', '1'])).toBe('10.0.0.5');
  });

  it('reads the host our launcher started this server on', () => {
    expect(runningHost({ UNFIREHOSE_BOUND_HOST: '127.0.0.1' })).toBe('127.0.0.1');
    expect(runningHost({})).toBeNull();
  });
});

describe('scripts/serve.mjs', () => {
  it('adds -H from our settings before the rest of the args', () => {
    expect(nextArgs('dev', ['-p', '3010'], { host: '127.0.0.1' })).toEqual({ argv: ['dev', '-H', '127.0.0.1', '-p', '3010'], host: '127.0.0.1', explicit: false });
    expect(nextArgs('start', [], { host: '0.0.0.0' }).argv).toEqual(['start', '-H', '0.0.0.0']);
  });

  it('passes an explicit -H through untouched', () => {
    expect(nextArgs('start', ['-H', '0.0.0.0'], { host: '127.0.0.1' })).toEqual({ argv: ['start', '-H', '0.0.0.0'], host: '0.0.0.0', explicit: true });
  });

  it('says what is exposed when it is not loopback', () => {
    expect(banner('127.0.0.1', 'default')).toContain('this machine only');
    expect(banner('0.0.0.0', 'UNFIREHOSE_HOST')).toContain('push commits and type into tmux: there is no login');
  });

  it('refuses a mode it does not know, without starting anything', () => {
    const r = spawnSync(process.execPath, [path.resolve(__dirname, '../../scripts/serve.mjs'), 'build'], { encoding: 'utf8' });
    expect(r.status).toBe(2);
    expect(r.stderr).toContain('usage');
  });
});
