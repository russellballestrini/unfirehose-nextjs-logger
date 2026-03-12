'use client';

import { useMemo, useState } from 'react';
import useSWR from 'swr';
import { formatTokens } from '@unturf/unfirehose/format';
import { PageContext } from '@unturf/unfirehose-ui/PageContext';
import { TimeRangeSelect, useTimeRange, getTimeRangeFrom } from '@unturf/unfirehose-ui/TimeRangeSelect';
import {
  BarChart,
  Bar,
  XAxis,
  YAxis,
  Tooltip,
  ResponsiveContainer,
  Legend,
  PieChart,
  Pie,
  Cell,
  LineChart,
  Line,
} from 'recharts';

/* eslint-disable @typescript-eslint/no-explicit-any */

const fetcher = (url: string) => fetch(url).then((r) => r.json());


const HARNESS_COLORS: Record<string, string> = {
  'claude-code': '#a78bfa',
  'fetch': '#60a5fa',
  'uncloseai': '#fbbf24',
  'hermes': '#10b981',
  'agnt': '#f472b6',
  'unknown': '#6b7280',
};

function getHarnessColor(harness: string): string {
  return HARNESS_COLORS[harness] ?? '#6b7280';
}

const MODEL_COLORS: Record<string, string> = {
  'claude-opus-4-6': '#a78bfa',
  'claude-opus-4-5-20251101': '#818cf8',
  'claude-sonnet-4-5-20250929': '#34d399',
  'claude-sonnet-4-6': '#10b981',
  'claude-haiku-4-5-20251001': '#fbbf24',
};

const TOKEN_TYPE_COLORS = {
  input: '#60a5fa',
  output: '#a78bfa',
  cacheRead: '#10b981',
  cacheWrite: '#f472b6',
};

const TOOL_COLORS = [
  '#10b981', '#a78bfa', '#60a5fa', '#fbbf24', '#f472b6',
  '#34d399', '#818cf8', '#38bdf8', '#fb923c', '#e879f9',
  '#2dd4bf', '#f87171', '#84cc16', '#22d3ee', '#facc15',
];

function shortModel(model: string): string {
  return model.replace('claude-', '').replace(/-\d{8}$/, '');
}

function getModelColor(model: string): string {
  return MODEL_COLORS[model] ?? '#6b7280';
}

function formatCost(usd: number): string {
  if (usd >= 1000) return `$${(usd / 1000).toFixed(1)}K`;
  return `$${usd.toFixed(2)}`;
}


const tokensTabs = ['overview', 'harness', 'tools', 'plan'] as const;
type TokensTab = (typeof tokensTabs)[number];

function planLabel(rateLimitTier: string): string {
  if (rateLimitTier.includes('max_20x')) return 'Max 20x';
  if (rateLimitTier.includes('max_5x'))  return 'Max 5x';
  if (rateLimitTier.includes('pro'))     return 'Pro';
  return rateLimitTier || 'Unknown';
}

export default function TokensPage() {
  const [range, setRange] = useTimeRange('tokens_range', '7d');
  // Memoize `from` so the SWR key stays stable across re-renders.
  // getTimeRangeFrom calls Date.now() — without memoization, each render
  // produces a new timestamp, giving SWR a new key, causing infinite re-fetches.
  const from = useMemo(() => getTimeRangeFrom(range), [range]);
  const qs = from ? `?from=${encodeURIComponent(from)}` : '';

  const [activeTab, setActiveTabRaw] = useState<TokensTab>(() => {
    if (typeof globalThis !== 'undefined' && globalThis.location) {
      const hash = globalThis.location.hash.slice(1) as TokensTab;
      if (tokensTabs.includes(hash)) return hash;
    }
    return 'overview';
  });
  const setActiveTab = (tab: TokensTab) => {
    setActiveTabRaw(tab);
    globalThis.location.hash = tab;
  };

  const { data, error } = useSWR(`/api/tokens${qs}`, fetcher);
  const { data: planData } = useSWR('/api/usage/plan', fetcher);

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

  // Data for token type pie chart
  const tokenTypePie = [
    { name: 'Input', value: totalInput, color: TOKEN_TYPE_COLORS.input },
    { name: 'Output', value: totalOutput, color: TOKEN_TYPE_COLORS.output },
    { name: 'Cache Read', value: totalCacheRead, color: TOKEN_TYPE_COLORS.cacheRead },
    { name: 'Cache Write', value: totalCacheWrite, color: TOKEN_TYPE_COLORS.cacheWrite },
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
      value: m.costUSD,
      color: getModelColor(m.model),
    }));

  // Top 12 tool calls for pie chart, rest as "other"
  const topTools = toolCalls.slice(0, 12);
  const otherTools = toolCalls.slice(12);
  const toolPieData = [
    ...topTools.map((t: any, i: number) => ({
      name: t.tool_name,
      value: t.count,
      color: TOOL_COLORS[i % TOOL_COLORS.length],
    })),
    ...(otherTools.length > 0
      ? [{
          name: 'other',
          value: otherTools.reduce((s: number, t: any) => s + t.count, 0),
          color: '#52525b',
        }]
      : []),
  ];

  const totalToolCalls = toolCalls.reduce((s: number, t: any) => s + t.count, 0);

  // Cache efficiency: ratio of cache reads to fresh input
  const cacheRatio = totalInput > 0 ? totalCacheRead / totalInput : 0;

  return (
    <div className="space-y-6">
      <PageContext
        pageType="token-usage"
        summary={`Token usage report. ${formatTokens(totalTokens)} total tokens, ${formatCost(totalCost)} equivalent cost at API rates. Cache efficiency: ${cacheRatio.toFixed(0)}x. ${totalToolCalls.toLocaleString()} tool calls across ${toolCalls.length} tool types.`}
        metrics={{
          total_tokens: totalTokens,
          equivalent_cost_usd: totalCost.toFixed(2),
          input_tokens: totalInput,
          output_tokens: totalOutput,
          cache_read_tokens: totalCacheRead,
          cache_write_tokens: totalCacheWrite,
          cache_efficiency_ratio: `${cacheRatio.toFixed(0)}x`,
          total_tool_calls: totalToolCalls,
          tool_types: toolCalls.length,
        }}
        details={[
          ...modelBreakdown.filter((m: any) => m.totalTokens > 0).map((m: any) =>
            `${shortModel(m.model)}: ${formatTokens(m.totalTokens)} tokens, ${formatCost(m.costUSD)} cost, input=${formatTokens(m.inputTokens)} output=${formatTokens(m.outputTokens)} cache_read=${formatTokens(m.cacheReadTokens)} cache_write=${formatTokens(m.cacheCreationTokens)}`
          ),
          '',
          'Top tool calls:',
          ...toolCalls.slice(0, 10).map((t: any) => `  ${t.tool_name}: ${t.count.toLocaleString()} calls`),
        ].join('\n')}
      />

      {/* Header */}
      <div className="flex items-center justify-between">
        <h2 className="text-lg font-bold">Tokens</h2>
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

      {/* ============ OVERVIEW TAB ============ */}
      {activeTab === 'overview' && (<>

      {/* Summary cards */}
      <div className="grid grid-cols-5 gap-4">
        <StatCard label="Total Tokens" value={formatTokens(totalTokens)} />
        <StatCard label="Equivalent Cost" value={formatCost(totalCost)} sub="at API rates" />
        <StatCard label="Input" value={formatTokens(totalInput)} color="var(--color-user)" />
        <StatCard label="Output" value={formatTokens(totalOutput)} color="var(--color-thinking)" />
        <StatCard
          label="Cache Efficiency"
          value={`${cacheRatio.toFixed(0)}x`}
          sub={`${formatTokens(totalCacheRead)} reads / ${formatTokens(totalInput)} fresh`}
        />
      </div>

      {/* Row: Token type pie + Model donut + Cost donut */}
      <div className="grid grid-cols-3 gap-4">
        {/* Token type breakdown */}
        <div className="bg-[var(--color-surface)] rounded border border-[var(--color-border)] p-4">
          <h3 className="text-base font-bold mb-2 text-[var(--color-muted)]">
            Token Types
          </h3>
          <ResponsiveContainer width="100%" height={200}>
            <PieChart>
              <Pie
                data={tokenTypePie}
                dataKey="value"
                nameKey="name"
                cx="50%"
                cy="50%"
                innerRadius={35}
                outerRadius={75}
                strokeWidth={0}
              >
                {tokenTypePie.map((d, i) => (
                  <Cell key={i} fill={d.color} />
                ))}
              </Pie>
              <Tooltip

                formatter={(v) => formatTokens(Number(v ?? 0))}
              />
              <Legend
                iconSize={8}
                wrapperStyle={{ fontSize: 16 }}
              />
            </PieChart>
          </ResponsiveContainer>
        </div>

        {/* Model token breakdown donut */}
        <div className="bg-[var(--color-surface)] rounded border border-[var(--color-border)] p-4">
          <h3 className="text-base font-bold mb-2 text-[var(--color-muted)]">
            Tokens by Model
          </h3>
          <ResponsiveContainer width="100%" height={200}>
            <PieChart>
              <Pie
                data={modelPie}
                dataKey="value"
                nameKey="name"
                cx="50%"
                cy="50%"
                innerRadius={35}
                outerRadius={75}
                strokeWidth={0}
              >
                {modelPie.map((d: any, i: number) => (
                  <Cell key={i} fill={d.color} />
                ))}
              </Pie>
              <Tooltip

                formatter={(v) => formatTokens(Number(v ?? 0))}
              />
              <Legend
                iconSize={8}
                wrapperStyle={{ fontSize: 16 }}
              />
            </PieChart>
          </ResponsiveContainer>
        </div>

        {/* Cost by model donut */}
        <div className="bg-[var(--color-surface)] rounded border border-[var(--color-border)] p-4">
          <h3 className="text-base font-bold mb-2 text-[var(--color-muted)]">
            Equivalent Cost by Model
          </h3>
          <ResponsiveContainer width="100%" height={200}>
            <PieChart>
              <Pie
                data={costPie}
                dataKey="value"
                nameKey="name"
                cx="50%"
                cy="50%"
                innerRadius={35}
                outerRadius={75}
                strokeWidth={0}
              >
                {costPie.map((d: any, i: number) => (
                  <Cell key={i} fill={d.color} />
                ))}
              </Pie>
              <Tooltip

                formatter={(v) => formatCost(Number(v ?? 0))}
              />
              <Legend
                iconSize={8}
                wrapperStyle={{ fontSize: 16 }}
              />
            </PieChart>
          </ResponsiveContainer>
        </div>
      </div>

      {/* Model breakdown table */}
      <div className="bg-[var(--color-surface)] rounded border border-[var(--color-border)] p-4">
        <h3 className="text-base font-bold mb-3 text-[var(--color-muted)]">
          Per-Model Breakdown
        </h3>
        <table className="w-full text-base">
          <thead>
            <tr className="text-[var(--color-muted)] text-left border-b border-[var(--color-border)]">
              <th className="pb-2">Model</th>
              <th className="pb-2 text-right">Input</th>
              <th className="pb-2 text-right">Output</th>
              <th className="pb-2 text-right">Cache Read</th>
              <th className="pb-2 text-right">Cache Write</th>
              <th className="pb-2 text-right">Total</th>
              <th className="pb-2 text-right">Cost (equiv)</th>
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
                  <td className="py-2 text-right text-[var(--color-accent)]">
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
              <td className="py-2 text-right text-[var(--color-accent)]">{formatCost(totalCost)}</td>
            </tr>
          </tbody>
        </table>
      </div>

      </>)}

      {/* ============ HARNESS TAB ============ */}
      {activeTab === 'harness' && (<>

      <h3 className="text-base text-[var(--color-muted)]">
        Token usage split by originating harness (claude-code, fetch, uncloseai, hermes, agnt)
      </h3>

      {/* Harness stat cards */}
      {harnessData && harnessData.length > 0 && (
        <div className="grid grid-cols-5 gap-4">
          {harnessData
            .filter((h: any) => h.totalTokens > 0)
            .sort((a: any, b: any) => b.totalTokens - a.totalTokens)
            .slice(0, 5)
            .map((h: any) => {
              const sessions = (harnessSessions ?? []).find((s: any) => s.harness === h.harness);
              return (
                <div key={h.harness} className="bg-[var(--color-surface)] rounded border border-[var(--color-border)] p-4">
                  <div className="flex items-center gap-2 mb-1">
                    <span
                      className="inline-block w-2 h-2 rounded-full shrink-0"
                      style={{ background: getHarnessColor(h.harness) }}
                    />
                    <span className="text-base text-[var(--color-muted)]">{h.harness}</span>
                  </div>
                  <div className="text-2xl font-bold">{formatTokens(h.totalTokens)}</div>
                  <div className="text-base text-[var(--color-muted)] mt-1">
                    {formatCost(h.costUSD)} · {sessions?.sessions ?? 0} sessions · {h.cacheEfficiency.toFixed(0)}x cache
                  </div>
                </div>
              );
            })}
        </div>
      )}

      {/* Row: Harness charts */}
      {harnessData && harnessData.length > 0 ? (
        <div className="grid grid-cols-3 gap-4">
          {/* Tokens by Harness donut */}
          <div className="bg-[var(--color-surface)] rounded border border-[var(--color-border)] p-4">
            <h3 className="text-base font-bold mb-2 text-[var(--color-muted)]">
              Tokens by Harness
            </h3>
            <ResponsiveContainer width="100%" height={200}>
              <PieChart>
                <Pie
                  data={harnessData.filter((h: any) => h.totalTokens > 0).map((h: any) => ({
                    name: h.harness,
                    value: h.totalTokens,
                    color: getHarnessColor(h.harness),
                  }))}
                  dataKey="value"
                  nameKey="name"
                  cx="50%"
                  cy="50%"
                  innerRadius={35}
                  outerRadius={75}
                  strokeWidth={0}
                >
                  {harnessData.filter((h: any) => h.totalTokens > 0).map((h: any, i: number) => (
                    <Cell key={i} fill={getHarnessColor(h.harness)} />
                  ))}
                </Pie>
                <Tooltip formatter={(v) => formatTokens(Number(v ?? 0))} />
                <Legend iconSize={8} wrapperStyle={{ fontSize: 16 }} />
              </PieChart>
            </ResponsiveContainer>
          </div>

          {/* Cost by Harness donut */}
          <div className="bg-[var(--color-surface)] rounded border border-[var(--color-border)] p-4">
            <h3 className="text-base font-bold mb-2 text-[var(--color-muted)]">
              Cost by Harness
            </h3>
            <ResponsiveContainer width="100%" height={200}>
              <PieChart>
                <Pie
                  data={harnessData.filter((h: any) => h.costUSD > 0).map((h: any) => ({
                    name: h.harness,
                    value: h.costUSD,
                    color: getHarnessColor(h.harness),
                  }))}
                  dataKey="value"
                  nameKey="name"
                  cx="50%"
                  cy="50%"
                  innerRadius={35}
                  outerRadius={75}
                  strokeWidth={0}
                >
                  {harnessData.filter((h: any) => h.costUSD > 0).map((h: any, i: number) => (
                    <Cell key={i} fill={getHarnessColor(h.harness)} />
                  ))}
                </Pie>
                <Tooltip formatter={(v) => formatCost(Number(v ?? 0))} />
                <Legend iconSize={8} wrapperStyle={{ fontSize: 16 }} />
              </PieChart>
            </ResponsiveContainer>
          </div>

          {/* Harness × Model stacked bar */}
          <div className="bg-[var(--color-surface)] rounded border border-[var(--color-border)] p-4">
            <h3 className="text-base font-bold mb-2 text-[var(--color-muted)]">
              Harness × Model
            </h3>
            {(() => {
              const harnesses = [...new Set((harnessModelBreakdown ?? []).map((r: any) => r.harness))] as string[];
              const models = [...new Set((harnessModelBreakdown ?? []).map((r: any) => r.model))] as string[];
              const barData = harnesses.map((h) => {
                const row: any = { harness: h };
                for (const m of models) {
                  const match = (harnessModelBreakdown ?? []).find((r: any) => r.harness === h && r.model === m);
                  if (match) {
                    row[m] = match.input_tokens + match.output_tokens + match.cache_read_tokens + match.cache_creation_tokens;
                  }
                }
                return row;
              });
              return (
                <ResponsiveContainer width="100%" height={200}>
                  <BarChart data={barData} layout="vertical" margin={{ left: 10 }}>
                    <XAxis
                      type="number"
                      tick={{ fill: '#71717a', fontSize: 16 }}
                      tickFormatter={(v: number) => formatTokens(v)}
                    />
                    <YAxis
                      type="category"
                      dataKey="harness"
                      tick={{ fill: '#a1a1aa', fontSize: 16 }}
                      width={100}
                      interval={0}
                    />
                    <Tooltip formatter={(v) => formatTokens(Number(v ?? 0))} />
                    <Legend iconSize={8} wrapperStyle={{ fontSize: 16 }} />
                    {models.map((m) => (
                      <Bar
                        key={m}
                        dataKey={m}
                        name={shortModel(m)}
                        stackId="a"
                        fill={getModelColor(m)}
                      />
                    ))}
                  </BarChart>
                </ResponsiveContainer>
              );
            })()}
          </div>
        </div>
      ) : (
        <div className="bg-[var(--color-surface)] rounded border border-[var(--color-border)] p-4 text-[var(--color-muted)] text-base">
          No harness data yet. Sessions need the <code>harness</code> field populated during ingestion.
        </div>
      )}

      {/* Daily tokens by harness */}
      {dailyByHarness && dailyByHarness.length > 0 && (
        <div className="bg-[var(--color-surface)] rounded border border-[var(--color-border)] p-4">
          <h3 className="text-base font-bold mb-3 text-[var(--color-muted)]">
            Daily Tokens by Harness
          </h3>
          {(() => {
            // Pivot: { date, claude-code: N, fetch: N, uncloseai: N, ... }
            const harnesses = [...new Set(dailyByHarness.map((r: any) => r.harness))] as string[];
            const byDate: Record<string, any> = {};
            for (const r of dailyByHarness) {
              if (!byDate[r.date]) byDate[r.date] = { date: r.date };
              byDate[r.date][r.harness] = r.tokens;
            }
            const chartData = Object.values(byDate).slice(-30);
            return (
              <ResponsiveContainer width="100%" height={250}>
                <BarChart data={chartData}>
                  <XAxis
                    dataKey="date"
                    tick={{ fill: '#71717a', fontSize: 16 }}
                    tickFormatter={(d: string) => d.slice(5)}
                  />
                  <YAxis
                    tick={{ fill: '#71717a', fontSize: 16 }}
                    tickFormatter={(v: number) => formatTokens(v)}
                  />
                  <Tooltip formatter={(v) => formatTokens(Number(v ?? 0))} />
                  <Legend iconSize={8} wrapperStyle={{ fontSize: 16 }} />
                  {harnesses.map((h) => (
                    <Bar key={h} dataKey={h} stackId="a" fill={getHarnessColor(h)} />
                  ))}
                </BarChart>
              </ResponsiveContainer>
            );
          })()}
        </div>
      )}

      {/* Harness breakdown table */}
      {harnessData && harnessData.length > 0 && (
        <div className="bg-[var(--color-surface)] rounded border border-[var(--color-border)] p-4">
          <h3 className="text-base font-bold mb-3 text-[var(--color-muted)]">
            Per-Harness Breakdown
          </h3>
          <table className="w-full text-base">
            <thead>
              <tr className="text-[var(--color-muted)] text-left border-b border-[var(--color-border)]">
                <th className="pb-2">Harness</th>
                <th className="pb-2 text-right">Sessions</th>
                <th className="pb-2 text-right">Input</th>
                <th className="pb-2 text-right">Output</th>
                <th className="pb-2 text-right">Cache Read</th>
                <th className="pb-2 text-right">Cache Write</th>
                <th className="pb-2 text-right">Total</th>
                <th className="pb-2 text-right">Cache Eff</th>
                <th className="pb-2 text-right">Cost (equiv)</th>
              </tr>
            </thead>
            <tbody>
              {harnessData
                .filter((h: any) => h.totalTokens > 0)
                .sort((a: any, b: any) => b.totalTokens - a.totalTokens)
                .map((h: any) => {
                  const sessions = (harnessSessions ?? []).find((s: any) => s.harness === h.harness);
                  return (
                    <tr key={h.harness} className="border-b border-[var(--color-border)]">
                      <td className="py-2 flex items-center gap-2">
                        <span
                          className="inline-block w-2 h-2 rounded-full shrink-0"
                          style={{ background: getHarnessColor(h.harness) }}
                        />
                        {h.harness}
                      </td>
                      <td className="py-2 text-right">{sessions?.sessions ?? 0}</td>
                      <td className="py-2 text-right" style={{ color: TOKEN_TYPE_COLORS.input }}>
                        {formatTokens(h.inputTokens)}
                      </td>
                      <td className="py-2 text-right" style={{ color: TOKEN_TYPE_COLORS.output }}>
                        {formatTokens(h.outputTokens)}
                      </td>
                      <td className="py-2 text-right" style={{ color: TOKEN_TYPE_COLORS.cacheRead }}>
                        {formatTokens(h.cacheReadTokens)}
                      </td>
                      <td className="py-2 text-right" style={{ color: TOKEN_TYPE_COLORS.cacheWrite }}>
                        {formatTokens(h.cacheCreationTokens)}
                      </td>
                      <td className="py-2 text-right font-bold">
                        {formatTokens(h.totalTokens)}
                      </td>
                      <td className="py-2 text-right">
                        {h.cacheEfficiency.toFixed(0)}x
                      </td>
                      <td className="py-2 text-right text-[var(--color-accent)]">
                        {formatCost(h.costUSD)}
                      </td>
                    </tr>
                  );
                })}
            </tbody>
          </table>
        </div>
      )}

      </>)}

      {/* ============ TOOLS TAB ============ */}
      {activeTab === 'tools' && (<>

      {/* Top tools by harness */}
      {toolsByHarness && toolsByHarness.length > 0 && (
        <div className="bg-[var(--color-surface)] rounded border border-[var(--color-border)] p-4">
          <h3 className="text-base font-bold mb-3 text-[var(--color-muted)]">
            Top Tools by Harness
          </h3>
          {(() => {
            // Group by harness, show top 5 tools each
            const grouped: Record<string, { tool_name: string; count: number }[]> = {};
            for (const r of toolsByHarness) {
              if (!grouped[r.harness]) grouped[r.harness] = [];
              if (grouped[r.harness].length < 5) grouped[r.harness].push(r);
            }
            return (
              <div className="grid grid-cols-3 gap-4">
                {Object.entries(grouped).map(([harness, tools]) => (
                  <div key={harness}>
                    <div className="flex items-center gap-2 mb-2">
                      <span
                        className="inline-block w-2 h-2 rounded-full shrink-0"
                        style={{ background: getHarnessColor(harness) }}
                      />
                      <span className="font-bold">{harness}</span>
                    </div>
                    {tools.map((t) => (
                      <div key={t.tool_name} className="flex justify-between text-base py-0.5">
                        <span className="text-[var(--color-muted)]">{t.tool_name}</span>
                        <span>{t.count.toLocaleString()}</span>
                      </div>
                    ))}
                  </div>
                ))}
              </div>
            );
          })()}
        </div>
      )}

      {/* Row: Tool calls pie + Tool calls bar */}
      <div className="grid grid-cols-2 gap-4">
        {/* Tool calls pie */}
        <div className="bg-[var(--color-surface)] rounded border border-[var(--color-border)] p-4">
          <h3 className="text-base font-bold mb-2 text-[var(--color-muted)]">
            Tool Calls ({totalToolCalls.toLocaleString()} total)
          </h3>
          <ResponsiveContainer width="100%" height={280}>
            <PieChart>
              <Pie
                data={toolPieData}
                dataKey="value"
                nameKey="name"
                cx="50%"
                cy="50%"
                innerRadius={40}
                outerRadius={90}
                strokeWidth={0}
              >
                {toolPieData.map((d: any, i: number) => (
                  <Cell key={i} fill={d.color} />
                ))}
              </Pie>
              <Tooltip

                formatter={(v) => Number(v ?? 0).toLocaleString()}
              />
              <Legend
                iconSize={8}
                wrapperStyle={{ fontSize: 16 }}
                layout="vertical"
                align="right"
                verticalAlign="middle"
              />
            </PieChart>
          </ResponsiveContainer>
        </div>

        {/* Tool calls horizontal bar */}
        <div className="bg-[var(--color-surface)] rounded border border-[var(--color-border)] p-4">
          <h3 className="text-base font-bold mb-2 text-[var(--color-muted)]">
            Tool Calls by Type
          </h3>
          <ResponsiveContainer width="100%" height={280}>
            <BarChart
              data={toolCalls.slice(0, 15)}
              layout="vertical"
              margin={{ left: 10 }}
            >
              <XAxis
                type="number"
                tick={{ fill: '#71717a', fontSize: 16 }}
                tickFormatter={(v: number) => v.toLocaleString()}
              />
              <YAxis
                type="category"
                dataKey="tool_name"
                tick={{ fill: '#a1a1aa', fontSize: 16 }}
                width={140}
                interval={0}
              />
              <Tooltip

                formatter={(v) => Number(v ?? 0).toLocaleString()}
              />
              <Bar dataKey="count" fill="#fbbf24" radius={[0, 4, 4, 0]} />
            </BarChart>
          </ResponsiveContainer>
        </div>
      </div>

      {/* Row: Tool calls by model + Content block types */}
      <div className="grid grid-cols-2 gap-4">
        {/* Tools by model */}
        <div className="bg-[var(--color-surface)] rounded border border-[var(--color-border)] p-4">
          <h3 className="text-base font-bold mb-2 text-[var(--color-muted)]">
            Tool Calls by Model
          </h3>
          <ResponsiveContainer width="100%" height={200}>
            <PieChart>
              <Pie
                data={toolsByModel.map((t: any) => ({
                  name: shortModel(t.model ?? 'unknown'),
                  value: t.count,
                  color: getModelColor(t.model ?? ''),
                }))}
                dataKey="value"
                nameKey="name"
                cx="50%"
                cy="50%"
                innerRadius={30}
                outerRadius={70}
                strokeWidth={0}
              >
                {toolsByModel.map((t: any, i: number) => (
                  <Cell key={i} fill={getModelColor(t.model ?? '')} />
                ))}
              </Pie>
              <Tooltip

                formatter={(v) => Number(v ?? 0).toLocaleString()}
              />
              <Legend iconSize={8} wrapperStyle={{ fontSize: 16 }} />
            </PieChart>
          </ResponsiveContainer>
        </div>

        {/* Content block types */}
        <div className="bg-[var(--color-surface)] rounded border border-[var(--color-border)] p-4">
          <h3 className="text-base font-bold mb-2 text-[var(--color-muted)]">
            Content Block Types
          </h3>
          <ResponsiveContainer width="100%" height={200}>
            <PieChart>
              <Pie
                data={blockTypes.map((b: any, i: number) => ({
                  name: b.block_type,
                  value: b.count,
                  color: TOOL_COLORS[i % TOOL_COLORS.length],
                }))}
                dataKey="value"
                nameKey="name"
                cx="50%"
                cy="50%"
                innerRadius={30}
                outerRadius={70}
                strokeWidth={0}
              >
                {blockTypes.map((_: any, i: number) => (
                  <Cell key={i} fill={TOOL_COLORS[i % TOOL_COLORS.length]} />
                ))}
              </Pie>
              <Tooltip

                formatter={(v) => Number(v ?? 0).toLocaleString()}
              />
              <Legend iconSize={8} wrapperStyle={{ fontSize: 16 }} />
            </PieChart>
          </ResponsiveContainer>
        </div>
      </div>

      {/* Daily activity line chart */}
      <div className="bg-[var(--color-surface)] rounded border border-[var(--color-border)] p-4">
        <h3 className="text-base font-bold mb-3 text-[var(--color-muted)]">
          Daily Messages & Tool Calls (last 30 days)
        </h3>
        <ResponsiveContainer width="100%" height={250}>
          <LineChart data={(dailyActivity ?? []).slice(-30)}>
            <XAxis
              dataKey="date"
              tick={{ fill: '#71717a', fontSize: 16 }}
              tickFormatter={(d: string) => d.slice(5)}
            />
            <YAxis tick={{ fill: '#71717a', fontSize: 16 }} />
            <Tooltip />
            <Legend />
            <Line
              type="monotone"
              dataKey="messageCount"
              name="Messages"
              stroke="#10b981"
              strokeWidth={2}
              dot={false}
            />
            <Line
              type="monotone"
              dataKey="toolCallCount"
              name="Tool Calls"
              stroke="#fbbf24"
              strokeWidth={2}
              dot={false}
            />
          </LineChart>
        </ResponsiveContainer>
      </div>

      </>)}

      {/* ============ PLAN TAB ============ */}
      {activeTab === 'plan' && (<>

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

        return (
          <div className="space-y-6">

            {/* Plan identity */}
            <div className="grid grid-cols-4 gap-4">
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
                sub={`${periodStart} → ${periodEnd}`}
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
              <div className="grid grid-cols-3 gap-4 pt-2">
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
                <ResponsiveContainer width="100%" height={260}>
                  <BarChart data={cumulativeData}>
                    <XAxis
                      dataKey="date"
                      tick={{ fill: '#71717a', fontSize: 16 }}
                      tickFormatter={(d: string) => d.slice(5)}
                    />
                    <YAxis
                      yAxisId="left"
                      tick={{ fill: '#71717a', fontSize: 16 }}
                      tickFormatter={(v: number) => formatCost(v)}
                    />
                    <YAxis
                      yAxisId="right"
                      orientation="right"
                      tick={{ fill: '#71717a', fontSize: 16 }}
                      tickFormatter={(v: number) => formatCost(v)}
                    />
                    <Tooltip formatter={(v) => formatCost(Number(v ?? 0))} />
                    <Legend iconSize={8} wrapperStyle={{ fontSize: 16 }} />
                    <Bar
                      yAxisId="left"
                      dataKey="daily"
                      name="Daily cost"
                      fill={isOver ? '#ef4444' : '#10b981'}
                      opacity={0.7}
                    />
                    <Line
                      yAxisId="right"
                      type="monotone"
                      dataKey="cumulative"
                      name="Cumulative"
                      stroke="#a78bfa"
                      strokeWidth={2}
                      dot={false}
                    />
                  </BarChart>
                </ResponsiveContainer>
              </div>
            )}
          </div>
        );
      })()}

      </>)}
    </div>
  );
}

function StatCard({
  label,
  value,
  sub,
  color,
}: {
  label: string;
  value: string;
  sub?: string;
  color?: string;
}) {
  return (
    <div className="bg-[var(--color-surface)] rounded border border-[var(--color-border)] p-4">
      <div className="text-base text-[var(--color-muted)] mb-1">{label}</div>
      <div className="text-2xl font-bold" style={color ? { color } : undefined}>
        {value}
      </div>
      {sub && <div className="text-base text-[var(--color-muted)] mt-1">{sub}</div>}
    </div>
  );
}
