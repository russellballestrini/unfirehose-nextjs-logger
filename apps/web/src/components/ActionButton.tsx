'use client';

import type { ReactNode } from 'react';

/**
 * A button that runs something and reports how it went, in place.
 *
 * Our usage page had two of these written out longhand — acknowledge-all
 * and calibrate — each with two three-way ternary chains, one for its
 * classes and one for its label. Four chains for one idea, and the two
 * copies had already drifted apart in their colours.
 *
 * The states are a table rather than a chain, so adding a fifth is a row
 * that fails to compile if it is incomplete, instead of a condition that
 * silently falls through to whatever the last branch says.
 */

/** What an action is doing. Idle covers "not started" and "long since done". */
export type ActionState =
  | { kind: 'idle' }
  | { kind: 'pending' }
  | { kind: 'done' }
  | { kind: 'error'; msg: string };

const STYLES: Record<ActionState['kind'], string> = {
  pending: 'text-[var(--color-foreground)] border-[var(--color-border)] bg-[var(--color-surface)] cursor-wait',
  done:    'text-green-300 border-green-700 bg-green-950/40',
  error:   'text-red-300 border-red-700 bg-red-950/40',
  idle:    'text-[var(--color-muted)] hover:text-[var(--color-foreground)] border-transparent hover:border-[var(--color-border)]',
};

export function ActionButton({
  state, onClick, disabled, labels, title, className = '',
}: {
  state: ActionState;
  onClick: () => void;
  disabled?: boolean;
  /** What to say in each state. The caller owns the wording and its counts. */
  labels: Record<ActionState['kind'], ReactNode>;
  title?: string;
  className?: string;
}) {
  return (
    <button
      onClick={onClick}
      // A pending action is never clickable twice, whatever else the caller says.
      disabled={disabled || state.kind === 'pending'}
      className={`cursor-pointer rounded border transition-colors ${STYLES[state.kind]} ${className}`}
      // An error's own text is the tooltip, so a truncated label is still readable.
      title={state.kind === 'error' ? state.msg : title}
    >
      {labels[state.kind]}
    </button>
  );
}
