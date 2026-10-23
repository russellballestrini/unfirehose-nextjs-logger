'use client';

import { useHashTab } from '@/lib/use-hash-tab';
import { fetcher } from '@unturf/unfirehose-ui/fetcher';

import { useMemo, useState } from 'react';
import useSWR from 'swr';
import { formatTokens } from '@unturf/unfirehose/format';
import { usageCacheHitRate } from '@unturf/unfirehose/vllm-metrics';
import { PageContext } from '@unturf/unfirehose-ui/PageContext';
import { TimeRangeSelect, useTimeRange } from '@unturf/unfirehose-ui/TimeRangeSelect';
import { shortModel, formatCost, tokensTabs, deriveExtraUsage, type TokensTab } from './_lib';
import { OverviewTab } from './_components/OverviewTab';
import { HarnessTab } from './_components/HarnessTab';
import { ToolsTab } from './_components/ToolsTab';
import { PlanTab } from './_components/PlanTab';
import { EmptyState } from '@unturf/unfirehose-ui/EmptyState';

/* eslint-disable @typescript-eslint/no-explicit-any */

export default function TokensPage() {
  const [range, setRange] = useTimeRange('tokens_range', '7d');
  // ?project=<name> from the URL pre-filters every chart + table to that
  // project. Read on mount; chip dismiss clears the URL param.
  const [projectFilter, setProjectFilter] = useState<string | null>(() => {
    if (typeof window === 'undefined') return null;
    const v = new URLSearchParams(window.location.search).get('project');
    return v ? decodeURIComponent(v) : null;
  });
  // The range goes over by name, the way the dashboard sends it. It used to
  // go as `from`, an instant computed once on mount, which the route then
  // had to snap back onto the range the worker stored — and a 7-day view
  // left open all afternoon asked for seven days and three hours. A name
  // means exactly one stored payload, and the SWR key is stable for free.
  const qs = useMemo(() => {
    const sp = new URLSearchParams();
    sp.set('range', range);
    if (projectFilter) sp.set('project', projectFilter);
    return `?${sp}`;
  }, [range, projectFilter]);

  const [activeTab, setActiveTab] = useHashTab<TokensTab>(tokensTabs, 'overview');

  const { data, error } = useSWR(`/api/tokens${qs}`, fetcher);
  const { data: planData } = useSWR('/api/usage/plan', fetcher);
  const { data: extraData, mutate: mutateExtra } = useSWR('/api/usage/extra', fetcher);
  // Must sit with the other hooks, above the early returns below: this one
  // was declared further down and so was skipped on the loading render,
  // changing the hook order between renders.
  //
  // vLLM measures the real cache hit rate for self-hosted models, which our
  // token accounting cannot see — a local model reports no cache_read tokens,
  // so the usage-based figure reads 0 for a cache that is working.
  const { data: vllmCache } = useSWR<any>('/api/inference/cache?hours=24', fetcher, {
    refreshInterval: 60_000,
  });
  // The price book behind every dollar figure on this page: which oracles,
  // how fresh, what moved, what could not be priced. A cost number without
  // its provenance is a guess with a decimal point.
  const { data: priceBook } = useSWR<any>('/api/pricing?summary=1', fetcher, {
    refreshInterval: 5 * 60_000,
  });

  if (error) {
    return (
      <div className="text-[var(--color-error)]">
        Failed to load: {String(error)}
      </div>
    );
  }
  if (!data) {
    return <div className="text-[var(--color-muted)]">Loading token data...</div>;
  }

  const {
    modelBreakdown = [],
    totalTokens = 0,
    totalCost = 0,
    totalInputCost = 0,
    totalOutputCost = 0,
    totalCacheReadCost = 0,
    totalCacheWriteCost = 0,
    totalInput = 0,
    totalOutput = 0,
    totalCacheRead = 0,
    totalCacheWrite = 0,
    toolCalls = [],
    toolsByModel = [],
    dailyActivity = [],
    blockTypes = [],
    harnessData = [],
    harnessModelBreakdown = [],
    harnessSessions = [],
    toolsByHarness = [],
    dailyByHarness = [],
  } = data;

  const totalToolCalls = toolCalls.reduce((s: number, t: any) => s + t.count, 0);
  // Nothing in this window: show what would be here instead of a page of
  // zeros. The plan tab reads its own endpoint and stays.
  const rangeEmpty = totalTokens === 0 && modelBreakdown.length === 0 && toolCalls.length === 0;
  const firstRun = rangeEmpty && data.hasAnyMessages === false;

  // Cache hit rate: cached tokens as a fraction of TOTAL prompt.
  //
  // This was `totalCacheRead / totalInput` rendered as "Nx", which is not a
  // rate — fresh input in the denominator instead of total prompt makes it
  // unbounded, so a 100% hit rate printed as "80209x". A reader cannot tell
  // that from a 900% one, and neither is a thing.
  const cacheHitPct = usageCacheHitRate(totalInput, totalCacheRead);
  const vllmModels: any[] = vllmCache?.models ?? [];

  // Extra usage (actual card charges) — hoisted so overview + plan tabs can
  // both use it. See deriveExtraUsage for why an expired snapshot is "no data".
  const extra = deriveExtraUsage(extraData);

  return (
    <div className="space-y-6">
      <PageContext
        pageType="token-usage"
        summary={`Token usage report. ${formatTokens(totalTokens)} total tokens, ${formatCost(totalCost)} equivalent cost at API rates. Cache hit rate: ${cacheHitPct == null ? 'n/a' : (cacheHitPct * 100).toFixed(1) + '%'} of prompt tokens served from cache. ${totalToolCalls.toLocaleString()} tool calls across ${toolCalls.length} tool types.`}
        metrics={{
          total_tokens: totalTokens,
          equivalent_cost_usd: totalCost.toFixed(2),
          input_cost_usd: totalInputCost.toFixed(2),
          output_cost_usd: totalOutputCost.toFixed(2),
          cache_read_cost_usd: totalCacheReadCost.toFixed(2),
          cache_write_cost_usd: totalCacheWriteCost.toFixed(2),
          input_tokens: totalInput,
          output_tokens: totalOutput,
          cache_read_tokens: totalCacheRead,
          cache_write_tokens: totalCacheWrite,
          cache_hit_rate_pct: cacheHitPct == null ? 'n/a' : (cacheHitPct * 100).toFixed(1),
          total_tool_calls: totalToolCalls,
          tool_types: toolCalls.length,
        }}
        details={[
          ...modelBreakdown.filter((m: any) => m.totalTokens > 0).map((m: any) =>
            `${shortModel(m.model)}: ${formatTokens(m.totalTokens)} tokens, ${formatCost(m.costUSD)} cost (input=${formatCost(m.inputCostUSD ?? 0)} output=${formatCost(m.outputCostUSD ?? 0)} cache_read=${formatCost(m.cacheReadCostUSD ?? 0)} cache_write=${formatCost(m.cacheWriteCostUSD ?? 0)}), input=${formatTokens(m.inputTokens)} output=${formatTokens(m.outputTokens)} cache_read=${formatTokens(m.cacheReadTokens)} cache_write=${formatTokens(m.cacheCreationTokens)}`
          ),
          '',
          'Top tool calls:',
          ...toolCalls.slice(0, 10).map((t: any) => `  ${t.tool_name}: ${t.count.toLocaleString()} calls`),
        ].join('\n')}
      />

      {/* Header */}
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div className="flex items-center gap-3 flex-wrap">
          <h2 className="text-lg font-bold">Tokens</h2>
          {projectFilter && (
            <button
              onClick={() => {
                setProjectFilter(null);
                if (typeof window !== 'undefined') {
                  const u = new URL(window.location.href);
                  u.searchParams.delete('project');
                  window.history.replaceState(null, '', u.toString());
                }
              }}
              className="px-2 py-0.5 rounded border border-[var(--color-accent)] text-sm text-[var(--color-accent)] hover:bg-[var(--color-accent)]/10 flex items-center gap-1"
              title="Remove project filter"
            >
              project: {projectFilter} <span className="opacity-60">×</span>
            </button>
          )}
        </div>
        <TimeRangeSelect value={range} onChange={setRange} />
      </div>

      {/* Tabs */}
      <div className="flex items-center gap-0.5 border-b border-[var(--color-border)]">
        {([
          { id: 'overview' as const, label: 'Overview', icon: '¤' },
          { id: 'harness' as const, label: 'Harness', icon: '◈' },
          { id: 'tools' as const, label: 'Tools', icon: '⚙' },
          { id: 'plan' as const, label: 'Plan', icon: '◎' },
        ]).map(tab => (
          <button
            key={tab.id}
            onClick={() => setActiveTab(tab.id)}
            className={`px-4 py-2 text-base rounded-t border-b-2 transition-colors cursor-pointer ${
              activeTab === tab.id
                ? 'border-[var(--color-accent)] text-[var(--color-foreground)] font-bold'
                : 'border-transparent text-[var(--color-muted)] hover:text-[var(--color-foreground)]'
            }`}
          >
            <span className={activeTab === tab.id ? 'text-[var(--color-accent)]' : ''}>{tab.icon}</span>
            <span className="ml-1.5">{tab.label}</span>
          </button>
        ))}
      </div>

      {rangeEmpty && activeTab !== 'plan' && (firstRun ? (
        <EmptyState
          what="Tokens, cost by model, harness and tool will appear here."
          action="Every message a harness logs lands here within a minute. Start a session in any git repo:"
          command="cd ~/your/repo && claude"
          link={{ href: '/schema', label: 'Other harnesses: adapter docs' }}
        />
      ) : (
        <EmptyState
          kind="quiet"
          what={projectFilter ? `No tokens for ${projectFilter} in range.` : 'No tokens in range.'}
          range={range}
          onWiden={range === 'all' ? undefined : () => setRange('all')}
          action={range === 'all' ? 'Nothing this project logged carried token counts.' : undefined}
        />
      ))}

      {/* ============ OVERVIEW TAB ============ */}
      {!rangeEmpty && activeTab === 'overview' && (
        <OverviewTab
          totals={{
            totalTokens, totalCost, totalInputCost, totalOutputCost, totalCacheReadCost,
            totalCacheWriteCost, totalInput, totalOutput, totalCacheRead, totalCacheWrite,
          }}
          modelBreakdown={modelBreakdown}
          cacheHitPct={cacheHitPct}
          vllmModels={vllmModels}
          extra={extra}
          priceBook={priceBook}
        />
      )}

      {/* ============ HARNESS TAB ============ */}
      {!rangeEmpty && activeTab === 'harness' && (
        <HarnessTab
          harnessData={harnessData}
          harnessModelBreakdown={harnessModelBreakdown}
          harnessSessions={harnessSessions}
          dailyByHarness={dailyByHarness}
        />
      )}

      {/* ============ TOOLS TAB ============ */}
      {!rangeEmpty && activeTab === 'tools' && (
        <ToolsTab
          toolCalls={toolCalls}
          totalToolCalls={totalToolCalls}
          toolsByModel={toolsByModel}
          blockTypes={blockTypes}
          toolsByHarness={toolsByHarness}
          dailyActivity={dailyActivity}
        />
      )}

      {/* ============ PLAN TAB ============ */}
      {activeTab === 'plan' && (
        <PlanTab planData={planData} extraData={extraData} extra={extra} mutateExtra={mutateExtra} />
      )}
    </div>
  );
}
