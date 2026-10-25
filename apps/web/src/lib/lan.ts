import type { NetworkInterfaceInfo } from 'os';
import net from 'net';

/**
 * Which of this machine's addresses a phone on our network could open.
 *
 * Read from `os.networkInterfaces()`: IPv4 only (a QR for a phone wants the
 * address a person would type), never loopback or link-local, and not the
 * bridges a container runtime or a hypervisor makes for itself, which no
 * phone can reach. A private range reads `lan`; a tailnet's CGNAT range or a
 * tunnel interface reads `vpn`, still useful to a phone on that VPN; any
 * other address reads `public`.
 */

export type LanKind = 'lan' | 'vpn' | 'public';

export interface LanAddress {
  address: string;
  iface: string;
  kind: LanKind;
}

export interface SkippedAddress {
  address: string;
  iface: string;
  reason: 'loopback' | 'link-local' | 'virtual bridge' | 'ipv6';
}

/** Interfaces a container runtime, VM host or CNI makes for its own guests. */
const VIRTUAL_IFACE = /^(docker\d*|br-[0-9a-f]{6,}|veth|virbr|vnet|lxcbr|lxdbr|cni|flannel|cali|weave|kube-|podman|vboxnet|vmnet|tap)/i;
/** Tunnels: a phone reaches these only from the same VPN. */
const TUNNEL_IFACE = /^(tailscale|wg|tun|utun|zt|nebula|ham)/i;

function octets(ip: string): number[] {
  return ip.split('.').map(Number);
}

export function isPrivateV4(ip: string): boolean {
  const [a, b] = octets(ip);
  return a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168);
}

/** 100.64.0.0/10, where Tailscale and carrier NAT hand out addresses. */
export function isCgnatV4(ip: string): boolean {
  const [a, b] = octets(ip);
  return a === 100 && b >= 64 && b <= 127;
}

function isIPv4(info: NetworkInterfaceInfo): boolean {
  // Node 18.0–18.3 reported family as the number 4.
  return info.family === 'IPv4' || (info.family as unknown) === 4;
}

export function lanAddresses(
  ifaces: NodeJS.Dict<NetworkInterfaceInfo[]>,
): { addresses: LanAddress[]; skipped: SkippedAddress[] } {
  const addresses: LanAddress[] = [];
  const skipped: SkippedAddress[] = [];
  for (const [iface, infos] of Object.entries(ifaces)) {
    for (const info of infos ?? []) {
      const address = info.address;
      if (!isIPv4(info)) {
        if (!info.internal) skipped.push({ address, iface, reason: 'ipv6' });
        continue;
      }
      if (info.internal || address.startsWith('127.')) { skipped.push({ address, iface, reason: 'loopback' }); continue; }
      if (address.startsWith('169.254.')) { skipped.push({ address, iface, reason: 'link-local' }); continue; }
      if (VIRTUAL_IFACE.test(iface)) { skipped.push({ address, iface, reason: 'virtual bridge' }); continue; }
      const kind: LanKind = TUNNEL_IFACE.test(iface) || isCgnatV4(address)
        ? 'vpn'
        : isPrivateV4(address) ? 'lan' : 'public';
      addresses.push({ address, iface, kind });
    }
  }
  const rank: Record<LanKind, number> = { lan: 0, vpn: 1, public: 2 };
  addresses.sort((a, b) => rank[a.kind] - rank[b.kind] || a.iface.localeCompare(b.iface));
  return { addresses, skipped };
}

/**
 * Whether something accepts TCP on `address:port`, asked from this machine.
 *
 * A server bound to 127.0.0.1 refuses this; one bound to 0.0.0.0 (or to this
 * address) accepts. It is a connection to our own address, so it never
 * leaves this machine, and it cannot see a firewall in front of a phone:
 * `true` means our server listens there, not that every device on the
 * network is let through.
 */
export function listensOn(address: string, port: number, timeoutMs = 400): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.connect({ host: address, port });
    const done = (ok: boolean) => { socket.destroy(); resolve(ok); };
    socket.setTimeout(timeoutMs, () => done(false));
    socket.once('connect', () => done(true));
    socket.once('error', () => done(false));
  });
}

/** Our server's port as the browser reached it. */
export function portOf(requestUrl: string): number {
  const u = new URL(requestUrl);
  if (u.port) return Number(u.port);
  return u.protocol === 'https:' ? 443 : 80;
}
