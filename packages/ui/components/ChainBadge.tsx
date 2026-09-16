'use client';

/**
 * One glance at a session's provenance: is the journal the bytes its
 * writer hashed, and does its root hold?
 *
 *   verified   closed, root recomputed and matched, no break
 *   open       chained so far, still being written (or never closed)
 *   corrupted  a break — edited, truncated, spliced, or a wrong root —
 *              named by line index and reason
 *   unchained  an older writer; nothing to check, and nothing claimed
 *
 * Verdict vocabulary is unfirehose-chain-v1's, shared with the writer
 * (uncloseai-cli `provenance.py`) and the ingester (`provenance.ts`).
 */
export type ChainVerdict = 'unchained' | 'open' | 'verified' | 'corrupted';

export interface ChainBadgeProps {
  state: ChainVerdict;
  breaks?: number | null;
  firstBreak?: number | null;
  firstBreakReason?: string | null;
  root?: string | null;
  entries?: number | null;
  /** `live` when the verdict was just recomputed from the file; `recorded` when read from ingest. */
  source?: 'live' | 'recorded';
  /**
   * The witness: what the file looks like now against the leaves the
   * ingester recorded as it first read it. A re-hashed rewrite still
   * verifies; it does not still match the witness.
   */
  anchor?: 'intact' | 'rewritten' | 'missing' | null;
  className?: string;
}

const LOOK: Record<ChainVerdict, { glyph: string; label: string; color: string }> = {
  verified: { glyph: '⛓✓', label: 'verified', color: '#22c55e' },
  open: { glyph: '⛓', label: 'open', color: '#3b82f6' },
  corrupted: { glyph: '⛓✗', label: 'corrupted', color: '#ef4444' },
  unchained: { glyph: '⛓', label: 'unchained', color: 'var(--color-muted)' },
};

export function chainTitle(p: ChainBadgeProps): string {
  const n = p.entries ?? null;
  const lines = n === null ? '' : ` · ${n} ${n === 1 ? 'line' : 'lines'}`;
  const anchor = p.anchor === 'rewritten'
    ? ' · REWRITTEN after ingest: the file no longer matches what the witness recorded'
    : p.anchor === 'missing' ? ' · journal file MISSING since ingest'
    : p.anchor === 'intact' ? ' · witness: intact' : '';
  const src = (p.source ? ` (${p.source})` : '') + anchor;
  switch (p.state) {
    case 'verified':
      return `Chain verified${lines} · root ${p.root ? p.root.slice(0, 12) + '…' : '?'}${src}`;
    case 'open':
      return `Chain intact so far${lines} · no closed record yet${src}`;
    case 'corrupted': {
      const where = p.firstBreak === null || p.firstBreak === undefined ? '' : ` · first break at line ${p.firstBreak}`;
      const why = p.firstBreakReason ? ` (${p.firstBreakReason})` : '';
      const count = p.breaks ? ` · ${p.breaks} ${p.breaks === 1 ? 'break' : 'breaks'}` : '';
      return `Chain corrupted${count}${where}${why}${lines}${src}`;
    }
    default:
      return `Unchained journal — written before hash chaining, nothing to verify${lines}${src}`;
  }
}

export function ChainBadge(props: ChainBadgeProps) {
  const { state, className = '' } = props;
  const tampered = props.anchor === 'rewritten' || props.anchor === 'missing';
  const look = tampered
    ? { glyph: '⛓✗', label: props.anchor === 'missing' ? 'missing' : 'rewritten', color: '#ef4444' }
    : (LOOK[state] ?? LOOK.unchained);
  return (
    <span
      className={`text-xs px-1.5 py-0.5 rounded inline-flex items-center gap-1 ${className}`}
      style={{
        background: `color-mix(in srgb, ${look.color} 13%, transparent)`,
        color: look.color,
        border: `1px solid color-mix(in srgb, ${look.color} 33%, transparent)`,
      }}
      title={chainTitle(props)}
      data-chain-state={state}
      data-anchor-state={props.anchor ?? undefined}
    >
      {look.glyph} {look.label}
      {state === 'corrupted' && props.firstBreak !== null && props.firstBreak !== undefined && (
        <span className="opacity-70">@{props.firstBreak}</span>
      )}
    </span>
  );
}
