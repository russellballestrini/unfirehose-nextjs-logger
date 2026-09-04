/**
 * A unified diff, rendered in runs rather than one element per line.
 *
 * Three pages each built their own copy of this, and each made one <div>
 * per line with inline styles. A diff is unbounded — `git diff HEAD` across
 * a large change is tens of thousands of lines — so that is tens of
 * thousands of nodes with their own style objects for React to reconcile
 * and the browser to lay out. The same shape made opening a 1,458-line file
 * take seconds while the API answered in 7ms.
 *
 * Consecutive lines of the same kind share one element, because a diff is
 * runs: context, then additions, then context. Colour survives, the node
 * count does not. A long diff is capped until asked for in full, since the
 * first screen is what anyone reads.
 */
'use client';

import { useMemo, useState } from 'react';

type LineKind = 'add' | 'del' | 'hunk' | 'file' | 'meta' | 'context';

function kindOf(line: string): LineKind {
  if (line.startsWith('+++') || line.startsWith('---')) return 'meta';
  if (line.startsWith('+')) return 'add';
  if (line.startsWith('-')) return 'del';
  if (line.startsWith('@@')) return 'hunk';
  if (line.startsWith('diff ')) return 'file';
  if (line.startsWith('index ')) return 'meta';
  return 'context';
}

const CLASS: Record<LineKind, string> = {
  add:     'text-green-400 bg-green-500/10',
  del:     'text-red-400 bg-red-500/10',
  hunk:    'text-cyan-400',
  file:    'text-[var(--color-accent)] font-bold border-t border-[var(--color-border)] pt-2 mt-2',
  meta:    'text-[var(--color-muted)]',
  context: '',
};

export interface DiffViewProps {
  diff: string;
  /** Lines drawn before the "show the rest" control. */
  maxLines?: number;
  className?: string;
}

export function DiffView({ diff, maxLines = 1500, className = '' }: DiffViewProps) {
  const [showAll, setShowAll] = useState(false);

  const { runs, total, shown } = useMemo(() => {
    const lines = (diff ?? '').split('\n');
    const limit = showAll ? lines.length : Math.min(lines.length, maxLines);
    const out: Array<{ kind: LineKind; text: string }> = [];
    for (let i = 0; i < limit; i++) {
      const kind = kindOf(lines[i]);
      const last = out[out.length - 1];
      // A run ends when the kind changes. `file` and `hunk` always start
      // their own, because they carry spacing that must not be shared.
      if (last && last.kind === kind && kind !== 'file' && kind !== 'hunk') {
        last.text += '\n' + lines[i];
      } else {
        out.push({ kind, text: lines[i] });
      }
    }
    return { runs: out, total: lines.length, shown: limit };
  }, [diff, maxLines, showAll]);

  return (
    <div className={className}>
      <pre className="text-xs font-mono leading-relaxed whitespace-pre overflow-auto">
        {runs.map((r, i) => (
          <div key={i} className={CLASS[r.kind]}>{r.text || ' '}</div>
        ))}
      </pre>
      {shown < total && (
        <button
          onClick={() => setShowAll(true)}
          className="mt-2 text-xs px-2 py-1 rounded border border-[var(--color-border)] text-[var(--color-muted)] hover:border-[var(--color-accent)] hover:text-[var(--color-accent)] cursor-pointer"
        >
          Showing {shown.toLocaleString()} of {total.toLocaleString()} lines — show the rest
        </button>
      )}
    </div>
  );
}
