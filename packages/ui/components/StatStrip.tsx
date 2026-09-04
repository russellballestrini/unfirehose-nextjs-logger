/**
 * One row of figures, not a grid of cards.
 *
 * The dashboard carried nine bordered cards over two rows and the project
 * page four more plus a token split — a lot of chrome around numbers that
 * are each a word and a value. A single strip says the same thing in a
 * fifth of the height, and leaves the charts above the fold.
 */
import type { ReactNode } from 'react';

export function StatStrip({ children }: { children: ReactNode }) {
  return (
    <div className="bg-[var(--color-surface)] rounded border border-[var(--color-border)] px-4 py-3
                    flex flex-wrap items-start gap-x-6 gap-y-3">
      {children}
    </div>
  );
}

/** Separates what happened from what it cost. */
export function StatDivider() {
  return <span className="self-stretch w-px bg-[var(--color-border)]" aria-hidden />;
}

export function Stat({
  label, value, sub, title, color,
}: {
  label: string;
  value: string | number;
  sub?: string;
  title?: string;
  color?: string;
}) {
  return (
    <div className="min-w-[6.5rem]" title={title}>
      <div className="text-xs text-[var(--color-muted)] uppercase tracking-wide">{label}</div>
      <div className="text-xl font-bold leading-tight" style={color ? { color } : undefined}>{value}</div>
      {sub && <div className="text-xs text-[var(--color-muted)] mt-0.5">{sub}</div>}
    </div>
  );
}

/**
 * A cost we may not know. Undefined prints an em dash, never $0 — a missing
 * price must not read as a free one.
 */
export function costSub(usd: number | undefined | null): string {
  if (usd == null) return '—';
  return `$${usd < 10 ? usd.toFixed(2) : Math.round(usd).toLocaleString()}`;
}

/** Cache read + cache write, or undefined when neither was priced. */
export function cacheCostOf(
  split: { cacheRead?: number; cacheWrite?: number } | undefined | null,
): number | undefined {
  if (!split) return undefined;
  return (split.cacheRead ?? 0) + (split.cacheWrite ?? 0);
}
