import { NextRequest, NextResponse } from 'next/server';

const MULTI_TENANT = process.env.MULTI_TENANT === 'true';
const AUTH_SECRET = process.env.AUTH_SECRET ?? '';

// Public API routes that handle their own auth or need no auth
const PUBLIC_API_PREFIXES = ['/api/webhooks/', '/api/ingest', '/api/health', '/api/auth/'];

// Public web routes
const PUBLIC_WEB_PATHS = ['/', '/login'];

// --- Edge-compatible JWT helpers (Web Crypto API) ---

function base64url(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf);
  let str = '';
  for (const b of bytes) str += String.fromCharCode(b);
  return btoa(str).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function base64urlEncode(str: string): string {
  return btoa(str).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function base64urlDecode(str: string): string {
  const padded = str.replace(/-/g, '+').replace(/_/g, '/');
  return atob(padded);
}

function base64urlToUint8Array(str: string): Uint8Array {
  const raw = base64urlDecode(str);
  const arr = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) arr[i] = raw.charCodeAt(i);
  return arr;
}

let _cryptoKey: CryptoKey | null = null;
async function getCryptoKey(): Promise<CryptoKey> {
  if (_cryptoKey) return _cryptoKey;
  const enc = new TextEncoder();
  _cryptoKey = await crypto.subtle.importKey(
    'raw', enc.encode(AUTH_SECRET), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify'],
  );
  return _cryptoKey;
}

// eslint-disable-next-line @typescript-eslint/no-unused-vars
async function signJwt(payload: Record<string, unknown>): Promise<string> {
  const header = base64urlEncode(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const body = base64urlEncode(JSON.stringify(payload));
  const key = await getCryptoKey();
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(`${header}.${body}`));
  return `${header}.${body}.${base64url(sig)}`;
}

async function verifyJwt(token: string): Promise<Record<string, unknown> | null> {
  const parts = token.split('.');
  if (parts.length !== 3) return null;

  const [header, body, sig] = parts;
  const key = await getCryptoKey();

  // Verify HMAC signature
  try {
    const sigBytes = base64urlToUint8Array(sig);
    const valid = await crypto.subtle.verify(
      // @ts-expect-error Uint8Array<ArrayBufferLike> vs BufferSource — Node vs browser type mismatch
      'HMAC', key, sigBytes, new TextEncoder().encode(`${header}.${body}`),
    );
    if (!valid) return null;
  } catch {
    return null;
  }

  try {
    const payload = JSON.parse(base64urlDecode(body));

    // Check expiry
    if (payload.exp && Date.now() / 1000 > payload.exp) return null;

    return payload;
  } catch {
    return null;
  }
}

function isPublicApiRoute(pathname: string): boolean {
  return PUBLIC_API_PREFIXES.some(prefix => pathname.startsWith(prefix));
}

function isPublicWebPath(pathname: string): boolean {
  return PUBLIC_WEB_PATHS.includes(pathname);
}

export async function middleware(request: NextRequest) {
  // Local mode: pass through everything
  if (!MULTI_TENANT) {
    return NextResponse.next();
  }

  const { pathname } = request.nextUrl;

  // API routes
  if (pathname.startsWith('/api/')) {
    // Public API routes handle their own auth
    if (isPublicApiRoute(pathname)) {
      return NextResponse.next();
    }

    // Validate Bearer token
    const authHeader = request.headers.get('authorization');
    if (!authHeader?.startsWith('Bearer ')) {
      return NextResponse.json(
        { error: 'Missing or invalid Authorization header' },
        { status: 401 },
      );
    }

    const token = authHeader.slice(7);
    if (!token.startsWith('unfh_')) {
      return NextResponse.json(
        { error: 'Invalid API key format' },
        { status: 401 },
      );
    }

    // Middleware just confirms the key format and passes it.
    // Actual validation happens in the API route (needs better-sqlite3).
    const requestHeaders = new Headers(request.headers);
    requestHeaders.set('X-Api-Key', token);

    return NextResponse.next({
      request: { headers: requestHeaders },
    });
  }

  // Web routes
  if (isPublicWebPath(pathname)) {
    return NextResponse.next();
  }

  // Check session cookie
  if (!AUTH_SECRET) {
    return NextResponse.json({ error: 'AUTH_SECRET not configured' }, { status: 500 });
  }
  const sessionCookie = request.cookies.get('unfh_session')?.value;
  if (!sessionCookie) {
    const loginUrl = new URL('/login', request.url);
    loginUrl.searchParams.set('redirect', pathname);
    return NextResponse.redirect(loginUrl);
  }

  // Verify JWT session
  const payload = await verifyJwt(sessionCookie);
  if (!payload || !payload.accountId) {
    const loginUrl = new URL('/login', request.url);
    loginUrl.searchParams.set('redirect', pathname);
    const response = NextResponse.redirect(loginUrl);
    response.cookies.delete('unfh_session');
    return response;
  }

  // Inject account ID for downstream routes
  const requestHeaders = new Headers(request.headers);
  requestHeaders.set('X-Account-Id', payload.accountId as string);

  return NextResponse.next({
    request: { headers: requestHeaders },
  });
}

export const config = {
  matcher: ['/api/:path*', '/((?!_next/static|_next/image|favicon.ico).*)'],
};
