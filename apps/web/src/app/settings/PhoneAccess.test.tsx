// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, cleanup, fireEvent, waitFor } from '@testing-library/react';
import { encodeQr, qrPath } from '@/lib/qr';
import type { BindState } from './PhoneAccess';

let answer: Record<string, unknown> | undefined;
const mutate = vi.fn();
vi.mock('swr', () => ({ default: () => ({ data: answer, error: undefined, mutate }) }));
const { PhoneAccess, subnetOf } = await import('./PhoneAccess');

const a = (address: string, over: Record<string, unknown> = {}) => ({
  address, iface: 'wlp3s0', kind: 'lan', url: `http://${address}:3000/`, listening: true, ...over,
});

const FILE = '/home/fox/.unfirehose/web-bind.json';
/** Started by our launcher on 0.0.0.0 after an opt-in. */
const openBind = (over: Partial<BindState> = {}): BindState => ({
  running: '0.0.0.0', runningLan: true, saved: { lan: true, setAt: '2026-10-24T00:00:00Z' },
  next: { host: '0.0.0.0', lan: true, source: 'settings' }, override: null, file: FILE,
  restartNeeded: false, container: false, ...over,
});
/** Our default: started on loopback, nothing saved. */
const localBind = (over: Partial<BindState> = {}): BindState => ({
  running: '127.0.0.1', runningLan: false, saved: { lan: false, setAt: null },
  next: { host: '127.0.0.1', lan: false, source: 'default' }, override: null, file: FILE,
  restartNeeded: false, container: false, ...over,
});

afterEach(() => { cleanup(); answer = undefined; vi.unstubAllGlobals(); });

describe('PhoneAccess, open to the network', () => {
  it('draws a QR for the first address our server answers on, and the URL beside it', () => {
    answer = {
      hostname: 'box', port: 3000, bind: openBind(),
      addresses: [a('10.0.0.5', { iface: 'eth0', listening: false }), a('192.168.1.20'), a('100.101.102.103', { iface: 'tailscale0', kind: 'vpn' })],
    };
    const { container } = render(<PhoneAccess />);
    const url = container.querySelector('[data-qr-url]')!;
    expect(url.textContent).toBe('http://192.168.1.20:3000/');
    expect(url.getAttribute('href')).toBe('http://192.168.1.20:3000/');
    const path = container.querySelector('svg[role="img"] path')!.getAttribute('d');
    expect(path).toBe(qrPath(encodeQr('http://192.168.1.20:3000/', { ecl: 'M' }), 4));
    expect(container.querySelector('[data-reach]')!.getAttribute('data-reach')).toBe('yes');
    expect(container.textContent).toContain('sudo ufw allow from 192.168.1.0/24 to any port 3000');
    // Only answering addresses are offered; the silent one is named, not offered.
    expect([...container.querySelectorAll('[data-address]')].map((e) => e.getAttribute('data-address'))).toEqual(['192.168.1.20', '100.101.102.103']);
    expect(container.querySelector('[data-not-answering]')!.textContent).toContain('10.0.0.5 (eth0)');
  });

  it('redraws for the address a person picks', () => {
    answer = { hostname: 'box', port: 3000, bind: openBind(), addresses: [a('192.168.1.20'), a('10.0.0.5', { iface: 'eth0' })] };
    const { container } = render(<PhoneAccess />);
    fireEvent.click(container.querySelector('[data-address="10.0.0.5"] input')!);
    expect(container.querySelector('[data-qr-url]')!.textContent).toBe('http://10.0.0.5:3000/');
  });

  it('warns beside the QR, in plain words, that there is no login', () => {
    answer = { hostname: 'box', port: 3000, bind: openBind(), addresses: [a('192.168.1.20')] };
    const { container } = render(<PhoneAccess />);
    const warn = container.querySelector('[data-trust-warning]')!.textContent!;
    expect(warn).toContain('no login');
    expect(warn).toContain('Anyone on the same network can read every session, push commits, and type into tmux');
  });

  it('offers the way back to this machine only, and saves it', async () => {
    const fetchMock = vi.fn(async () => new Response('{"ok":true}', { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    answer = { hostname: 'box', port: 3000, bind: openBind(), addresses: [a('192.168.1.20')] };
    const { container } = render(<PhoneAccess />);
    fireEvent.click(container.querySelector('[data-lan-off]')!);
    await waitFor(() => expect(mutate).toHaveBeenCalled());
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('/api/lan');
    expect(JSON.parse(String(init.body))).toEqual({ lan: false });
  });

  it('says a restart is needed once the saved choice differs from how it was started', () => {
    answer = {
      hostname: 'box', port: 3000, addresses: [a('192.168.1.20')],
      bind: openBind({ saved: { lan: false, setAt: 'x' }, next: { host: '127.0.0.1', lan: false, source: 'default' }, restartNeeded: true }),
    };
    const { container } = render(<PhoneAccess />);
    const note = container.querySelector('[data-restart-needed]')!.textContent!;
    expect(note).toContain('this machine only');
    expect(note).toContain('make dev');
    expect(note).toContain('make service-restart');
    expect(container.querySelector('[data-lan-off]')).toBeNull();
  });
});

describe('PhoneAccess, this machine only (our default)', () => {
  it('offers no QR while our server listens on loopback, and explains the opt-in', () => {
    answer = { hostname: 'box', port: 3000, bind: localBind(), addresses: [a('192.168.1.20', { listening: false })] };
    const { container } = render(<PhoneAccess />);
    expect(container.querySelector('svg')).toBeNull();
    expect(container.querySelector('[data-qr-url]')).toBeNull();
    expect(container.querySelector('[data-lan-optin]')!.textContent).toContain('listens on this machine only');
    expect(container.textContent).toContain('127.0.0.1:3000');
    expect(container.querySelector('[data-trust-warning]')!.textContent).toContain('push commits, and type into tmux');
  });

  it('offers no QR even when something answers, if our server was started on loopback', () => {
    answer = { hostname: 'box', port: 3000, bind: localBind(), addresses: [a('192.168.1.20', { listening: true })] };
    const { container } = render(<PhoneAccess />);
    expect(container.querySelector('svg')).toBeNull();
    expect(container.querySelector('[data-lan-optin]')).toBeTruthy();
  });

  it('opens only after "I understand", and then says how to restart', async () => {
    const fetchMock = vi.fn(async () => new Response('{"ok":true}', { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    answer = { hostname: 'box', port: 3000, bind: localBind(), addresses: [a('192.168.1.20', { listening: false })] };
    const { container } = render(<PhoneAccess />);
    const on = container.querySelector('[data-lan-on]') as HTMLButtonElement;
    expect(on.disabled).toBe(true);
    fireEvent.click(container.querySelector('[data-lan-understood]')!);
    expect(on.disabled).toBe(false);
    expect(container.textContent).toContain('make service-restart');
    fireEvent.click(on);
    await waitFor(() => expect(mutate).toHaveBeenCalled());
    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(JSON.parse(String(init.body))).toEqual({ lan: true, understood: true });
  });

  it('shows what the server refused', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{"error":"nope"}', { status: 409 })));
    answer = { hostname: 'box', port: 3000, bind: localBind(), addresses: [a('192.168.1.20', { listening: false })] };
    const { container } = render(<PhoneAccess />);
    fireEvent.click(container.querySelector('[data-lan-understood]')!);
    fireEvent.click(container.querySelector('[data-lan-on]')!);
    await waitFor(() => expect(container.querySelector('[data-lan-error]')!.textContent).toContain('nope'));
    expect(mutate).not.toHaveBeenCalled();
  });

  it('once saved, says a restart is needed and offers to undo', () => {
    answer = {
      hostname: 'box', port: 3000, addresses: [a('192.168.1.20', { listening: false })],
      bind: localBind({ saved: { lan: true, setAt: 'x' }, next: { host: '0.0.0.0', lan: true, source: 'settings' }, restartNeeded: true }),
    };
    const { container } = render(<PhoneAccess />);
    expect(container.querySelector('[data-restart-needed]')!.textContent).toContain('open to this network');
    expect(container.querySelector('[data-lan-off]')).toBeTruthy();
    expect(container.querySelector('[data-lan-on]')).toBeNull();
  });

  it('hands the choice to UNFIREHOSE_HOST when it is set', () => {
    answer = {
      hostname: 'box', port: 3000, addresses: [a('192.168.1.20', { listening: false })],
      bind: localBind({ override: '127.0.0.1', next: { host: '127.0.0.1', lan: false, source: 'env' } }),
    };
    const { container } = render(<PhoneAccess />);
    expect(container.querySelector('[data-lan-override]')!.textContent).toContain('UNFIREHOSE_HOST=127.0.0.1');
    expect(container.querySelector('[data-lan-on]')).toBeNull();
  });

  it('explains the opt-in when started some other way and nothing answers', () => {
    answer = { hostname: 'box', port: 3010, addresses: [a('192.168.1.20', { listening: false })] };
    const { container } = render(<PhoneAccess />);
    expect(container.querySelector('svg')).toBeNull();
    expect(container.textContent).toContain('no address here answers on port 3010');
  });
});

describe('PhoneAccess, elsewhere', () => {
  it('in a container, points at the port mapping and offers no QR', () => {
    answer = { hostname: 'abc123', port: 3000, bind: localBind({ container: true, running: '0.0.0.0', runningLan: true }), addresses: [a('172.20.0.3', { iface: 'eth0' })] };
    const { container } = render(<PhoneAccess />);
    expect(container.querySelector('[data-lan-container]')!.textContent).toContain('127.0.0.1:3000:3000');
    expect(container.querySelector('svg')).toBeNull();
  });

  it('teaches what to do on a machine with no network address', () => {
    answer = { hostname: 'box', port: 3000, bind: localBind(), addresses: [] };
    const { container } = render(<PhoneAccess />);
    expect(container.querySelector('[data-empty-kind="first-run"]')).toBeTruthy();
    expect(container.querySelector('svg')).toBeNull();
    expect(container.textContent).toContain('Join a network');
  });

  it('writes a /24 for a firewall rule', () => {
    expect(subnetOf('10.1.2.3')).toBe('10.1.2.0/24');
  });
});
