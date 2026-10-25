import { getModelColor } from '@unturf/unfirehose-ui/modelColor';
import { formatTokens } from '@unturf/unfirehose/format';
import { shortModel, formatCost } from '../_lib';
import { SplitHeaders, SplitCells, Swatch } from './SplitCells';

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
              <SplitHeaders />
              <SplitHeaders />
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
                    <Swatch color={getModelColor(m.model)} />
                    {shortModel(m.model)}
                  </td>
                  <SplitCells row={m} />
                  <SplitCells row={m} cost />
                </tr>
              ))}
            {/* Totals row */}
            <tr className="border-t-2 border-[var(--color-border)] font-bold">
              <td className="py-2">Total</td>
              {[totalInput, totalOutput, totalCacheRead, totalCacheWrite, totalTokens].map((n, i) => (
                <td key={i} className="py-2 text-right">{formatTokens(n)}</td>
              ))}
              {[totalInputCost, totalOutputCost, totalCacheReadCost, totalCacheWriteCost].map((n, i) => (
                <td key={i} className="py-2 text-right">{formatCost(n)}</td>
              ))}
              <td className="py-2 text-right text-[var(--color-accent)]">{formatCost(totalCost)}</td>
            </tr>
          </tbody>
        </table>
      </div>
    </div>
  );
}
