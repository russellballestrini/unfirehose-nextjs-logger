'use client';

import type { Harness } from '@/lib/harnesses';

/**
 * The grid of installable harnesses, with a filter over it.
 *
 * Two pages install harnesses — a machine we ssh to, and an unsandbox
 * container — and both drew this grid themselves. The markup was the same
 * sixty lines twice, which is how the two came to disagree about which
 * tags a card shows and what the button says while it works.
 *
 * What genuinely differs is the line above the grid, so that is a prop.
 */

/** Where a harness install has got to, per harness id. */
export type BootStatus =
  | { state: 'idle' }
  | { state: 'verifying'; output?: string }
  | { state: 'success'; version: string; steps?: unknown[] }
  | { state: 'error'; detail: string; steps?: unknown[] };

export function HarnessPicker({
  harnesses, filter, setFilter, statuses, onBoot, header, footer,
}: {
  harnesses: Harness[];
  filter: string;
  setFilter: (v: string) => void;
  /** Keyed by harness id; anything absent has not been tried. */
  statuses: Record<string, BootStatus | undefined>;
  onBoot: (harness: Harness) => void;
  /** The target line — which machine, or which container. */
  header: React.ReactNode;
  footer?: React.ReactNode;
}) {
  const needle = filter.trim().toLowerCase();
  // Name or tag: sixteen harnesses is a scroll, and people search for
  // 'python' as readily as for 'aider'.
  const shown = needle
    ? harnesses.filter((h) =>
        h.name.toLowerCase().includes(needle) || h.tags.some((t) => t.includes(needle)))
    : harnesses;

  return (
    <div>
      <div className="flex items-center justify-between mb-4">
        {header}
        <input
          type="text"
          placeholder="Filter..."
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          className="text-xs bg-[var(--color-background)] border border-[var(--color-border)] rounded px-2 py-1 w-32"
        />
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3">
        {shown.map((h) => {
          const status: BootStatus = statuses[h.id] ?? { state: 'idle' };
          return (
            <div
              key={h.id}
              className={`rounded border p-3 space-y-2 ${
                status.state === 'success' ? 'border-[var(--color-accent)] bg-[var(--color-accent)]/5'
                : status.state === 'error' ? 'border-[var(--color-error)] bg-red-950/20'
                : 'border-[var(--color-border)] bg-[var(--color-background)]'
              }`}
            >
              <div className="flex items-center justify-between">
                <span className="text-sm font-bold">{h.name}</span>
                <div className="flex gap-1">
                  {h.tags.slice(0, 2).map((t) => (
                    <span key={t} className="text-xs px-1 py-0.5 rounded bg-[var(--color-surface)] text-[var(--color-muted)]">{t}</span>
                  ))}
                </div>
              </div>

              <p className="text-xs text-[var(--color-muted)]">{h.desc}</p>

              <div className="text-xs text-[var(--color-muted)] font-mono space-y-0.5">
                <div className="truncate">install: {h.install}</div>
                <div className="truncate">verify: {h.verify}</div>
                {/* Said before anyone clicks: a harness that needs a key and
                    does not say so boots, starts, and fails at the first
                    request with an auth error. */}
                {h.requiresKey && <div className="text-yellow-500/80">requires: {h.requiresKey}</div>}
              </div>

              <div className="flex items-center gap-2">
                <button
                  onClick={() => onBoot(h)}
                  disabled={status.state === 'verifying'}
                  className="bg-[var(--color-accent)] text-black px-2.5 py-0.5 rounded text-xs font-bold disabled:opacity-50 cursor-pointer"
                >
                  {status.state === 'verifying' ? 'Verifying...'
                    : status.state === 'success' ? 'Re-verify'
                    : 'Verify & Install'}
                </button>
                {status.state === 'success' && (
                  <span className="text-xs text-[var(--color-accent)] font-mono ml-auto truncate max-w-60">{status.version}</span>
                )}
                {status.state === 'error' && (
                  <span className="text-xs text-[var(--color-error)] ml-auto truncate max-w-40">{status.detail}</span>
                )}
              </div>
            </div>
          );
        })}
      </div>

      {footer && <p className="text-xs text-[var(--color-muted)] mt-3">{footer}</p>}
    </div>
  );
}
