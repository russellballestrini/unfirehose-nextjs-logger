'use client';

import useSWR from 'swr';
import { formatTokens } from '@/lib/format';
import { PageContext } from '@/components/PageContext';
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


export default function TokensPage() {
  const { data, error } = useSWR('/api/tokens', fetcher);

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
    modelBreakdown,
    totalTokens,
    totalCost,
    totalInput,
    totalOutput,
    totalCacheRead,
    totalCacheWrite,
    toolCalls,
    toolsByModel,
    dailyActivity,
    blockTypes,
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
      <h2 className="text-lg font-bold">Token Usage</h2>

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
          <h3 className="text-sm font-bold mb-2 text-[var(--color-muted)]">
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
                wrapperStyle={{ fontSize: 11 }}
              />
            </PieChart>
          </ResponsiveContainer>
        </div>

        {/* Model token breakdown donut */}
        <div className="bg-[var(--color-surface)] rounded border border-[var(--color-border)] p-4">
          <h3 className="text-sm font-bold mb-2 text-[var(--color-muted)]">
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
                wrapperStyle={{ fontSize: 11 }}
              />
            </PieChart>
          </ResponsiveContainer>
        </div>

        {/* Cost by model donut */}
        <div className="bg-[var(--color-surface)] rounded border border-[var(--color-border)] p-4">
          <h3 className="text-sm font-bold mb-2 text-[var(--color-muted)]">
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
                wrapperStyle={{ fontSize: 11 }}
              />
            </PieChart>
          </ResponsiveContainer>
        </div>
      </div>

      {/* Model breakdown table */}
      <div className="bg-[var(--color-surface)] rounded border border-[var(--color-border)] p-4">
        <h3 className="text-sm font-bold mb-3 text-[var(--color-muted)]">
          Per-Model Breakdown
        </h3>
        <table className="w-full text-sm">
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

      {/* Row: Tool calls pie + Tool calls bar */}
      <div className="grid grid-cols-2 gap-4">
        {/* Tool calls pie */}
        <div className="bg-[var(--color-surface)] rounded border border-[var(--color-border)] p-4">
          <h3 className="text-sm font-bold mb-2 text-[var(--color-muted)]">
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
                wrapperStyle={{ fontSize: 10 }}
                layout="vertical"
                align="right"
                verticalAlign="middle"
              />
            </PieChart>
          </ResponsiveContainer>
        </div>

        {/* Tool calls horizontal bar */}
        <div className="bg-[var(--color-surface)] rounded border border-[var(--color-border)] p-4">
          <h3 className="text-sm font-bold mb-2 text-[var(--color-muted)]">
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
                tick={{ fill: '#71717a', fontSize: 10 }}
                tickFormatter={(v: number) => v.toLocaleString()}
              />
              <YAxis
                type="category"
                dataKey="tool_name"
                tick={{ fill: '#a1a1aa', fontSize: 10 }}
                width={100}
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
          <h3 className="text-sm font-bold mb-2 text-[var(--color-muted)]">
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
              <Legend iconSize={8} wrapperStyle={{ fontSize: 11 }} />
            </PieChart>
          </ResponsiveContainer>
        </div>

        {/* Content block types */}
        <div className="bg-[var(--color-surface)] rounded border border-[var(--color-border)] p-4">
          <h3 className="text-sm font-bold mb-2 text-[var(--color-muted)]">
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
              <Legend iconSize={8} wrapperStyle={{ fontSize: 11 }} />
            </PieChart>
          </ResponsiveContainer>
        </div>
      </div>

      {/* Daily activity line chart */}
      <div className="bg-[var(--color-surface)] rounded border border-[var(--color-border)] p-4">
        <h3 className="text-sm font-bold mb-3 text-[var(--color-muted)]">
          Daily Messages & Tool Calls (last 30 days)
        </h3>
        <ResponsiveContainer width="100%" height={250}>
          <LineChart data={(dailyActivity ?? []).slice(-30)}>
            <XAxis
              dataKey="date"
              tick={{ fill: '#71717a', fontSize: 10 }}
              tickFormatter={(d: string) => d.slice(5)}
            />
            <YAxis tick={{ fill: '#71717a', fontSize: 10 }} />
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
      <div className="text-xs text-[var(--color-muted)] mb-1">{label}</div>
      <div className="text-2xl font-bold" style={color ? { color } : undefined}>
        {value}
      </div>
      {sub && <div className="text-xs text-[var(--color-muted)] mt-1">{sub}</div>}
    </div>
  );
}
