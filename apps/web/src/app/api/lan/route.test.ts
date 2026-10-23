import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest';
import net from 'net';
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

const { GET } = await import('./route');
const { lanAddresses, portOf, isPrivateV4, isCgnatV4 } = await import('@/lib/lan');

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
