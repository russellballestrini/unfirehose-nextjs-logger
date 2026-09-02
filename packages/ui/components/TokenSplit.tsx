'use client';

import { formatTokens, formatCost as defaultFormatCost } from '@unturf/unfirehose/format';

/**
 * Canonical token-type colors. Every dashboard imports these rather than
 * restating them, so cache read is the same green everywhere it appears.
 */
export const TOKEN_TYPE_COLORS = {
  input: '#60a5fa',
  output: '#a78bfa',
  cacheRead: '#10b981',
  cacheWrite: '#f472b6',
  /** Cache read and write together, when a surface shows them as one number. */
  cache: '#10b981',
} as const;

export interface TokenSplitValues {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite?: number;
}

/**
 * Per-type cost in USD. Every field optional — a surface that knows the
 * tokens but not what they cost passes nothing and gets no price line,
 * which is the honest rendering. A missing price is never drawn as $0.
 */
export interface TokenSplitCosts {
  input?: number;
  output?: number;
  cacheRead?: number;
  cacheWrite?: number;
}

type CostFn = (usd: number) => string;

export function totalOf(t: TokenSplitValues): number {
  return t.input + t.output + t.cacheRead + (t.cacheWrite ?? 0);
}

export function cacheOf(t: TokenSplitValues): number {
  return t.cacheRead + (t.cacheWrite ?? 0);
}

/** Cache tokens as a share of every token moved. Null when nothing moved. */
export function cacheShareOf(t: TokenSplitValues): number | null {
  const total = totalOf(t);
  return total > 0 ? cacheOf(t) / total : null;
}

const TOKEN_FIELD: Record<keyof TokenSplitCosts, keyof TokenSplitValues> = {
  input: 'input',
  output: 'output',
  cacheRead: 'cacheRead',
  cacheWrite: 'cacheWrite',
};

/**
 * Price for a group of token types, or null when we do not know it.
 *
 * A price is known only when every type in the group that actually moved
 * tokens carries one. A caller who knows what input cost but not what output
 * cost must not have its input figure rendered as the total — that reads as
 * "the whole window cost $12.50" when the truth is "we priced one quarter of
 * it". Types that moved no tokens need no price; they contribute zero.
 */
function sumCosts(
  c: TokenSplitCosts | undefined,
  tokens: TokenSplitValues,
  keys: (keyof TokenSplitCosts)[],
): number | null {
  if (!c) return null;
  let sum = 0;
  for (const k of keys) {
    const v = c[k];
    if (typeof v === 'number' && Number.isFinite(v)) { sum += v; continue; }
    // No price for this type. Fine only if it moved nothing.
    if ((tokens[TOKEN_FIELD[k]] ?? 0) > 0) return null;
  }
  return sum;
}

/** The hover text that spells cache out into its read and write halves. */
function cacheTitle(t: TokenSplitValues, c: TokenSplitCosts | undefined, fc: CostFn): string {
  const write = t.cacheWrite ?? 0;
  const readCost = c?.cacheRead;
  const writeCost = c?.cacheWrite;
  const read = `cache read ${formatTokens(t.cacheRead)}${readCost != null ? ` · ${fc(readCost)}` : ''}`;
  const wr = `cache write ${formatTokens(write)}${writeCost != null ? ` · ${fc(writeCost)}` : ''}`;
  return `${read}\n${wr}\n\nCache read replays a prompt the provider already holds; cache write pays to put it there. Both bill at their own rates — neither is free, and neither is input.`;
}

function Tile({
  label, value, sub, color, title,
}: {
  label: string; value: string; sub?: string; color?: string; title?: string;
}) {
  return (
    <div
      className="bg-[var(--color-surface)] rounded border border-[var(--color-border)] p-4"
      title={title}
    >
      <div className="text-base text-[var(--color-muted)] mb-1">{label}</div>
      <div className="text-2xl font-bold" style={color ? { color } : undefined}>{value}</div>
      {sub && <div className="text-base text-[var(--color-muted)] mt-1">{sub}</div>}
    </div>
  );
}

/**
 * Total / Input / Cache / Output as four stat tiles, each carrying its price
 * when the caller knows one.
 *
 * On a coding-agent workload cache is upward of 90% of every token moved and
 * of every dollar spent, so a dashboard that reports only input and output
 * is not reporting the workload. This component is how each of ours says so.
 */
export function TokenSplitCards({
  tokens,
  costs,
  formatCost = defaultFormatCost,
  showTotal = true,
  className,
}: {
  tokens: TokenSplitValues;
  costs?: TokenSplitCosts;
  /** Defaults to core's formatCost; pass useCurrency().format to localize. */
  formatCost?: CostFn;
  showTotal?: boolean;
  className?: string;
}) {
  const total = totalOf(tokens);
  const cache = cacheOf(tokens);
  const share = cacheShareOf(tokens);

  const totalCost = sumCosts(costs, tokens, ['input', 'output', 'cacheRead', 'cacheWrite']);
  const cacheCost = sumCosts(costs, tokens, ['cacheRead', 'cacheWrite']);
  const inputCost = costs?.input;
  const outputCost = costs?.output;

  const cols = showTotal ? 'grid-cols-4' : 'grid-cols-3';
  return (
    <div className={`grid ${cols} gap-4 ${className ?? ''}`}>
      {showTotal && (
        <Tile
          label="Total Tokens"
          value={formatTokens(total)}
          sub={totalCost != null ? formatCost(totalCost) : undefined}
          title={
            `input ${formatTokens(tokens.input)} · cache ${formatTokens(cache)} · output ${formatTokens(tokens.output)}` +
            (share != null ? `\n${(share * 100).toFixed(1)}% of every token moved was cache.` : '')
          }
        />
      )}
      <Tile
        label="Input"
        value={formatTokens(tokens.input)}
        sub={inputCost != null ? formatCost(inputCost) : undefined}
        color={TOKEN_TYPE_COLORS.input}
        title="Fresh prompt tokens the provider had to read for the first time."
      />
      <Tile
        label="Cache"
        value={formatTokens(cache)}
        sub={
          cacheCost != null
            ? `${formatCost(cacheCost)}${share != null ? ` · ${(share * 100).toFixed(0)}% of tokens` : ''}`
            : share != null ? `${(share * 100).toFixed(0)}% of tokens` : undefined
        }
        color={TOKEN_TYPE_COLORS.cacheRead}
        title={cacheTitle(tokens, costs, formatCost)}
      />
      <Tile
        label="Output"
        value={formatTokens(tokens.output)}
        sub={outputCost != null ? formatCost(outputCost) : undefined}
        color={TOKEN_TYPE_COLORS.output}
        title="Tokens the model generated. The most expensive per token, and the smallest pile."
      />
    </div>
  );
}

/**
 * The same three numbers on one line, for list rows and table cells where a
 * tile row would not fit. Prices append when the caller knows them.
 */
export function TokenSplitInline({
  tokens,
  costs,
  formatCost = defaultFormatCost,
  className,
}: {
  tokens: TokenSplitValues;
  costs?: TokenSplitCosts;
  formatCost?: CostFn;
  className?: string;
}) {
  const cache = cacheOf(tokens);
  const inputCost = costs?.input;
  const outputCost = costs?.output;
  const cacheCost = sumCosts(costs, tokens, ['cacheRead', 'cacheWrite']);

  const part = (label: string, n: number, color: string, cost: number | null | undefined, title: string) => (
    <span className="whitespace-nowrap" title={title}>
      <span style={{ color }}>{label}</span>{' '}
      {formatTokens(n)}
      {cost != null && <span className="text-[var(--color-muted)]"> {formatCost(cost)}</span>}
    </span>
  );

  return (
    <span className={`inline-flex items-center gap-2 ${className ?? ''}`}>
      {part('in', tokens.input, TOKEN_TYPE_COLORS.input, inputCost, 'Fresh prompt tokens.')}
      <span className="text-[var(--color-border)]">·</span>
      {part('cache', cache, TOKEN_TYPE_COLORS.cacheRead, cacheCost, cacheTitle(tokens, costs, formatCost))}
      <span className="text-[var(--color-border)]">·</span>
      {part('out', tokens.output, TOKEN_TYPE_COLORS.output, outputCost, 'Generated tokens.')}
    </span>
  );
}
