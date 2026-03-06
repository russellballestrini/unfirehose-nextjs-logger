import { NextRequest, NextResponse } from 'next/server';
import { createApiKey, listApiKeys, revokeApiKey } from '@unfirehose/core/db/api-keys';
import { validateApiKey } from '@unfirehose/core/db/api-keys';

function getAccountId(request: NextRequest): string | null {
  // In cloud mode, middleware sets X-Account-Id for session-based requests.
  // For API key requests, middleware sets X-Api-Key and we validate here.
  const accountId = request.headers.get('X-Account-Id');
  if (accountId) return accountId;

  // Fallback: validate API key directly
  const apiKey = request.headers.get('X-Api-Key');
  if (apiKey) {
    const result = validateApiKey(apiKey);
    if (result) return result.accountId;
  }

  return null;
}

function getAccountTier(request: NextRequest): number {
  const apiKey = request.headers.get('X-Api-Key');
  if (apiKey) {
    const result = validateApiKey(apiKey);
    if (result) return result.tier;
  }
  return 0;
}

export async function GET(request: NextRequest) {
  if (process.env.MULTI_TENANT !== 'true') {
    return NextResponse.json({ error: 'Not in cloud mode' }, { status: 404 });
  }

  const accountId = getAccountId(request);
  if (!accountId) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const keys = listApiKeys(accountId);
  return NextResponse.json({ keys });
}

export async function POST(request: NextRequest) {
  if (process.env.MULTI_TENANT !== 'true') {
    return NextResponse.json({ error: 'Not in cloud mode' }, { status: 404 });
  }

  const accountId = getAccountId(request);
  if (!accountId) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  let body: { label?: string; parentKeyId?: string; scopes?: string };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 });
  }

  // Sub-keys require team tier (>= 33)
  if (body.parentKeyId) {
    const tier = getAccountTier(request);
    if (tier < 33) {
      return NextResponse.json(
        { error: 'Sub-keys require team tier' },
        { status: 403 },
      );
    }
  }

  const result = createApiKey(accountId, {
    label: body.label,
    parentKeyId: body.parentKeyId,
    scopes: body.scopes,
  });

  return NextResponse.json({
    ok: true,
    id: result.id,
    key: result.key,
    keyPrefix: result.keyPrefix,
  });
}

export async function DELETE(request: NextRequest) {
  if (process.env.MULTI_TENANT !== 'true') {
    return NextResponse.json({ error: 'Not in cloud mode' }, { status: 404 });
  }

  const accountId = getAccountId(request);
  if (!accountId) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  let body: { keyId?: string };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 });
  }

  if (!body.keyId) {
    return NextResponse.json({ error: 'Missing keyId' }, { status: 400 });
  }

  // Verify the key belongs to this account before revoking
  const keys = listApiKeys(accountId);
  const keyToRevoke = keys.find(k => k.id === body.keyId);
  if (!keyToRevoke) {
    return NextResponse.json({ error: 'Key not found' }, { status: 404 });
  }

  revokeApiKey(body.keyId);
  return NextResponse.json({ ok: true });
}
