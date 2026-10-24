import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, statSync, existsSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import { NextRequest } from 'next/server';

/**
 * Editing ~/.ssh/config from the Permacomputer page, against a real file in
 * a temp home. The page loads the hosts with a hash of the file and sends
 * that hash back with every edit: a mismatch means somebody else wrote the
 * file since, and the route answers 409 rather than overwrite their change.
 */
const home = mkdtempSync(path.join(tmpdir(), 'ssh-config-home-'));
const sshDir = path.join(home, '.ssh');
const configPath = path.join(sshDir, 'config');

vi.mock('os', async (importOriginal) => {
  const real = await importOriginal<typeof import('os')>();
  return { ...real, default: { ...real, homedir: () => home }, homedir: () => home };
});

const { GET, POST, DELETE } = await import('./route');

const CONFIG = [
  'Host *',
  '    ServerAliveInterval 30',
  '',
  'Host alpha',
  '    HostName alpha.example.test',
  '    Port 2222',
  '    User fox',
  '    IdentityFile ~/.ssh/id_ed25519',
  '    ForwardAgent yes',
  '',
  'Host beta',
  '    Hostname 10.0.0.2',
  '',
].join('\n');

const req = (method: string, body: unknown) =>
  new NextRequest('http://localhost/api/ssh-config', { method, body: JSON.stringify(body), headers: { 'content-type': 'application/json' } });

async function load() {
  return (await GET()).json() as Promise<{ hosts: { name: string; hostname?: string; port?: string; user?: string; identityFile?: string; forwardAgent?: string }[]; keys: string[]; hash: string }>;
}

beforeEach(() => {
  rmSync(sshDir, { recursive: true, force: true });
  mkdirSync(sshDir, { recursive: true });
  writeFileSync(configPath, CONFIG);
  writeFileSync(path.join(sshDir, 'id_ed25519.pub'), 'ssh-ed25519 AAAA test');
  writeFileSync(path.join(sshDir, 'id_ed25519'), 'not a real key');
});
afterAll(() => rmSync(home, { recursive: true, force: true }));

describe('GET', () => {
  it('lists named hosts, skips wildcard blocks, and lists public keys by name', async () => {
    const { hosts, keys, hash } = await load();
    expect(hosts.map((h) => h.name)).toEqual(['alpha', 'beta']);
    expect(hosts[0]).toMatchObject({
      hostname: 'alpha.example.test', port: '2222', user: 'fox', identityFile: '~/.ssh/id_ed25519', forwardAgent: 'yes',
    });
    // Either spelling of HostName is read.
    expect(hosts[1].hostname).toBe('10.0.0.2');
    expect(keys).toEqual(['id_ed25519']);
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('reads a missing config and a missing ~/.ssh as no hosts and no keys', async () => {
    rmSync(sshDir, { recursive: true, force: true });
    const { hosts, keys } = await load();
    expect(hosts).toEqual([]);
    expect(keys).toEqual([]);
  });
});

describe('POST', () => {
  it('appends a new host, writing only the fields given, and returns the new hash', async () => {
    const { hash } = await load();
    const res = await POST(req('POST', { name: 'gamma', hostname: 'g.example.test', user: 'root', hash }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({ ok: true, host: { name: 'gamma', hostname: 'g.example.test', user: 'root' } });
    const text = readFileSync(configPath, 'utf8');
    expect(text.endsWith('Host gamma\n    HostName g.example.test\n    User root\n')).toBe(true);
    expect(text.startsWith(CONFIG.trimEnd())).toBe(true);
    expect(body.hash).toBe((await load()).hash);
    // Written owner-only, like ssh expects.
    expect(statSync(configPath).mode & 0o777).toBe(0o600);
    expect(existsSync(path.join(sshDir, `.config.tmp-${process.pid}`))).toBe(false);
  });

  it('replaces an existing block in place', async () => {
    await POST(req('POST', { name: 'alpha', hostname: 'new.example.test' }));
    const text = readFileSync(configPath, 'utf8');
    expect(text).toContain('Host alpha\n    HostName new.example.test\n\nHost beta');
    expect(text).not.toContain('Port 2222');
  });

  it('renames a host through originalName', async () => {
    await POST(req('POST', { name: 'alpha2', originalName: 'alpha', hostname: 'alpha.example.test' }));
    expect((await load()).hosts.map((h) => h.name)).toEqual(['alpha2', 'beta']);
  });

  it('refuses a rename onto a host that already has its own block', async () => {
    const res = await POST(req('POST', { name: 'beta', originalName: 'alpha' }));
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/already exists/);
    expect(readFileSync(configPath, 'utf8')).toBe(CONFIG);
  });

  it('refuses names that are wildcards, paths, or missing', async () => {
    for (const name of ['*', 'a/b', '..', '', 42]) {
      expect((await POST(req('POST', { name }))).status).toBe(400);
    }
    const res = await POST(req('POST', { name: 'ok', originalName: '../etc' }));
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/original/i);
    expect(readFileSync(configPath, 'utf8')).toBe(CONFIG);
  });

  it('answers 409 with the current hosts when the file changed since it was loaded', async () => {
    const { hash } = await load();
    writeFileSync(configPath, CONFIG + 'Host delta\n    HostName d\n');
    const res = await POST(req('POST', { name: 'gamma', hash }));
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.hosts.map((h: { name: string }) => h.name)).toEqual(['alpha', 'beta', 'delta']);
    expect(body.hash).not.toBe(hash);
    expect(readFileSync(configPath, 'utf8')).not.toContain('gamma');
  });
});

describe('DELETE', () => {
  it('removes one block and collapses the blank lines it leaves', async () => {
    const { hash } = await load();
    const res = await DELETE(req('DELETE', { name: 'alpha', hash }));
    expect(res.status).toBe(200);
    const text = readFileSync(configPath, 'utf8');
    expect(text).toBe('Host *\n    ServerAliveInterval 30\n\nHost beta\n    Hostname 10.0.0.2\n');
    expect((await res.json()).hash).toBe((await load()).hash);
  });

  it('answers 400 without a name, 404 for no config or no such host, 409 on a stale hash', async () => {
    expect((await DELETE(req('DELETE', {}))).status).toBe(400);
    expect((await DELETE(req('DELETE', { name: 'nobody' }))).status).toBe(404);
    expect((await DELETE(req('DELETE', { name: 'alpha', hash: 'stale' }))).status).toBe(409);
    rmSync(configPath);
    const res = await DELETE(req('DELETE', { name: 'alpha' }));
    expect(res.status).toBe(404);
    expect((await res.json()).error).toMatch(/No SSH config/);
  });
});
