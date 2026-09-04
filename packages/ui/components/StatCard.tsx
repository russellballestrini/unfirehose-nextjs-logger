'use client';

/**
 * One figure, labelled.
 *
 * Four pages had each written their own — different backgrounds, type
 * scales, and emphasis props called `warn`, `accent` and `color` — and the
 * styleguide showed a fifth version built from raw divs. None of them was
 * wrong so much as unaware of the others, which is how a dashboard ends up
 * looking like four dashboards.
 *
 * The treatment here is the one the design system already specified for a
 * card and the styleguide already drew: surface ground, p-4, a muted label,
 * a 2xl value, a muted sub. Three pages had drifted from documented canon;
 * this makes the documentation real rather than picking a new winner.
 *
 * `compact` is the one genuine second size. The mesh page fits many cards to
 * a row on purpose, and shrinking the type there is a layout decision rather
 * than drift — so it is a named size with a place in the styleguide, not a
 * page inventing its own.
 */

export type StatTone = 'default' | 'accent' | 'warn';

export interface StatCardProps {
  label: string;
  value: string | number;
  /** Secondary line: a rate, a comparison, a count. */
  sub?: string;
  /** `warn` also reddens the border, because the card is the alarm. */
  tone?: StatTone;
  /** An explicit value colour, for series that carry their own — token
   *  types on the tokens page keep their chart colour here. Wins over tone. */
  color?: string;
  /** Denser type and padding, for grids that fit many cards to a row. */
  compact?: boolean;
  className?: string;
}

export function StatCard({
  label, value, sub, tone = 'default', color, compact = false, className = '',
}: StatCardProps) {
  const warn = tone === 'warn';

  const border = warn ? 'border-[var(--color-error)]' : 'border-[var(--color-border)]';
  const labelColor = warn ? 'text-[var(--color-error)]' : 'text-[var(--color-muted)]';
  const valueColor = warn
    ? 'text-[var(--color-error)]'
    : tone === 'accent' ? 'text-[var(--color-accent)]' : '';

  return (
    <div className={`bg-[var(--color-surface)] rounded border ${border} ${compact ? 'p-3' : 'p-4'} ${className}`}>
      <div className={`${compact ? 'text-xs' : 'text-base'} ${labelColor}`}>{label}</div>
      <div
        className={`${compact ? 'text-sm truncate' : 'text-2xl'} font-bold mt-1 ${color ? '' : valueColor}`}
        style={color ? { color } : undefined}
      >
        {value}
      </div>
      {sub && (
        <div className={`${compact ? 'text-xs truncate' : 'text-base'} text-[var(--color-muted)] mt-1`}>
          {sub}
        </div>
      )}
    </div>
  );
}
