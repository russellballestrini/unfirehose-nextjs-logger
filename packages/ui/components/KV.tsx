'use client';

/**
 * A labelled value, for detail panels that list many of them.
 *
 * Two pages had their own, differing on one real question: what to do with
 * nothing. A node's detail panel says "n/a", because the absence of a
 * reading is itself information about the probe; a service panel hides the
 * row, because a field that does not apply is noise. Both are right, so it
 * is a prop rather than two components.
 */
export function KV({
  label, value, hideEmpty = false, align = false,
}: {
  label: string;
  value?: string | number | null;
  /** Render nothing at all when there is no value. */
  hideEmpty?: boolean;
  /** Push the value to the right, for a column of aligned figures. */
  align?: boolean;
}) {
  const empty = value === null || value === undefined || value === '';
  if (empty && hideEmpty) return null;

  if (align) {
    return (
      <div className="flex justify-between gap-2">
        <span className="text-[var(--color-muted)]">{label}:</span>
        <span className="font-bold text-right">{empty ? 'n/a' : value}</span>
      </div>
    );
  }

  return (
    <div>
      <span className="text-[var(--color-muted)]">{label}: </span>
      <span>{empty ? 'n/a' : value}</span>
    </div>
  );
}

/** Label and figure on one line, for a summary bar. */
export function MiniStat({
  label, value, accent = false,
}: { label: string; value: string | number; accent?: boolean }) {
  return (
    <div className="flex items-center gap-1.5">
      <span className="text-base text-[var(--color-muted)]">{label}</span>
      <span className={`text-base font-bold font-mono ${accent ? 'text-[var(--color-accent)]' : ''}`}>
        {value}
      </span>
    </div>
  );
}
