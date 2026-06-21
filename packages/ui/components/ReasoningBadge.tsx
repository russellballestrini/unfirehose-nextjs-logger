'use client';

/**
 * Shared reasoning-count badge.
 *
 * Renders a `◎ N` chip in thinking color. When `sealed === count` (all reasoning
 * in scope is sealed by Anthropic — claude-opus-4-7 ships signatures only, not
 * readable text), append `·sealed` and rewrite the title to explain why the
 * user can't read the content.
 *
 * Used on /active session cards, /live header, session viewer header, anywhere
 * else we want to expose "this happened" without lying that it's readable.
 */
export function ReasoningBadge({
  count,
  sealed,
  className = '',
}: {
  /** Total reasoning blocks in scope. */
  count: number;
  /** Subset of `count` that has empty text (signature-only). */
  sealed: number;
  className?: string;
}) {
  if (count <= 0) return null;
  const readable = count - sealed;
  const allSealed = sealed > 0 && readable === 0;
  const title = allSealed
    ? `${count} reasoning blocks — all sealed by Anthropic (claude-opus-4-7 ships signed proofs without readable text)`
    : sealed > 0
      ? `${count} reasoning blocks · ${readable} readable · ${sealed} sealed`
      : `${count} reasoning ${count === 1 ? 'block' : 'blocks'}`;
  return (
    <span
      className={`text-xs px-1.5 py-0.5 rounded inline-flex items-center gap-1 ${className}`}
      style={{
        background: 'var(--color-thinking)22',
        color: 'var(--color-thinking)',
        border: '1px solid var(--color-thinking)55',
      }}
      title={title}
    >
      ◎ {count}{allSealed && <span className="opacity-60">·sealed</span>}
    </span>
  );
}
