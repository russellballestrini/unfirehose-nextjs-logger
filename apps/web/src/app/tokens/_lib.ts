/**
 * Pure helpers for the tokens page: colours, short names, money, the plan
 * label and the extra-usage figures. No React here, so any tab can use them.
 */

export const HARNESS_COLORS: Record<string, string> = {
  'claude-code': '#a78bfa',
  'fetch': '#60a5fa',
  'uncloseai': '#fbbf24',
  'hermes': '#10b981',
  'agnt': '#f472b6',
  'unknown': '#6b7280',
};

export function getHarnessColor(harness: string): string {
  return HARNESS_COLORS[harness] ?? '#6b7280';
}

export const TOOL_COLORS = [
  '#10b981', '#a78bfa', '#60a5fa', '#fbbf24', '#f472b6',
  '#34d399', '#818cf8', '#38bdf8', '#fb923c', '#e879f9',
  '#2dd4bf', '#f87171', '#84cc16', '#22d3ee', '#facc15',
];

export function shortModel(model: string): string {
  return model.replace('claude-', '').replace(/-\d{8}$/, '');
}

/**
 * Local to this page because it abbreviates thousands, which the shared one
 * does not — a lifetime figure here runs to five digits and would push its
 * card out of the row.
 */
export function formatCost(usd: number | null | undefined): string {
  if (usd == null || !Number.isFinite(usd)) return '$0.00';
  if (usd >= 1000) return `$${(usd / 1000).toFixed(1)}K`;
  return `$${usd.toFixed(2)}`;
}

export const tokensTabs = ['overview', 'harness', 'tools', 'plan'] as const;
export type TokensTab = (typeof tokensTabs)[number];

/**
 * The plan name, from whatever the API called the tier.
 *
 * Takes an optional string because the field is absent on a payload from a
 * dashboard that has never seen a rate-limit header, and a page that says
 * "Unknown" is better than one that goes blank.
 */
export function planLabel(rateLimitTier?: string | null): string {
  if (!rateLimitTier) return 'Unknown';
  if (rateLimitTier.includes('max_20x')) return 'Max 20x';
  if (rateLimitTier.includes('max_5x'))  return 'Max 5x';
  if (rateLimitTier.includes('pro'))     return 'Pro';
  return rateLimitTier;
}

/** Extra usage (actual card charges), as both the overview and plan tabs read it. */
export interface ExtraUsage {
  extraExpired: boolean;
  extraSpent: number | null;
  extraLimit: number | null;
  extraBalance: number | null;
  extraReset: string | null;
  extraPct: number | null;
}

/**
 * Extra usage (actual card charges) — shared so overview + plan tabs can both use it.
 *
 * A snapshot whose billing period has ended (the API marks it `expired`)
 * says nothing about what we owe now, so it reads as "no data". The plan
 * tab keeps the last-synced timestamp to explain the gap; nothing else
 * shows a stale dollar figure as if it were live.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function deriveExtraUsage(extraData: any): ExtraUsage {
  const extraExpired: boolean = extraData?.expired === true;
  const extraLive    = extraData && !extraExpired ? extraData : null;
  const extraSpent   = extraLive?.extraSpent   ? parseFloat(extraLive.extraSpent)   : null;
  const extraLimit   = extraLive?.extraLimit   ? parseFloat(extraLive.extraLimit)   : null;
  const extraBalance = extraLive?.extraBalance ? parseFloat(extraLive.extraBalance) : null;
  const extraReset   = extraLive?.extraResetDate ?? null;
  const extraPct     = (extraSpent !== null && extraLimit !== null && extraLimit > 0)
    ? Math.min(100, (extraSpent / extraLimit) * 100) : null;
  return { extraExpired, extraSpent, extraLimit, extraBalance, extraReset, extraPct };
}
