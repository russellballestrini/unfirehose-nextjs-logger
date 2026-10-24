import { NextResponse } from 'next/server';
import os from 'os';
import fs from 'fs';
import { lanAddresses, listensOn, portOf } from '@/lib/lan';
import { isLoopback, resolveBind, runningHost, saveChoice } from '@/lib/bind-host.mjs';

/**
 * GET /api/lan — this machine's LAN addresses, for Settings → Phone.
 *
 * Each IPv4 address a phone on our network could open, with the dashboard
 * URL at the port this request came in on, and whether our server accepts
 * connections there (a local probe). Nothing leaves the machine.
 *
 * `bind` says which address this server was started on, what Settings →
 * Phone saved, and what the next start would pick (src/lib/bind-host.mjs):
 * the bind is fixed at start, so a changed choice needs a restart.
 *
 * POST /api/lan — save that choice: `{ lan: true, understood: true }` opens
 * our dashboard to the network on the next start, `{ lan: false }` keeps it
 * to this machine.
 */

export const dynamic = 'force-dynamic';

/** Inside a container the addresses we see are the container's, and the port mapping decides. */
function inContainer(): boolean {
  if (process.env.UNFIREHOSE_CONTAINER === '1') return true;
  try { return fs.existsSync('/.dockerenv'); } catch { return false; }
}

function bindState() {
  const next = resolveBind();
  const running = runningHost();
  return {
    running,
    runningLan: running == null ? null : !isLoopback(running),
    saved: next.saved,
    next: { host: next.host, lan: next.lan, source: next.source },
    override: next.override,
    file: next.file,
    restartNeeded: running != null && running !== next.host,
    container: inContainer(),
  };
}

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
    bind: bindState(),
    checkedAt: new Date().toISOString(),
  });
}

/**
 * A page on some other site can POST to localhost from a browser here.
 * Opening the dashboard to the network is not something it may do, so
 * only our own pages may: a browser marks a cross-site request with
 * Sec-Fetch-Site, and an older one still sends Origin.
 */
function sameOrigin(request: Request): boolean {
  const site = request.headers.get('sec-fetch-site');
  if (site) return site === 'same-origin' || site === 'none';
  const origin = request.headers.get('origin');
  if (!origin) return true; // curl and scripts on this machine
  const host = request.headers.get('host');
  try { return new URL(origin).host === (host ?? new URL(request.url).host); } catch { return false; }
}

export async function POST(request: Request) {
  if (!sameOrigin(request)) {
    return NextResponse.json({ error: 'cross-site request refused' }, { status: 403 });
  }
  let body: { lan?: unknown; understood?: unknown };
  try { body = await request.json(); } catch { return NextResponse.json({ error: 'body must be JSON' }, { status: 400 }); }
  if (typeof body?.lan !== 'boolean') {
    return NextResponse.json({ error: '`lan` must be true or false' }, { status: 400 });
  }
  if (body.lan && body.understood !== true) {
    return NextResponse.json({
      error: 'opening to the network needs `understood: true`: anyone on it can read every session, push commits and type into tmux, and there is no login',
    }, { status: 400 });
  }
  const before = bindState();
  if (before.container) {
    return NextResponse.json({ error: 'in a container the port mapping decides (docker-compose.yml `ports:`), not this setting' }, { status: 409 });
  }
  if (before.override != null) {
    return NextResponse.json({ error: `UNFIREHOSE_HOST=${before.override} decides; unset it to choose here` }, { status: 409 });
  }
  try {
    saveChoice(body.lan);
  } catch (e) {
    return NextResponse.json({ error: `could not save ${before.file}: ${(e as Error).message}` }, { status: 500 });
  }
  return NextResponse.json({ ok: true, bind: bindState() });
}
