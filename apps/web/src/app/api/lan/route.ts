import { NextResponse } from 'next/server';
import os from 'os';
import { lanAddresses, listensOn, portOf } from '@/lib/lan';

/**
 * GET /api/lan — this machine's LAN addresses, for Settings → Phone.
 *
 * Each IPv4 address a phone on our network could open, with the dashboard
 * URL at the port this request came in on, and whether our server accepts
 * connections there (a local probe: `next dev` and `next start` bind
 * 0.0.0.0 unless started with `-H 127.0.0.1`). Nothing leaves the machine.
 */

export const dynamic = 'force-dynamic';

export async function GET(request: Request) {
  const port = portOf(request.url);
  const protocol = new URL(request.url).protocol.replace(':', '');
  const { addresses, skipped } = lanAddresses(os.networkInterfaces());
  const probed = await Promise.all(addresses.map(async (a) => ({
    ...a,
    url: `${protocol}://${a.address}:${port}/`,
    listening: await listensOn(a.address, port),
  })));
  return NextResponse.json({
    hostname: os.hostname(),
    port,
    addresses: probed,
    skipped,
    checkedAt: new Date().toISOString(),
  });
}
