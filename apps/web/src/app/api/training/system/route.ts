import { NextRequest, NextResponse } from 'next/server';

const PROXY_PORT = 8088;
const PROXY_TIMEOUT = 5000;

export async function GET(request: NextRequest) {
  const url = new URL(request.url);
  const host = url.searchParams.get('host');

  if (!host) {
    return NextResponse.json({ error: 'host parameter required' }, { status: 400 });
  }

  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), PROXY_TIMEOUT);
    const res = await fetch(`http://${host}:${PROXY_PORT}/system`, { signal: ctrl.signal });
    clearTimeout(t);

    if (!res.ok) {
      return NextResponse.json({ error: `proxy returned ${res.status}` }, { status: 502 });
    }

    const data = await res.json();
    return NextResponse.json(data);
  } catch {
    return NextResponse.json({ error: 'proxy unreachable' }, { status: 502 });
  }
}
