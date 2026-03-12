import { readFile } from 'fs/promises';
import { homedir } from 'os';
import { join } from 'path';
import { NextResponse } from 'next/server';
import { getDb } from '@unturf/unfirehose/db/schema';

/* eslint-disable @typescript-eslint/no-explicit-any */

// Map rateLimitTier → monthly plan cost in USD
const PLAN_COST: Record<string, number> = {
  'default_claude_max_5x':  100,
  'default_claude_max_20x': 200,
  'default_claude_pro':      20,
};

// Anthropic API pricing per million tokens (same as /api/tokens)
const PRICING: Record<string, { input: number; output: number; cacheRead: number; cacheWrite: number }> = {
  'claude-opus-4-6':            { input: 5,  output: 25, cacheRead: 0.50, cacheWrite: 6.25 },
  'claude-opus-4-5-20251101':   { input: 5,  output: 25, cacheRead: 0.50, cacheWrite: 6.25 },
  'claude-sonnet-4-5-20250929': { input: 3,  output: 15, cacheRead: 0.30, cacheWrite: 3.75 },
  'claude-sonnet-4-6':          { input: 3,  output: 15, cacheRead: 0.30, cacheWrite: 3.75 },
  'claude-haiku-4-5-20251001':  { input: 1,  output:  5, cacheRead: 0.10, cacheWrite: 1.25 },
};

function calcCost(model: string, input: number, output: number, cacheRead: number, cacheWrite: number): number {
  const p = PRICING[model];
  if (!p) return 0;
  return (
    (input     / 1_000_000) * p.input +
    (output    / 1_000_000) * p.output +
    (cacheRead / 1_000_000) * p.cacheRead +
    (cacheWrite/ 1_000_000) * p.cacheWrite
  );
}

export async function GET() {
  const home = homedir();

  // Read credentials
  let subscriptionType = 'unknown';
  let rateLimitTier = 'unknown';
  let hasExtraUsageEnabled = false;

  try {
    const creds = JSON.parse(
      await readFile(join(home, '.claude', '.credentials.json'), 'utf-8')
    );
    subscriptionType = creds?.claudeAiOauth?.subscriptionType ?? 'unknown';
    rateLimitTier    = creds?.claudeAiOauth?.rateLimitTier    ?? 'unknown';
  } catch { /* file unreadable or missing */ }

  try {
    const cfg = JSON.parse(
      await readFile(join(home, '.claude.json'), 'utf-8')
    );
    hasExtraUsageEnabled = cfg?.oauthAccount?.hasExtraUsageEnabled ?? false;
  } catch { /* file unreadable or missing */ }

  const monthlyPlanCost = PLAN_COST[rateLimitTier] ?? null;

  // Billing period: calendar month, resets on the 1st
  const now = new Date();
  const periodStart = new Date(now.getFullYear(), now.getMonth(), 1);
  const periodEnd   = new Date(now.getFullYear(), now.getMonth() + 1, 1);
  const periodStartStr = periodStart.toISOString().slice(0, 10);
  const periodEndStr   = periodEnd.toISOString().slice(0, 10);

  // Compute equivalent API cost for current billing period from DB
  const db = getDb();
  const rows = db.prepare(`
    SELECT m.model,
           SUM(m.input_tokens)          as input_tokens,
           SUM(m.output_tokens)         as output_tokens,
           SUM(m.cache_read_tokens)     as cache_read_tokens,
           SUM(m.cache_creation_tokens) as cache_creation_tokens
    FROM messages m
    WHERE m.model IS NOT NULL
      AND m.model != '<synthetic>'
      AND m.timestamp >= ?
      AND m.timestamp <  ?
    GROUP BY m.model
  `).all(periodStartStr, periodEndStr) as any[];

  let periodCostUSD = 0;
  let periodInputTokens = 0;
  let periodOutputTokens = 0;
  let periodCacheReadTokens = 0;
  let periodCacheWriteTokens = 0;

  for (const r of rows) {
    periodCostUSD += calcCost(r.model, r.input_tokens, r.output_tokens, r.cache_read_tokens, r.cache_creation_tokens);
    periodInputTokens     += r.input_tokens;
    periodOutputTokens    += r.output_tokens;
    periodCacheReadTokens += r.cache_read_tokens;
    periodCacheWriteTokens+= r.cache_creation_tokens;
  }

  // Daily breakdown for the current billing period
  const dailyRows = db.prepare(`
    SELECT date(m.timestamp) as day,
           m.model,
           SUM(m.input_tokens)          as input_tokens,
           SUM(m.output_tokens)         as output_tokens,
           SUM(m.cache_read_tokens)     as cache_read_tokens,
           SUM(m.cache_creation_tokens) as cache_creation_tokens
    FROM messages m
    WHERE m.model IS NOT NULL
      AND m.model != '<synthetic>'
      AND m.timestamp >= ?
      AND m.timestamp <  ?
    GROUP BY day, m.model
    ORDER BY day
  `).all(periodStartStr, periodEndStr) as any[];

  // Collapse to daily cost totals
  const byDay: Record<string, number> = {};
  for (const r of dailyRows) {
    const cost = calcCost(r.model, r.input_tokens, r.output_tokens, r.cache_read_tokens, r.cache_creation_tokens);
    byDay[r.day] = (byDay[r.day] ?? 0) + cost;
  }
  const dailyCost = Object.entries(byDay)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([date, cost]) => ({ date, costUSD: cost }));

  return NextResponse.json({
    // Plan identity (auto-read from ~/.claude.json + ~/.claude/.credentials.json)
    subscriptionType,
    rateLimitTier,
    hasExtraUsageEnabled,
    monthlyPlanCost,

    // Billing period
    periodStart: periodStartStr,
    periodEnd:   periodEndStr,

    // Computed equivalent API cost this period
    periodCostUSD,
    periodInputTokens,
    periodOutputTokens,
    periodCacheReadTokens,
    periodCacheWriteTokens,

    // Daily breakdown
    dailyCost,

    // Note: actual charged overage lives at claude.ai/settings/usage
    // This is equivalent API-rate cost, not exact Anthropic billing
  });
}
