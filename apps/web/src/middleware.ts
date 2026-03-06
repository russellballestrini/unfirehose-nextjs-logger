import { NextRequest, NextResponse } from 'next/server';
import { createHmac, timingSafeEqual } from 'crypto';

const MULTI_TENANT = process.env.MULTI_TENANT === 'true';
const AUTH_SECRET = process.env.AUTH_SECRET ?? '';

// Public API routes that handle their own auth or need no auth
const PUBLIC_API_PREFIXES = ['/api/webhooks/', '/api/ingest', '/api/health', '/api/auth/'];

// Public web routes
const PUBLIC_WEB_PATHS = ['/', '/login'];

function base64url(str: string): string {
  return Buffer.from(str).toString('base64url');
}

function base64urlDecode(str: string): string {
  return Buffer.from(str, 'base64url').toString();
}

function signJwt(payload: Record<string, unknown>): string {
  const header = base64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const body = base64url(JSON.stringify(payload));
  const sig = createHmac('sha256', AUTH_SECRET)
    .update(`${header}.${body}`)
    .digest('base64url');
  return `${header}.${body}.${sig}`;
}

function verifyJwt(token: string): Record<string, unknown> | null {
  const parts = token.split('.');
  if (parts.length !== 3) return null;

  const [header, body, sig] = parts;
  const expected = createHmac('sha256', AUTH_SECRET)
    .update(`${header}.${body}`)
    .digest('base64url');

  // Timing-safe comparison
  try {
    const sigBuf = Buffer.from(sig, 'base64url');
    const expBuf = Buffer.from(expected, 'base64url');
    if (sigBuf.length !== expBuf.length) return null;
    if (!timingSafeEqual(sigBuf, expBuf)) return null;
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

export function middleware(request: NextRequest) {
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

    // We cannot call validateApiKey here (middleware runs on the edge/node
    // boundary and cannot use better-sqlite3 directly). Instead, we pass the
    // raw key forward in a header and let the API route validate it.
    // However, if we *do* have access to the db at middleware time (Node.js
    // runtime), we validate here and inject the account ID.
    //
    // For now, we use a lazy-import approach: the actual validation happens
    // in the API route. Middleware just confirms the key format and passes it.
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
  const sessionCookie = request.cookies.get('unfh_session')?.value;
  if (!sessionCookie) {
    const loginUrl = new URL('/login', request.url);
    loginUrl.searchParams.set('redirect', pathname);
    return NextResponse.redirect(loginUrl);
  }

  // Verify JWT session
  const payload = verifyJwt(sessionCookie);
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
