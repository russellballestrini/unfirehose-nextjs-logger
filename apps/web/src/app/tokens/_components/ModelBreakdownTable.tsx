import { getModelColor } from '@unturf/unfirehose-ui/modelColor';
import { formatTokens } from '@unturf/unfirehose/format';
import { TOKEN_TYPE_COLORS } from '@unturf/unfirehose-ui/TokenSplit';
import { shortModel, formatCost } from '../_lib';

/* eslint-disable @typescript-eslint/no-explicit-any */

export interface TokenTotals {
  totalTokens: number;
  totalCost: number;
  totalInputCost: number;
  totalOutputCost: number;
  totalCacheReadCost: number;
  totalCacheWriteCost: number;
  totalInput: number;
  totalOutput: number;
  totalCacheRead: number;
  totalCacheWrite: number;
}

export function ModelBreakdownTable({ modelBreakdown, totals }: {
  modelBreakdown: any[];
  totals: TokenTotals;
}) {
  const {
    totalTokens, totalCost, totalInputCost, totalOutputCost, totalCacheReadCost,
    totalCacheWriteCost, totalInput, totalOutput, totalCacheRead, totalCacheWrite,
  } = totals;
  return (
    <div data-coach="tokens-models" className="bg-[var(--color-surface)] rounded border border-[var(--color-border)] p-4">
      <h3 className="text-base font-bold mb-3 text-[var(--color-muted)]">
        Per-Model Breakdown
      </h3>
      <div className="overflow-x-auto" data-scroll-x>
        <table className="w-full text-base">
          <thead>
            <tr className="text-[var(--color-muted)] text-left border-b border-[var(--color-border)]">
              <th className="pb-2">Model</th>
              <th className="pb-2 text-right" colSpan={5}>Tokens</th>
              <th className="pb-2 text-right" colSpan={5}>Equivalent Cost</th>
            </tr>
            <tr className="text-[var(--color-muted)] text-left border-b border-[var(--color-border)]">
              <th className="pb-2"></th>
              <th className="pb-2 text-right">Input</th>
              <th className="pb-2 text-right">Output</th>
              <th className="pb-2 text-right">Cache Read</th>
              <th className="pb-2 text-right">Cache Write</th>
              <th className="pb-2 text-right">Total</th>
              <th className="pb-2 text-right">Input</th>
              <th className="pb-2 text-right">Output</th>
              <th className="pb-2 text-right">Cache Read</th>
              <th className="pb-2 text-right">Cache Write</th>
              <th className="pb-2 text-right">Total</th>
            </tr>
          </thead>
          <tbody>
            {modelBreakdown
              .filter((m: any) => m.totalTokens > 0)
              .sort((a: any, b: any) => b.totalTokens - a.totalTokens)
              .map((m: any) => (
                <tr
                  key={m.model}
                  className="border-b border-[var(--color-border)]"
                >
                  <td className="py-2 flex items-center gap-2">
                    <span
                      className="inline-block w-2 h-2 rounded-full shrink-0"
                      style={{ background: getModelColor(m.model) }}
                    />
                    {shortModel(m.model)}
                  </td>
                  <td className="py-2 text-right" style={{ color: TOKEN_TYPE_COLORS.input }}>
                    {formatTokens(m.inputTokens)}
                  </td>
                  <td className="py-2 text-right" style={{ color: TOKEN_TYPE_COLORS.output }}>
                    {formatTokens(m.outputTokens)}
                  </td>
                  <td className="py-2 text-right" style={{ color: TOKEN_TYPE_COLORS.cacheRead }}>
                    {formatTokens(m.cacheReadTokens)}
                  </td>
                  <td className="py-2 text-right" style={{ color: TOKEN_TYPE_COLORS.cacheWrite }}>
                    {formatTokens(m.cacheCreationTokens)}
                  </td>
                  <td className="py-2 text-right font-bold">
                    {formatTokens(m.totalTokens)}
                  </td>
                  <td className="py-2 text-right" style={{ color: TOKEN_TYPE_COLORS.input }}>
                    {formatCost(m.inputCostUSD ?? 0)}
                  </td>
                  <td className="py-2 text-right" style={{ color: TOKEN_TYPE_COLORS.output }}>
                    {formatCost(m.outputCostUSD ?? 0)}
                  </td>
                  <td className="py-2 text-right" style={{ color: TOKEN_TYPE_COLORS.cacheRead }}>
                    {formatCost(m.cacheReadCostUSD ?? 0)}
                  </td>
                  <td className="py-2 text-right" style={{ color: TOKEN_TYPE_COLORS.cacheWrite }}>
                    {formatCost(m.cacheWriteCostUSD ?? 0)}
                  </td>
                  <td className="py-2 text-right text-[var(--color-accent)] font-bold">
                    {formatCost(m.costUSD)}
                  </td>
                </tr>
              ))}
            {/* Totals row */}
            <tr className="border-t-2 border-[var(--color-border)] font-bold">
              <td className="py-2">Total</td>
              <td className="py-2 text-right">{formatTokens(totalInput)}</td>
              <td className="py-2 text-right">{formatTokens(totalOutput)}</td>
              <td className="py-2 text-right">{formatTokens(totalCacheRead)}</td>
              <td className="py-2 text-right">{formatTokens(totalCacheWrite)}</td>
              <td className="py-2 text-right">{formatTokens(totalTokens)}</td>
              <td className="py-2 text-right">{formatCost(totalInputCost)}</td>
              <td className="py-2 text-right">{formatCost(totalOutputCost)}</td>
              <td className="py-2 text-right">{formatCost(totalCacheReadCost)}</td>
              <td className="py-2 text-right">{formatCost(totalCacheWriteCost)}</td>
              <td className="py-2 text-right text-[var(--color-accent)]">{formatCost(totalCost)}</td>
            </tr>
          </tbody>
        </table>
      </div>
    </div>
  );
}
