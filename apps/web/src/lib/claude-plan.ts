import { readFile } from 'fs/promises';
import { homedir } from 'os';
import { join } from 'path';

/**
 * Which Claude subscription this machine is signed in with, and what it
 * costs a month. Reads two fields — the subscription type and the rate-limit
 * tier — and nothing else from the credentials file; no token is read into
 * anything that leaves this function.
 */

// Monthly plan price in USD, by rateLimitTier.
export const PLAN_COST: Record<string, number> = {
  'default_claude_max_5x':  100,
  'default_claude_max_20x': 200,
  'default_claude_pro':      20,
};

const PLAN_NAME: Record<string, string> = {
  'default_claude_max_5x':  'Claude Max 5x',
  'default_claude_max_20x': 'Claude Max 20x',
  'default_claude_pro':     'Claude Pro',
};

export interface ClaudePlanIdentity {
  subscriptionType: string;
  rateLimitTier: string;
  hasExtraUsageEnabled: boolean;
}

export async function readClaudePlanIdentity(home = homedir()): Promise<ClaudePlanIdentity> {
  let subscriptionType = 'unknown';
  let rateLimitTier = 'unknown';
  let hasExtraUsageEnabled = false;
  try {
    const creds = JSON.parse(await readFile(join(home, '.claude', '.credentials.json'), 'utf-8'));
    subscriptionType = creds?.claudeAiOauth?.subscriptionType ?? 'unknown';
    rateLimitTier    = creds?.claudeAiOauth?.rateLimitTier    ?? 'unknown';
  } catch { /* file unreadable or missing */ }
  try {
    const cfg = JSON.parse(await readFile(join(home, '.claude.json'), 'utf-8'));
    hasExtraUsageEnabled = cfg?.oauthAccount?.hasExtraUsageEnabled ?? false;
  } catch { /* file unreadable or missing */ }
  return { subscriptionType, rateLimitTier, hasExtraUsageEnabled };
}

/** The plan as a report line wants it, or null when no priced tier is detected. */
export function claudePlanForReport(id: ClaudePlanIdentity): { name: string; monthlyUSD: number } | null {
  const monthlyUSD = PLAN_COST[id.rateLimitTier];
  if (monthlyUSD === undefined) return null;
  return { name: PLAN_NAME[id.rateLimitTier] ?? id.rateLimitTier, monthlyUSD };
}
