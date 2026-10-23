'use client';

import Link from 'next/link';
import type { ReactNode } from 'react';

/**
 * What a panel says when it has nothing to show.
 *
 * A dozen places said "nothing yet" and stopped there, which is true and
 * teaches nothing: a person on a fresh install cannot tell an empty panel
 * from a broken one, and does not learn what would fill it. Every empty
 * state carries three things now — what will appear here, the action that
 * makes it appear, and where to read more.
 *
 * Two kinds, because no data in range is not the same as no data ever:
 *
 * - `first-run` — nothing has ever landed here. Say what to do: run a
 *   harness, add a node, write a todo.
 * - `quiet` — data exists, none of it in the range on screen. Do not send a
 *   person who has a year of sessions off to install a harness; suggest a
 *   wider range instead, and offer it as a button when the page can.
 *
 * Grid, tokens, 1rem type, a dashed border so it never reads as a card that
 * failed to load its numbers.
 */

export type EmptyKind = 'first-run' | 'quiet';

export interface EmptyStateLink {
  href: string;
  label: string;
}

export interface EmptyStateProps {
  /** What will appear here, as a sentence: "Sessions will appear here." */
  what: ReactNode;
  /** The action that makes it appear. For `quiet`, a default suggests widening the range. */
  action?: ReactNode;
  /** A command to run, shown in a code span after the action. */
  command?: string;
  /** Where to read more or go next. */
  link?: EmptyStateLink;
  kind?: EmptyKind;
  /** The range on screen (a TimeRangeSelect value or a phrase), for `quiet` copy. */
  range?: string;
  /** Widen the range in place; renders a button on a `quiet` state. */
  onWiden?: () => void;
  /** Label for the widen button. */
  widenLabel?: string;
  /** No frame, tighter: for a chart slot or a table cell inside a panel. */
  compact?: boolean;
  className?: string;
}

/**
 * "last 7 days" for '7d', "lifetime" for 'all'; a phrase passes through.
 * Parsed here rather than looked up in TimeRangeSelect, so a page test that
 * mocks the selector still renders its empty state.
 */
export function describeRange(range: string | undefined): string {
  if (!range) return 'this range';
  if (range === 'all') return 'lifetime';
  const m = /^(\d+)([hd])$/.exec(range);
  if (!m) return range;
  const n = Number(m[1]);
  if (m[2] === 'h') return n === 1 ? 'last hour' : `last ${n} hours`;
  if (n === 365) return 'last year';
  if (n === 180) return 'last 6 months';
  return n === 1 ? 'last day' : `last ${n} days`;
}

export function EmptyState({
  what, action, command, link, kind = 'first-run', range, onWiden, widenLabel = 'Show lifetime',
  compact = false, className = '',
}: EmptyStateProps) {
  const quiet = kind === 'quiet';
  const said = action ?? (quiet
    ? `Nothing landed in ${describeRange(range)}. Widen our range to see earlier activity.`
    : null);
  const frame = compact
    ? 'p-2'
    : 'p-4 rounded border border-dashed border-[var(--color-border)] bg-[var(--color-surface)]';

  return (
    <div
      data-empty-kind={kind}
      className={`grid gap-1.5 text-base ${frame} ${className}`}
    >
      <p className="font-bold text-[var(--color-foreground)]">{what}</p>
      {(said || command) && (
        <p className="text-[var(--color-muted)]">
          {said}
          {said && command ? ' ' : null}
          {command && (
            <code className="rounded bg-[var(--color-background)] px-1 text-[var(--color-accent)]">{command}</code>
          )}
        </p>
      )}
      {(link || (quiet && onWiden)) && (
        <div className="grid grid-flow-col auto-cols-max gap-3">
          {quiet && onWiden && (
            <button
              type="button"
              onClick={onWiden}
              className="cursor-pointer min-h-10 lg:min-h-0 rounded border border-[var(--color-border)] px-2 py-0.5 text-[var(--color-foreground)] hover:border-[var(--color-accent)]"
            >
              {widenLabel}
            </button>
          )}
          {link && <EmptyLink {...link} />}
        </div>
      )}
    </div>
  );
}

function EmptyLink({ href, label }: EmptyStateLink) {
  // 40px tall below lg, where a finger does the tapping.
  const cls = 'inline-grid items-center min-h-10 lg:min-h-0 text-[var(--color-accent)] hover:underline';
  // Our own pages route client side; another site opens in its own tab;
  // a hash (a tab on this page) stays a plain same-page anchor.
  if (href.startsWith('/')) return <Link href={href} className={cls}>{label}</Link>;
  if (/^https?:/.test(href)) return <a href={href} className={cls} target="_blank" rel="noreferrer">{label}</a>;
  return <a href={href} className={cls}>{label}</a>;
}
