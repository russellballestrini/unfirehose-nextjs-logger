'use client';

import { StatCard } from '@unturf/unfirehose-ui/StatCard';
import { EmptyState } from '@unturf/unfirehose-ui/EmptyState';
import { UPlotCategoryChart } from '@/components/UPlotCategoryChart';
import { formatCost, planLabel, type ExtraUsage } from '../_lib';

/* eslint-disable @typescript-eslint/no-explicit-any */

export function PlanTab({ planData, extraData, extra, mutateExtra }: {
  planData: any;
  extraData: any;
  extra: ExtraUsage;
  mutateExtra: () => unknown;
}) {
  const { extraExpired, extraSpent, extraLimit, extraBalance, extraReset, extraPct } = extra;
  return (
    <>
      {!planData ? (
        <div className="text-[var(--color-muted)]">Loading plan data...</div>
      ) : (() => {
        const {
          subscriptionType,
          rateLimitTier,
          hasExtraUsageEnabled,
          monthlyPlanCost,
          periodStart,
          periodEnd,
          periodCostUSD,
          dailyCost = [],
        } = planData;

        const planCap = monthlyPlanCost ?? 0;
        const overageEst = Math.max(0, periodCostUSD - planCap);
        const pct = planCap > 0 ? Math.min(100, (periodCostUSD / planCap) * 100) : 0;
        const isOver = periodCostUSD > planCap;

        // Running cumulative for line chart
        let running = 0;
        const cumulativeData = dailyCost.map((d: any) => {
          running += d.costUSD;
          return { date: d.date, daily: d.costUSD, cumulative: running };
        });

        // Extra usage — use hoisted values computed at component level
        const extraUpdated = extraData?.extraUpdatedAt ?? null;

        return (
          <div className="space-y-6">

            {/* Actual card charges — from bookmarklet sync */}
            <div className="bg-[var(--color-surface)] rounded border border-[var(--color-border)] p-4 space-y-3">
              <div className="flex items-center justify-between">
                <h3 className="text-base font-bold text-[var(--color-muted)]">
                  Actual Extra Usage (Card Charges)
                </h3>
                {extraUpdated && (
                  <span className="text-base text-[var(--color-muted)]">
                    synced {new Date(extraUpdated).toLocaleString()}
                  </span>
                )}
              </div>

              {extraSpent !== null ? (
                <>
                  <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
                    <StatCard label="Spent" value={`$${extraSpent.toFixed(2)}`} color="#ef4444" sub="charged to card" />
                    <StatCard label="Monthly Limit" value={extraLimit !== null ? `$${extraLimit}` : '—'} sub="extra usage cap" />
                    <StatCard label="Balance" value={extraBalance !== null ? `$${extraBalance.toFixed(2)}` : '—'} sub="remaining credits" />
                    <StatCard label="Resets" value={extraReset ?? '—'} sub="billing period end" />
                  </div>
                  {extraPct !== null && extraLimit !== null && (
                    <div className="space-y-1">
                      <div className="flex justify-between text-base text-[var(--color-muted)]">
                        <span>$0</span>
                        <span className="font-bold text-red-400">${extraSpent.toFixed(2)} spent ({extraPct.toFixed(0)}%)</span>
                        <span>${extraLimit} limit</span>
                      </div>
                      <div className="relative h-4 rounded bg-[var(--color-border)] overflow-hidden">
                        <div
                          className="absolute inset-y-0 left-0 rounded bg-red-500"
                          style={{ width: `${extraPct}%` }}
                        />
                      </div>
                    </div>
                  )}
                </>
              ) : extraExpired ? (
                <p className="text-base text-[var(--color-muted)]">
                  Last sync covered a billing period that ended
                  {extraData?.resetAt ? ` ${new Date(extraData.resetAt).toLocaleDateString()}` : ''}
                  {extraData?.extraSpent ? ` ($${parseFloat(extraData.extraSpent).toFixed(2)} of $${extraData.extraLimit ?? '?'} then)` : ''}.
                  Nothing is known about our current period — visit{' '}
                  <a href="https://claude.ai/settings/usage" target="_blank" rel="noopener noreferrer"
                    className="text-[var(--color-accent)] hover:underline">
                    claude.ai/settings/usage
                  </a>
                  {' '}to re-sync.
                </p>
              ) : (
                <EmptyState
                  compact
                  what="Our actual extra-usage card charges will appear here."
                  action="Drag the bookmarklet below to your browser bar, then click it on our usage page to sync them."
                  link={{ href: 'https://claude.ai/settings/usage', label: 'claude.ai/settings/usage' }}
                />
              )}

              {/* Extension install instructions */}
              <div className="pt-2 border-t border-[var(--color-border)] text-base text-[var(--color-muted)]">
                Auto-syncs when you visit{' '}
                <a href="https://claude.ai/settings/usage" target="_blank" rel="noopener noreferrer"
                  className="text-[var(--color-accent)] hover:underline">
                  claude.ai/settings/usage
                </a>
                {' '}— requires the{' '}
                <a href="https://claude.ai/settings/usage" target="_blank" rel="noopener noreferrer"
                  className="text-[var(--color-accent)] hover:underline">
                  unfirehose browser extension
                </a>
                {' '}(Chrome/Firefox/Brave: load unpacked from <code>apps/extension/</code>).
                <button
                  className="ml-3 px-2 py-0.5 text-base border border-[var(--color-border)] rounded hover:text-[var(--color-foreground)]"
                  onClick={() => mutateExtra()}
                >
                  refresh
                </button>
              </div>
            </div>

            {/* Plan identity */}
            <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
              <StatCard
                label="Plan"
                value={planLabel(rateLimitTier)}
                sub={subscriptionType}
              />
              <StatCard
                label="Monthly Plan Value"
                value={planCap > 0 ? `$${planCap}` : '—'}
                sub="included usage"
              />
              <StatCard
                label="Extra Usage"
                value={hasExtraUsageEnabled ? 'Enabled' : 'Disabled'}
                sub={hasExtraUsageEnabled ? 'overage billed to card' : 'hard stop at limit'}
                color={hasExtraUsageEnabled ? '#f59e0b' : undefined}
              />
              <StatCard
                label="Billing Period"
                value={periodStart ? periodStart.slice(0, 7) : '—'}
                // The headline already guards for a missing period; this
                // line did not, and rendered the word "undefined" twice.
                sub={periodStart && periodEnd ? `${periodStart} → ${periodEnd}` : 'no period reported'}
              />
            </div>

            {/* Budget utilization bar */}
            <div className="bg-[var(--color-surface)] rounded border border-[var(--color-border)] p-4 space-y-3">
              <div className="flex items-center justify-between">
                <h3 className="text-base font-bold text-[var(--color-muted)]">
                  Equivalent API Cost This Period
                </h3>
                <a
                  href="https://claude.ai/settings/usage"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-base text-[var(--color-accent)] hover:underline"
                >
                  View actual billing ↗
                </a>
              </div>

              {/* Budget bar */}
              {planCap > 0 && (
                <div className="space-y-1">
                  <div className="flex justify-between text-base text-[var(--color-muted)]">
                    <span>$0</span>
                    <span className="text-[var(--color-foreground)] font-bold">
                      {formatCost(periodCostUSD)} used
                    </span>
                    <span>${planCap} plan</span>
                  </div>
                  <div className="relative h-6 rounded bg-[var(--color-border)] overflow-hidden">
                    {/* Plan band */}
                    <div
                      className="absolute inset-y-0 left-0 rounded"
                      style={{
                        width: `${Math.min(100, pct)}%`,
                        background: isOver ? '#ef4444' : '#10b981',
                      }}
                    />
                    {/* Plan limit marker */}
                    {isOver && (
                      <div
                        className="absolute inset-y-0 w-0.5 bg-white opacity-60"
                        style={{ left: `${(planCap / periodCostUSD) * 100}%` }}
                      />
                    )}
                  </div>
                  {isOver && (
                    <div className="flex items-center gap-2 text-base text-red-400 font-bold">
                      <span>▲</span>
                      <span>
                        {formatCost(overageEst)} over plan ({formatCost(planCap)} included + {formatCost(overageEst)} overage equivalent)
                      </span>
                    </div>
                  )}
                </div>
              )}

              {/* Big numbers */}
              <div className="grid grid-cols-2 md:grid-cols-4 gap-4 pt-2">
                <div>
                  <div className="text-base text-[var(--color-muted)]">Included (plan value)</div>
                  <div className="text-2xl font-bold text-[#10b981]">
                    {planCap > 0 ? formatCost(Math.min(periodCostUSD, planCap)) : '—'}
                  </div>
                </div>
                <div>
                  <div className="text-base text-[var(--color-muted)]">Overage equivalent</div>
                  <div className={`text-2xl font-bold ${overageEst > 0 ? 'text-red-400' : 'text-[var(--color-muted)]'}`}>
                    {overageEst > 0 ? formatCost(overageEst) : '$0.00'}
                  </div>
                </div>
                <div>
                  <div className="text-base text-[var(--color-muted)]">Total equivalent</div>
                  <div className="text-2xl font-bold">{formatCost(periodCostUSD)}</div>
                </div>
                <div>
                  <div className="text-base text-[var(--color-muted)]">Actual card charges</div>
                  <div className={`text-2xl font-bold ${extraSpent !== null ? 'text-red-400' : 'text-[var(--color-muted)]'}`}>
                    {extraSpent !== null ? `$${extraSpent.toFixed(2)}` : '—'}
                  </div>
                  {extraLimit !== null && (
                    <div className="text-base text-[var(--color-muted)]">of ${extraLimit} limit</div>
                  )}
                </div>
              </div>

              <p className="text-base text-[var(--color-muted)] pt-1 border-t border-[var(--color-border)]">
                Equivalent API rate cost — actual Max plan billing differs.
                Anthropic weighs messages, not just tokens.{' '}
                <a
                  href="https://claude.ai/settings/usage"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-[var(--color-accent)] hover:underline"
                >
                  See actual charges at claude.ai/settings/usage ↗
                </a>
              </p>
            </div>

            {/* Daily cost chart */}
            {cumulativeData.length > 0 && (
              <div className="bg-[var(--color-surface)] rounded border border-[var(--color-border)] p-4">
                <h3 className="text-base font-bold mb-3 text-[var(--color-muted)]">
                  Daily & Cumulative Cost — {periodStart?.slice(0, 7)}
                </h3>
                <UPlotCategoryChart
                  data={cumulativeData}
                  labelKey="date"
                  legend
                  series={[
                    { key: 'daily', label: 'Daily cost', color: isOver ? '#ef4444' : '#10b981' },
                    { key: 'cumulative', label: 'Cumulative', color: '#a78bfa', kind: 'lines', axis: 'right' },
                  ]}
                  height={260}
                  format={formatCost}
                  formatRight={formatCost}
                  tick={(d) => d.slice(5)}
                  refLines={extraSpent !== null ? [{ value: extraSpent, color: '#ef4444', label: `$${extraSpent.toFixed(0)} actual`, axis: 'right' }] : undefined}
                />
              </div>
            )}
          </div>
        );
      })()}
    </>
  );
}
