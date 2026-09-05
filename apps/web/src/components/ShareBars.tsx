/**
 * Shares of a whole, as a sorted list of bars.
 *
 * The replacement we are weighing for the model-share donuts. uPlot does not
 * draw pies, and recharts costs 326KB to draw one; this costs nothing and
 * answers the question a pie is asked — which ones matter and by how much —
 * with the biggest first and the number beside it, which a pie with eight
 * slices cannot do without a legend. Pure markup, so it renders on the
 * server and needs no canvas.
 */

export interface Share {
  name: string;
  /** Shown on hover, when the name is an abbreviation. */
  fullName?: string;
  value: number;
  color: string;
}

export function ShareBars({
  data, format, topN = 8, className = '',
}: {
  data: Share[];
  /** How to print a value: tokens, dollars, counts. */
  format: (v: number) => string;
  /** Rows past this fold into one "other" row, so a long tail does not push the head off screen. */
  topN?: number;
  className?: string;
}) {
  const sorted = [...data].filter((d) => d.value > 0).sort((a, b) => b.value - a.value);
  const total = sorted.reduce((s, d) => s + d.value, 0);
  if (total === 0) return <div className={`text-sm text-[var(--color-muted)] ${className}`}>nothing yet</div>;

  const head = sorted.slice(0, topN);
  const tail = sorted.slice(topN);
  const rows = tail.length
    ? [...head, { name: `other (${tail.length})`, fullName: `${tail.length} smaller`, value: tail.reduce((s, d) => s + d.value, 0), color: 'var(--color-muted)' }]
    : head;
  const max = rows[0].value;

  return (
    <div className={`space-y-1.5 ${className}`} role="list">
      {rows.map((r) => {
        const pct = (r.value / total) * 100;
        return (
          <div key={r.name} role="listitem" className="grid grid-cols-[minmax(0,9rem)_1fr_3.5rem_auto] items-center gap-2 text-sm" title={r.fullName ?? r.name}>
            <span className="truncate flex items-center gap-1.5">
              <span className="inline-block w-2.5 h-2.5 rounded-sm shrink-0" style={{ background: r.color }} />
              {r.name}
            </span>
            <span className="h-2 rounded bg-[var(--color-surface-hover)] overflow-hidden">
              {/* Bar length is relative to the largest row, so the head is always full width and the rest read against it. */}
              <span className="block h-full rounded" style={{ width: `${(r.value / max) * 100}%`, background: r.color }} />
            </span>
            <span className="text-right text-[var(--color-muted)] tabular-nums">{pct < 1 ? '<1' : Math.round(pct)}%</span>
            <span className="text-right tabular-nums">{format(r.value)}</span>
          </div>
        );
      })}
    </div>
  );
}
