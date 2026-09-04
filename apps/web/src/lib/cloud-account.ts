/**
 * Who is asking, in cloud mode.
 *
 * Five routes carried a verbatim copy of this, along with the same
 * "not in cloud mode" and "unauthorized" replies. Five copies of an
 * authorization check is five places to fix the day one of them is wrong,
 * and no way to tell from a diff that the other four exist.
 */

import { NextRequest, NextResponse } from 'next/server';
import { validateApiKey } from '@unturf/unfirehose/db/api-keys';

export const isCloudMode = () => process.env.MULTI_TENANT === 'true';

/**
 * Middleware sets `X-Account-Id` for session requests and `X-Api-Key` for
 * key requests; a key is validated here rather than trusted.
 */
export function getAccountId(request: NextRequest): string | null {
  const accountId = request.headers.get('X-Account-Id');
  if (accountId) return accountId;

  const apiKey = request.headers.get('X-Api-Key');
  return apiKey ? (validateApiKey(apiKey)?.accountId ?? null) : null;
}

export function getAccountTier(request: NextRequest): number {
  const apiKey = request.headers.get('X-Api-Key');
  return apiKey ? (validateApiKey(apiKey)?.tier ?? 0) : 0;
}

/**
 * The account behind a request, or the response to send instead.
 *
 * `offline` is what a route returns when there is no cloud: the account
 * routes 404, but /api/keys answers `{ mode: 'local', keys: [] }` so its
 * page can say so rather than render an SWR error.
 */
export function requireAccount(
  request: NextRequest,
  offline: NextResponse,
): { accountId: string } | { response: NextResponse } {
  if (!isCloudMode()) return { response: offline };

  const accountId = getAccountId(request);
  if (!accountId) {
    return { response: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }) };
  }
  return { accountId };
}

