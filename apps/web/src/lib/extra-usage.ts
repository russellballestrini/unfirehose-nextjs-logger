/**
 * Extra-usage (card charge) snapshots come from a bookmarklet the human
 * clicks on claude.ai/settings/usage. Nothing refreshes them on its own, so a
 * snapshot pushed in March happily reads "$318 spent, resets Apr 1" in
 * September. This module decides whether a snapshot still describes our
 * current billing period.
 *
 * A snapshot is expired when either:
 *   - its reset date has passed (the period it measured is over), or
 *   - it is older than MAX_SNAPSHOT_AGE_DAYS, a backstop for reset strings we
 *     cannot parse. Billing periods are monthly; 35 days covers the longest.
 */

export const MAX_SNAPSHOT_AGE_DAYS = 35;

const MONTHS = ['jan','feb','mar','apr','may','jun','jul','aug','sep','oct','nov','dec'];

export interface ExtraUsageRaw {
  extraSpent: string | null;
  extraLimit: string | null;
  extraBalance: string | null;
  extraResetDate: string | null;
  extraUpdatedAt: string | null;
}

export interface ExtraUsageResolved extends ExtraUsageRaw {
  /** ISO timestamp for our reset date, or null when it could not be parsed. */
  resetAt: string | null;
  /** True when this snapshot no longer describes our current billing period. */
  expired: boolean;
  /** Why it expired — for a UI hint. Null while still current. */
  expiredReason: 'reset_passed' | 'too_old' | null;
}

/**
 * Parse a bookmarklet reset string ("Apr 1", "Apr 1, 2026", "2026-04-01")
 * into an absolute date. Year-less strings are anchored to the snapshot's
 * own timestamp: the first occurrence of that month/day on or after the
 * snapshot. A reset date can never precede the sync that reported it.
 */
export function parseResetDate(reset: string | null, syncedAt: Date): Date | null {
  if (!reset) return null;
  const s = reset.trim();

  const iso = /^(\d{4})-(\d{2})-(\d{2})/.exec(s);
  if (iso) {
    const d = new Date(Date.UTC(+iso[1], +iso[2] - 1, +iso[3]));
    return isNaN(d.getTime()) ? null : d;
  }

  const m = /^([A-Za-z]{3,})\.?\s+(\d{1,2})(?:st|nd|rd|th)?(?:,?\s+(\d{4}))?$/.exec(s);
  if (!m) return null;
  const month = MONTHS.indexOf(m[1].slice(0, 3).toLowerCase());
  if (month < 0) return null;
  const day = +m[2];
  if (day < 1 || day > 31) return null;

  if (m[3]) {
    const d = new Date(Date.UTC(+m[3], month, day));
    return isNaN(d.getTime()) ? null : d;
  }

  // Year-less: anchor to sync year, roll forward if it already passed.
  let d = new Date(Date.UTC(syncedAt.getUTCFullYear(), month, day));
  if (d.getTime() < Date.UTC(syncedAt.getUTCFullYear(), syncedAt.getUTCMonth(), syncedAt.getUTCDate())) {
    d = new Date(Date.UTC(syncedAt.getUTCFullYear() + 1, month, day));
  }
  return d;
}

export function resolveExtraUsage(raw: ExtraUsageRaw, now: Date = new Date()): ExtraUsageResolved {
  const syncedAt = raw.extraUpdatedAt ? new Date(raw.extraUpdatedAt) : null;
  const hasSync = !!syncedAt && !isNaN(syncedAt.getTime());

  // No snapshot at all — nothing to expire.
  if (!raw.extraSpent && !raw.extraLimit && !raw.extraBalance) {
    return { ...raw, resetAt: null, expired: false, expiredReason: null };
  }

  const resetDate = hasSync ? parseResetDate(raw.extraResetDate, syncedAt!) : null;
  const resetAt = resetDate ? resetDate.toISOString() : null;

  if (resetDate && now.getTime() >= resetDate.getTime()) {
    return { ...raw, resetAt, expired: true, expiredReason: 'reset_passed' };
  }

  const ageMs = hasSync ? now.getTime() - syncedAt!.getTime() : Infinity;
  if (ageMs > MAX_SNAPSHOT_AGE_DAYS * 86_400_000) {
    return { ...raw, resetAt, expired: true, expiredReason: 'too_old' };
  }

  return { ...raw, resetAt, expired: false, expiredReason: null };
}
