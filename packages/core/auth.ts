import { NextRequest } from 'next/server';
import { validateApiKey } from './db/api-keys';

export function isMultiTenant(): boolean {
  return process.env.MULTI_TENANT === 'true';
}

export async function authenticateRequest(request: NextRequest): Promise<{
  accountId: string;
  tier: number;
  scopes: string;
  keyId: string;
} | null> {
  const authHeader = request.headers.get('authorization');
  if (!authHeader?.startsWith('Bearer ')) return null;

  const token = authHeader.slice(7);
  if (!token) return null;

  const result = validateApiKey(token);
  if (!result) return null;

  return {
    accountId: result.accountId,
    tier: result.tier,
    scopes: result.scopes,
    keyId: result.keyId,
  };
}
