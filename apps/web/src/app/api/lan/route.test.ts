import { describe, it, expect, vi, beforeEach, afterEach, afterAll } from 'vitest';
import net from 'net';
import fs from 'fs';
import path from 'path';
import { tmpdir } from 'os';
import type { NetworkInterfaceInfo } from 'os';

/**
 * GET /api/lan reads this machine's interfaces; the machine running the
 * tests is not the one in question, so os is replaced with a made-up host
 * that has every kind of interface our filter has to sort out.
 */

const v4 = (address: string, internal = false) =>
  ({ address, family: 'IPv4', internal, netmask: '255.255.255.0', mac: '00:00:00:00:00:00', cidr: `${address}/24` }) as NetworkInterfaceInfo;
const v6 = (address: string) =>
  ({ address, family: 'IPv6', internal: false, netmask: 'ffff::', mac: '00:00:00:00:00:00', cidr: `${address}/64`, scopeid: 0 }) as NetworkInterfaceInfo;

let ifaces: NodeJS.Dict<NetworkInterfaceInfo[]> = {};
vi.mock('os', async (orig) => {
  const real = await orig<typeof import('os')>();
  const fake = { ...real, networkInterfaces: () => ifaces, hostname: () => 'box' };
  return { ...fake, default: fake };
});

// Which addresses "accept" a connection: the real probe is tested below
// against a socket of our own; here it would wait on addresses that exist
// only in this file.
const listening = new Set<string>();
vi.mock('@/lib/lan', async (orig) => {
  const real = await orig<typeof import('@/lib/lan')>();
  return { ...real, listensOn: vi.fn(async (a: string) => listening.has(a)) };
});

const { GET, POST } = await import('./route');
const { lanAddresses, portOf, isPrivateV4, isCgnatV4 } = await import('@/lib/lan');

// Our bind choice lives in $UNFIREHOSE_DIR; each test gets an empty one, and
// none of the environment that decides it leaks in from the machine.
let dataDir = '';
const ENV_KEYS = ['UNFIREHOSE_DIR', 'UNFIREHOSE_HOST', 'UNFIREHOSE_BOUND_HOST', 'UNFIREHOSE_CONTAINER'] as const;
const savedEnv: Record<string, string | undefined> = {};
beforeEach(() => {
  for (const k of ENV_KEYS) { savedEnv[k] = process.env[k]; delete process.env[k]; }
  dataDir = fs.mkdtempSync(path.join(tmpdir(), 'uf-lan-'));
  process.env.UNFIREHOSE_DIR = dataDir;
});
afterEach(() => {
  for (const k of ENV_KEYS) { if (savedEnv[k] === undefined) delete process.env[k]; else process.env[k] = savedEnv[k]; }
  fs.rmSync(dataDir, { recursive: true, force: true });
});

beforeEach(() => {
  listening.clear();
  ifaces = {
    lo: [v4('127.0.0.1', true)],
    wlp3s0: [v4('192.168.1.20'), v6('fe80::1')],
    eth0: [v4('10.0.0.5')],
    docker0: [v4('172.17.0.1')],
    'br-3f2a9c1d7e44': [v4('172.18.0.1')],
    tailscale0: [v4('100.101.102.103')],
    enp0s31f6: [v4('169.254.10.1')],
    ens5: [v4('203.0.113.7')],
  };
});

describe('GET /api/lan', () => {
  it('lists LAN addresses first, then VPN, then public, with a URL at our port', async () => {
    listening.add('192.168.1.20');
    const body = await (await GET(new Request('http://localhost:3010/api/lan'))).json();
    expect(body.port).toBe(3010);
    expect(body.hostname).toBe('box');
    expect(body.addresses).toEqual([
      { address: '10.0.0.5', iface: 'eth0', kind: 'lan', url: 'http://10.0.0.5:3010/', listening: false },
      { address: '192.168.1.20', iface: 'wlp3s0', kind: 'lan', url: 'http://192.168.1.20:3010/', listening: true },
      { address: '100.101.102.103', iface: 'tailscale0', kind: 'vpn', url: 'http://100.101.102.103:3010/', listening: false },
      { address: '203.0.113.7', iface: 'ens5', kind: 'public', url: 'http://203.0.113.7:3010/', listening: false },
    ]);
  });

  it('says what it skipped and why: loopback, link-local, container bridges, IPv6', async () => {
    const body = await (await GET(new Request('http://localhost:3000/api/lan'))).json();
    const reasons = Object.fromEntries(body.skipped.map((s: { address: string; reason: string }) => [s.address, s.reason]));
    expect(reasons).toEqual({
      '127.0.0.1': 'loopback',
      'fe80::1': 'ipv6',
      '172.17.0.1': 'virtual bridge',
      '172.18.0.1': 'virtual bridge',
      '169.254.10.1': 'link-local',
    });
  });

  it('answers an empty list on a machine with no network, not an error', async () => {
    ifaces = { lo: [v4('127.0.0.1', true)] };
    const res = await GET(new Request('http://localhost:3000/api/lan'));
    expect(res.status).toBe(200);
    expect((await res.json()).addresses).toEqual([]);
  });
});

const post = (body: unknown, headers: Record<string, string> = {}) =>
  POST(new Request('http://localhost:3000/api/lan', {
    method: 'POST', body: typeof body === 'string' ? body : JSON.stringify(body),
    headers: { 'content-type': 'application/json', 'sec-fetch-site': 'same-origin', ...headers },
  }));

describe('bind state', () => {
  it('reports how this server was started and that nothing is saved', async () => {
    process.env.UNFIREHOSE_BOUND_HOST = '127.0.0.1';
    const { bind } = await (await GET(new Request('http://localhost:3000/api/lan'))).json();
    expect(bind).toMatchObject({
      running: '127.0.0.1', runningLan: false, saved: { lan: false }, override: null, restartNeeded: false,
      next: { host: '127.0.0.1', lan: false, source: 'default' }, file: path.join(dataDir, 'web-bind.json'),
    });
  });

  it('says a restart is needed once the saved choice differs from the running bind', async () => {
    process.env.UNFIREHOSE_BOUND_HOST = '127.0.0.1';
    const res = await post({ lan: true, understood: true });
    expect(res.status).toBe(200);
    const { bind } = await res.json();
    expect(bind).toMatchObject({ saved: { lan: true }, next: { host: '0.0.0.0', source: 'settings' }, restartNeeded: true });
    expect(fs.statSync(path.join(dataDir, 'web-bind.json')).mode & 0o777).toBe(0o600);
  });

  it('does not know the running bind when started without our launcher', async () => {
    const { bind } = await (await GET(new Request('http://localhost:3000/api/lan'))).json();
    expect(bind.running).toBeNull();
    expect(bind.runningLan).toBeNull();
    expect(bind.restartNeeded).toBe(false);
  });
});

describe('POST /api/lan', () => {
  it('opens to the network only with understood: true', async () => {
    const res = await post({ lan: true });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toContain('no login');
    expect(fs.existsSync(path.join(dataDir, 'web-bind.json'))).toBe(false);
  });

  it('keeps to this machine with lan: false', async () => {
    await post({ lan: true, understood: true });
    const { bind } = await (await post({ lan: false })).json();
    expect(bind.saved.lan).toBe(false);
    expect(bind.next.host).toBe('127.0.0.1');
  });

  it('refuses a cross-site request, whichever header says so', async () => {
    expect((await post({ lan: true, understood: true }, { 'sec-fetch-site': 'cross-site' })).status).toBe(403);
    expect((await post({ lan: true, understood: true }, { 'sec-fetch-site': 'same-site' })).status).toBe(403);
    const oldBrowser = await POST(new Request('http://localhost:3000/api/lan', {
      method: 'POST', body: JSON.stringify({ lan: true, understood: true }), headers: { origin: 'http://evil.example', host: 'localhost:3000' },
    }));
    expect(oldBrowser.status).toBe(403);
    expect(fs.existsSync(path.join(dataDir, 'web-bind.json'))).toBe(false);
  });

  it('accepts curl on this machine: no Origin, no Sec-Fetch-Site', async () => {
    const res = await POST(new Request('http://localhost:3000/api/lan', { method: 'POST', body: '{"lan":false}' }));
    expect(res.status).toBe(200);
  });

  it('rejects a body that is not a choice', async () => {
    expect((await post('nope')).status).toBe(400);
    expect((await post({ lan: 'yes' })).status).toBe(400);
  });

  it('leaves the choice to UNFIREHOSE_HOST when it is set', async () => {
    process.env.UNFIREHOSE_HOST = '127.0.0.1';
    const res = await post({ lan: true, understood: true });
    expect(res.status).toBe(409);
    expect((await res.json()).error).toContain('UNFIREHOSE_HOST=127.0.0.1');
  });

  it('in a container, points at the port mapping instead', async () => {
    process.env.UNFIREHOSE_CONTAINER = '1';
    const res = await post({ lan: true, understood: true });
    expect(res.status).toBe(409);
    expect((await res.json()).error).toContain('ports:');
  });
});

describe('lan helpers', () => {
  it('knows the private and CGNAT ranges', () => {
    expect(['10.1.2.3', '172.16.0.1', '172.31.255.1', '192.168.0.1'].every(isPrivateV4)).toBe(true);
    expect(['172.15.0.1', '172.32.0.1', '192.169.0.1', '8.8.8.8'].some(isPrivateV4)).toBe(false);
    expect(isCgnatV4('100.64.0.1')).toBe(true);
    expect(isCgnatV4('100.128.0.1')).toBe(false);
  });

  it('accepts the numeric family older Node reported', () => {
    const { addresses } = lanAddresses({ eth0: [{ ...v4('192.168.5.5'), family: 4 as unknown as 'IPv4' }] });
    expect(addresses.map((a) => a.address)).toEqual(['192.168.5.5']);
  });

  it('reads the port the browser used, or the scheme default', () => {
    expect(portOf('http://localhost:3010/api/lan')).toBe(3010);
    expect(portOf('http://box.local/api/lan')).toBe(80);
    expect(portOf('https://box.local/api/lan')).toBe(443);
  });
});

describe('listensOn', () => {
  // The real probe, against a socket we open ourselves on loopback.
  const server = net.createServer((s) => s.end());
  const ready = new Promise<number>((resolve) => server.listen(0, '127.0.0.1', () => resolve((server.address() as net.AddressInfo).port)));
  afterAll(() => new Promise<void>((r) => server.close(() => r())));

  it('is true where something accepts, false where nothing listens', async () => {
    const { listensOn } = await vi.importActual<typeof import('@/lib/lan')>('@/lib/lan');
    const port = await ready;
    expect(await listensOn('127.0.0.1', port)).toBe(true);
    const closed = net.createServer();
    const freePort = await new Promise<number>((r) => closed.listen(0, '127.0.0.1', () => r((closed.address() as net.AddressInfo).port)));
    await new Promise<void>((r) => closed.close(() => r()));
    expect(await listensOn('127.0.0.1', freePort)).toBe(false);
  });
});
