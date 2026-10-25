import { formatTokens } from '@unturf/unfirehose/format';
import { TOKEN_TYPE_COLORS } from '@unturf/unfirehose-ui/TokenSplit';
import { formatCost } from '../_lib';

/* eslint-disable @typescript-eslint/no-explicit-any */

/**
 * The four token types, in the order every breakdown table reads them,
 * with the row fields each one is counted and priced from. The per-model
 * and per-harness tables share these cells so a column added to one is
 * added to both.
 */
const SPLIT = [
  { label: 'Input', color: TOKEN_TYPE_COLORS.input, tokens: 'inputTokens', cost: 'inputCostUSD' },
  { label: 'Output', color: TOKEN_TYPE_COLORS.output, tokens: 'outputTokens', cost: 'outputCostUSD' },
  { label: 'Cache Read', color: TOKEN_TYPE_COLORS.cacheRead, tokens: 'cacheReadTokens', cost: 'cacheReadCostUSD' },
  { label: 'Cache Write', color: TOKEN_TYPE_COLORS.cacheWrite, tokens: 'cacheCreationTokens', cost: 'cacheWriteCostUSD' },
] as const;

/** Input, Output, Cache Read, Cache Write, Total. */
export function SplitHeaders() {
  return (
    <>
      {[...SPLIT.map((s) => s.label), 'Total'].map((label) => (
        <th key={label} className="pb-2 text-right">{label}</th>
      ))}
    </>
  );
}

/**
 * A row's tokens by type then its total in bold or, with `cost`, its
 * equivalent cost by type then its total in our accent.
 */
export function SplitCells({ row, cost = false }: { row: any; cost?: boolean }) {
  const show = (s: (typeof SPLIT)[number]) =>
    cost ? formatCost(row[s.cost] ?? 0) : formatTokens(row[s.tokens]);
  return (
    <>
      {SPLIT.map((s) => (
        <td key={s.label} className="py-2 text-right" style={{ color: s.color }}>
          {show(s)}
        </td>
      ))}
      <td className={cost ? 'py-2 text-right text-[var(--color-accent)] font-bold' : 'py-2 text-right font-bold'}>
        {cost ? formatCost(row.costUSD) : formatTokens(row.totalTokens)}
      </td>
    </>
  );
}

/** The coloured dot that keys a row to its chart series. */
export function Swatch({ color }: { color: string }) {
  return (
    <span
      className="inline-block w-2 h-2 rounded-full shrink-0"
      style={{ background: color }}
    />
  );
}
