import { readFile } from 'fs/promises';
import { homedir } from 'os';
import { join } from 'path';
import { NextResponse } from 'next/server';
import { getDb } from '@unturf/unfirehose/db/schema';
import { costForUsage } from '@unturf/unfirehose/pricing';
import { ensurePricingHydrated } from '@unturf/unfirehose/pricing-sync';

/* eslint-disable @typescript-eslint/no-explicit-any */

// Map rateLimitTier → monthly plan cost in USD
const PLAN_COST: Record<string, number> = {
  'default_claude_max_5x':  100,
  'default_claude_max_20x': 200,
  'default_claude_pro':      20,
};

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
  // Cost math reads an in-memory price catalog; make sure it reflects what
  // the worker last synced from our oracles.
  ensurePricingHydrated(db);
  // Per (day, model): each day books at the price in force that day.
  // substr beats date() on an ISO string by ~3x per row (see dashboard).
  const rows = db.prepare(`
    SELECT substr(m.timestamp, 1, 10) as day,
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
  `).all(periodStartStr, periodEndStr) as any[];

  let periodCostUSD = 0;
  let periodInputTokens = 0;
  let periodOutputTokens = 0;
  let periodCacheReadTokens = 0;
  let periodCacheWriteTokens = 0;

  for (const r of rows) {
    periodCostUSD += costForUsage({ model: r.model, input: r.input_tokens, output: r.output_tokens, cacheRead: r.cache_read_tokens, cacheWrite: r.cache_creation_tokens, at: r.day }).total;
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
    const cost = costForUsage({ model: r.model, input: r.input_tokens, output: r.output_tokens, cacheRead: r.cache_read_tokens, cacheWrite: r.cache_creation_tokens, at: r.day }).total;
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
