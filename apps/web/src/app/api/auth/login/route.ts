import { NextRequest, NextResponse } from 'next/server';
import { createHmac } from 'crypto';
import { validateApiKey } from '@unfirehose/core/db/api-keys';

const AUTH_SECRET = process.env.AUTH_SECRET ?? '';
const THIRTY_DAYS = 30 * 24 * 60 * 60;

function ensureSecret() {
  if (!AUTH_SECRET) {
    throw new Error('AUTH_SECRET env var is required in multi-tenant mode');
  }
}

function base64url(str: string): string {
  return Buffer.from(str).toString('base64url');
}

function signJwt(payload: Record<string, unknown>): string {
  const header = base64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const body = base64url(JSON.stringify(payload));
  const sig = createHmac('sha256', AUTH_SECRET)
    .update(`${header}.${body}`)
    .digest('base64url');
  return `${header}.${body}.${sig}`;
}

export async function POST(request: NextRequest) {
  if (process.env.MULTI_TENANT !== 'true') {
    return NextResponse.json({ error: 'Not in cloud mode' }, { status: 404 });
  }

  let body: { key?: string };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 });
  }

  ensureSecret();

  const { key } = body;
  if (!key || typeof key !== 'string') {
    return NextResponse.json({ error: 'Missing key' }, { status: 400 });
  }

  if (!key.startsWith('unfh_')) {
    return NextResponse.json({ error: 'Invalid key format' }, { status: 400 });
  }

  const result = validateApiKey(key);
  if (!result) {
    return NextResponse.json({ error: 'Invalid or revoked API key' }, { status: 401 });
  }

  const now = Math.floor(Date.now() / 1000);
  const token = signJwt({
    accountId: result.accountId,
    tier: result.tier,
    keyId: result.keyId,
    iat: now,
    exp: now + THIRTY_DAYS,
  });

  const response = NextResponse.json({
    ok: true,
    accountId: result.accountId,
  });

  response.cookies.set('unfh_session', token, {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    path: '/',
    maxAge: THIRTY_DAYS,
  });

  return response;
}
