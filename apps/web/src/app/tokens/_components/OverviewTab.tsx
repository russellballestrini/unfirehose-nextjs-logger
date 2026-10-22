import { getModelColor } from '@unturf/unfirehose-ui/modelColor';
import { formatTokens } from '@unturf/unfirehose/format';
import { TokenSplitCards, TOKEN_TYPE_COLORS } from '@unturf/unfirehose-ui/TokenSplit';
import { StatCard } from '@unturf/unfirehose-ui/StatCard';
import { Donut } from '@/components/Donut';
import { shortModel, formatCost, type ExtraUsage } from '../_lib';
import { ModelDonut } from './ModelDonut';
import { PriceBookPanel } from './PriceBookPanel';
import { VllmCacheTable } from './VllmCacheTable';
import { ModelBreakdownTable, type TokenTotals } from './ModelBreakdownTable';

/* eslint-disable @typescript-eslint/no-explicit-any */

export function OverviewTab({ totals, modelBreakdown, cacheHitPct, vllmModels, extra, priceBook }: {
  totals: TokenTotals;
  modelBreakdown: any[];
  cacheHitPct: number | null;
  vllmModels: any[];
  extra: ExtraUsage;
  priceBook: any;
}) {
  const {
    totalCost, totalInputCost, totalOutputCost, totalCacheReadCost,
    totalCacheWriteCost, totalInput, totalOutput, totalCacheRead, totalCacheWrite,
  } = totals;
  const { extraSpent, extraLimit, extraBalance, extraReset, extraPct } = extra;

  // Data for token type pie chart
  const tokenTypePie = [
    { name: 'Input', value: totalInput, color: TOKEN_TYPE_COLORS.input },
    { name: 'Output', value: totalOutput, color: TOKEN_TYPE_COLORS.output },
    { name: 'Cache Read', value: totalCacheRead, color: TOKEN_TYPE_COLORS.cacheRead },
    { name: 'Cache Write', value: totalCacheWrite, color: TOKEN_TYPE_COLORS.cacheWrite },
  ];

  // Cost by token type — output dominates because $15-$25/M vs $3-$5/M input
  const costTypePie = [
    { name: 'Input', value: totalInputCost, color: TOKEN_TYPE_COLORS.input },
    { name: 'Output', value: totalOutputCost, color: TOKEN_TYPE_COLORS.output },
    { name: 'Cache Read', value: totalCacheReadCost, color: TOKEN_TYPE_COLORS.cacheRead },
    { name: 'Cache Write', value: totalCacheWriteCost, color: TOKEN_TYPE_COLORS.cacheWrite },
  ];

  // Data for model donut chart (by total tokens)
  const modelPie = modelBreakdown
    .filter((m: any) => m.totalTokens > 0)
    .map((m: any) => ({
      name: shortModel(m.model),
      fullName: m.model,
      value: m.totalTokens,
      color: getModelColor(m.model),
    }));

  // Data for model cost donut
  const costPie = modelBreakdown
    .filter((m: any) => m.costUSD > 0)
    .map((m: any) => ({
      name: shortModel(m.model),
      fullName: m.model,
      value: m.costUSD,
      color: getModelColor(m.model),
    }));

  return (
    <>
      {/* Summary cards */}
      <TokenSplitCards
        tokens={{
          input: totalInput,
          output: totalOutput,
          cacheRead: totalCacheRead,
          cacheWrite: totalCacheWrite,
        }}
        costs={{
          input: totalInputCost,
          output: totalOutputCost,
          cacheRead: totalCacheReadCost,
          cacheWrite: totalCacheWriteCost,
          total: totalCost,
        }}
        formatCost={formatCost}
      />
      <div className="grid grid-cols-2 gap-4">
        <StatCard label="Equivalent Cost" value={formatCost(totalCost)} sub="at API rates" />
        <StatCard
          label="Cache Hit Rate"
          value={cacheHitPct == null ? '—' : `${(cacheHitPct * 100).toFixed(1)}%`}
          sub={`${formatTokens(totalCacheRead)} cached / ${formatTokens(totalInput + totalCacheRead)} prompt`}
        />
      </div>

      {/* Measured prefix cache — the number our token accounting cannot see.
          A self-hosted model reports no cache_read tokens, so the stat above
          reads 0% for it however well the cache is working. vLLM counts the
          real thing per model. */}
      <VllmCacheTable vllmModels={vllmModels} />

      {/* Cost split — output usually dominates */}
      <div className="grid grid-cols-4 gap-4">
        <StatCard
          label="Input Cost"
          value={formatCost(totalInputCost)}
          sub={totalCost > 0 ? `${((totalInputCost / totalCost) * 100).toFixed(0)}% of total` : undefined}
          color={TOKEN_TYPE_COLORS.input}
        />
        <StatCard
          label="Output Cost"
          value={formatCost(totalOutputCost)}
          sub={totalCost > 0 ? `${((totalOutputCost / totalCost) * 100).toFixed(0)}% of total` : undefined}
          color={TOKEN_TYPE_COLORS.output}
        />
        <StatCard
          label="Cache Read Cost"
          value={formatCost(totalCacheReadCost)}
          sub={totalCost > 0 ? `${((totalCacheReadCost / totalCost) * 100).toFixed(0)}% of total` : undefined}
          color={TOKEN_TYPE_COLORS.cacheRead}
        />
        <StatCard
          label="Cache Write Cost"
          value={formatCost(totalCacheWriteCost)}
          sub={totalCost > 0 ? `${((totalCacheWriteCost / totalCost) * 100).toFixed(0)}% of total` : undefined}
          color={TOKEN_TYPE_COLORS.cacheWrite}
        />
      </div>

      {/* Card charges strip — shown if synced */}
      {extraSpent !== null && (
        <div className="bg-[var(--color-surface)] rounded border border-[var(--color-border)] p-3 flex items-center gap-6">
          <div className="shrink-0">
            <div className="text-base text-[var(--color-muted)]">Card Charges (Max overage)</div>
            <div className="text-xl font-bold text-red-400">${extraSpent.toFixed(2)}</div>
          </div>
          {extraLimit !== null && (
            <div className="flex-1 space-y-1 min-w-0">
              <div className="flex justify-between text-base text-[var(--color-muted)]">
                <span>${extraSpent.toFixed(2)} spent{extraPct !== null ? ` (${extraPct.toFixed(0)}%)` : ''}</span>
                <span>${extraLimit} limit{extraBalance !== null ? ` · $${extraBalance.toFixed(2)} balance` : ''}</span>
              </div>
              <div className="relative h-2 rounded bg-[var(--color-border)] overflow-hidden">
                <div
                  className="absolute inset-y-0 left-0 rounded bg-red-500"
                  style={{ width: `${extraPct ?? 0}%` }}
                />
              </div>
            </div>
          )}
          {extraReset && (
            <div className="shrink-0 text-base text-[var(--color-muted)]">Resets {extraReset}</div>
          )}
        </div>
      )}

      {/* Price book — provenance for every $ on this page */}
      <PriceBookPanel book={priceBook} />

      {/* Row: Token type pie + Cost type pie + Model donut + Cost donut */}
      <div className="grid grid-cols-4 gap-4">
        {/* Token type breakdown */}
        <div className="bg-[var(--color-surface)] rounded border border-[var(--color-border)] p-4">
          <h3 className="text-base font-bold mb-2 text-[var(--color-muted)]">
            Tokens by Type
          </h3>
          <Donut data={tokenTypePie} format={formatTokens} height={200} />
        </div>

        {/* Cost type breakdown */}
        <div className="bg-[var(--color-surface)] rounded border border-[var(--color-border)] p-4">
          <h3 className="text-base font-bold mb-2 text-[var(--color-muted)]">
            Cost by Type
          </h3>
          <Donut data={costTypePie} format={formatCost} height={200} />
        </div>

        {/* Model token breakdown donut */}
        <ModelDonut title="Tokens by Model" data={modelPie} format={formatTokens} />

        {/* Cost by model donut */}
        <ModelDonut title="Equivalent Cost by Model" data={costPie} format={formatCost} />
      </div>

      <ModelBreakdownTable modelBreakdown={modelBreakdown} totals={totals} />
    </>
  );
}
