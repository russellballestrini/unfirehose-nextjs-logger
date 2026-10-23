// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, cleanup, fireEvent } from '@testing-library/react';
import { encodeQr, qrPath } from '@/lib/qr';

let answer: Record<string, unknown> | undefined;
vi.mock('swr', () => ({ default: () => ({ data: answer, error: undefined }) }));
const { PhoneAccess, subnetOf } = await import('./PhoneAccess');

const a = (address: string, over: Record<string, unknown> = {}) => ({
  address, iface: 'wlp3s0', kind: 'lan', url: `http://${address}:3000/`, listening: true, ...over,
});

afterEach(() => { cleanup(); answer = undefined; });

describe('PhoneAccess', () => {
  it('draws a QR for the first address our server answers on, and the URL beside it', () => {
    answer = {
      hostname: 'box', port: 3000,
      addresses: [a('10.0.0.5', { iface: 'eth0', listening: false }), a('192.168.1.20'), a('100.101.102.103', { iface: 'tailscale0', kind: 'vpn' })],
    };
    const { container } = render(<PhoneAccess />);
    const url = container.querySelector('[data-qr-url]')!;
    expect(url.textContent).toBe('http://192.168.1.20:3000/');
    expect(url.getAttribute('href')).toBe('http://192.168.1.20:3000/');
    // The drawn path is exactly our encoder's for that URL.
    const path = container.querySelector('svg[role="img"] path')!.getAttribute('d');
    expect(path).toBe(qrPath(encodeQr('http://192.168.1.20:3000/', { ecl: 'M' }), 4));
    expect(container.querySelector('svg')!.getAttribute('aria-label')).toBe('QR code for http://192.168.1.20:3000/');
    expect(container.querySelector('[data-reach]')!.getAttribute('data-reach')).toBe('yes');
    expect(container.textContent).toContain('sudo ufw allow from 192.168.1.0/24 to any port 3000');
    expect([...container.querySelectorAll('[data-listening]')].map((e) => e.getAttribute('data-listening'))).toEqual(['no', 'yes', 'yes']);
  });

  it('redraws for the address a person picks, and says when our server does not answer there', () => {
    answer = { hostname: 'box', port: 3000, addresses: [a('192.168.1.20'), a('10.0.0.5', { iface: 'eth0', listening: false })] };
    const { container } = render(<PhoneAccess />);
    fireEvent.click(container.querySelector('[data-address="10.0.0.5"] input')!);
    expect(container.querySelector('[data-qr-url]')!.textContent).toBe('http://10.0.0.5:3000/');
    const reach = container.querySelector('[data-reach]')!;
    expect(reach.getAttribute('data-reach')).toBe('no');
    expect(reach.textContent).toContain('does not answer on 10.0.0.5:3000');
    expect(reach.textContent).toContain('-H 0.0.0.0');
    expect(reach.textContent).not.toContain('nor on any other address');
  });

  it('says so when no address answers at all', () => {
    answer = { hostname: 'box', port: 3010, addresses: [a('192.168.1.20', { listening: false })] };
    const { container } = render(<PhoneAccess />);
    expect(container.querySelector('[data-reach]')!.textContent).toContain('nor on any other address here');
  });

  it('always warns that there is no login', () => {
    answer = { hostname: 'box', port: 3000, addresses: [a('192.168.1.20')] };
    const { container } = render(<PhoneAccess />);
    const warn = container.querySelector('[data-trust-warning]')!;
    expect(warn.textContent).toContain('no login');
    expect(warn.textContent).toContain('Trusted networks only');
  });

  it('teaches what to do on a machine with no network address', () => {
    answer = { hostname: 'box', port: 3000, addresses: [] };
    const { container } = render(<PhoneAccess />);
    expect(container.querySelector('[data-empty-kind="first-run"]')).toBeTruthy();
    expect(container.querySelector('svg')).toBeNull();
    expect(container.textContent).toContain('Join a network');
  });

  it('writes a /24 for a firewall rule', () => {
    expect(subnetOf('10.1.2.3')).toBe('10.1.2.0/24');
  });
});
