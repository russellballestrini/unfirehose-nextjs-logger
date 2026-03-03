'use client';

import useSWR from 'swr';
import type { StatsCache } from '@/lib/types';
import { formatTokens } from '@/lib/format';
import { PageContext } from '@/components/PageContext';
import {
  BarChart,
  Bar,
  XAxis,
  YAxis,
  Tooltip,
  ResponsiveContainer,
  PieChart,
  Pie,
  Cell,
} from 'recharts';

const fetcher = (url: string) => fetch(url).then((r) => r.json());

const MODEL_COLORS: Record<string, string> = {
  'claude-opus-4-6': '#a78bfa',
  'claude-opus-4-5-20251101': '#818cf8',
  'claude-sonnet-4-5-20250929': '#34d399',
  'claude-sonnet-4-6': '#10b981',
  'claude-haiku-4-5-20251001': '#fbbf24',
};

function getModelColor(model: string): string {
  return MODEL_COLORS[model] ?? '#6b7280';
}

function shortModel(model: string): string {
  return model
    .replace('claude-', '')
    .replace(/-\d{8}$/, '');
}

/* eslint-disable @typescript-eslint/no-explicit-any */

export default function DashboardPage() {
  const { data: stats, error } = useSWR<StatsCache>('/api/stats', fetcher);
  const { data: tokenData } = useSWR<any>('/api/tokens', fetcher);

  if (error) {
    return (
      <div className="text-[var(--color-error)]">
        Failed to load stats: {String(error)}
      </div>
    );
  }
  if (!stats) {
    return <div className="text-[var(--color-muted)]">Loading stats...</div>;
  }

  const modelData = Object.entries(stats.modelUsage).map(([model, usage]) => ({
    name: shortModel(model),
    fullName: model,
    tokens: usage.inputTokens + usage.outputTokens,
    cost: usage.costUSD ?? 0,
  }));

  const hourData = Object.entries(stats.hourCounts)
    .map(([hour, count]) => ({ hour: `${hour}:00`, count }))
    .sort((a, b) => parseInt(a.hour) - parseInt(b.hour));

  const recentActivity = stats.dailyActivity.slice(-30);

  return (
    <div className="space-y-6">
      <PageContext
        pageType="dashboard"
        summary={`Claude Code usage dashboard. ${stats.totalSessions} sessions, ${formatTokens(stats.totalMessages)} messages across ${modelData.length} models since ${stats.firstSessionDate?.split('T')[0] ?? 'unknown'}.${tokenData ? ` Equivalent API cost: $${Number(tokenData.totalCost).toLocaleString(undefined, { maximumFractionDigits: 0 })}.` : ''}`}
        metrics={{
          total_sessions: stats.totalSessions,
          total_messages: stats.totalMessages,
          models_used: modelData.length,
          first_session: stats.firstSessionDate?.split('T')[0] ?? '',
          equivalent_cost_usd: tokenData ? Number(tokenData.totalCost).toFixed(2) : 'loading',
        }}
        details={modelData.map((m: any) => `${m.name}: ${formatTokens(m.tokens)} tokens, $${m.cost.toFixed(2)} cost`).join('\n')}
      />
      <h2 className="text-lg font-bold">Dashboard</h2>

      {/* Stats cards */}
      <div className="grid grid-cols-5 gap-4">
        <StatCard label="Sessions" value={String(stats.totalSessions)} />
        <StatCard
          label="Messages"
          value={formatTokens(stats.totalMessages)}
        />
        <StatCard label="Models" value={String(modelData.length)} />
        <StatCard
          label="Equiv Cost"
          value={tokenData ? `$${Number(tokenData.totalCost).toLocaleString(undefined, { maximumFractionDigits: 0 })}` : '...'}
          sub="at API rates"
        />
        <StatCard
          label="Since"
          value={stats.firstSessionDate?.split('T')[0] ?? '?'}
        />
      </div>

      {/* Charts row */}
      <div className="grid grid-cols-2 gap-4">
        {/* Activity chart */}
        <div className="bg-[var(--color-surface)] rounded border border-[var(--color-border)] p-4">
          <h3 className="text-sm font-bold mb-3 text-[var(--color-muted)]">
            Daily Activity (last 30 days)
          </h3>
          <ResponsiveContainer width="100%" height={200}>
            <BarChart data={recentActivity}>
              <XAxis
                dataKey="date"
                tick={{ fill: '#71717a', fontSize: 10 }}
                tickFormatter={(d: string) => d.slice(5)}
              />
              <YAxis tick={{ fill: '#71717a', fontSize: 10 }} />
              <Tooltip />
              <Bar dataKey="messageCount" fill="#10b981" radius={[2, 2, 0, 0]} />
            </BarChart>
          </ResponsiveContainer>
        </div>

        {/* Hour distribution */}
        <div className="bg-[var(--color-surface)] rounded border border-[var(--color-border)] p-4">
          <h3 className="text-sm font-bold mb-3 text-[var(--color-muted)]">
            Hour Distribution (UTC)
          </h3>
          <ResponsiveContainer width="100%" height={200}>
            <BarChart data={hourData}>
              <XAxis
                dataKey="hour"
                tick={{ fill: '#71717a', fontSize: 10 }}
                interval={3}
              />
              <YAxis tick={{ fill: '#71717a', fontSize: 10 }} />
              <Tooltip />
              <Bar dataKey="count" fill="#a78bfa" radius={[2, 2, 0, 0]} />
            </BarChart>
          </ResponsiveContainer>
        </div>
      </div>

      {/* Model usage */}
      <div className="bg-[var(--color-surface)] rounded border border-[var(--color-border)] p-4">
        <h3 className="text-sm font-bold mb-3 text-[var(--color-muted)]">
          Model Usage
        </h3>
        <div className="flex items-start gap-8">
          <ResponsiveContainer width={200} height={200}>
            <PieChart>
              <Pie
                data={modelData}
                dataKey="tokens"
                nameKey="name"
                cx="50%"
                cy="50%"
                innerRadius={40}
                outerRadius={80}
                strokeWidth={0}
              >
                {modelData.map((entry) => (
                  <Cell
                    key={entry.fullName}
                    fill={getModelColor(entry.fullName)}
                  />
                ))}
              </Pie>
              <Tooltip
                contentStyle={{
                  background: '#18181b',
                  border: '1px solid #3f3f46',
                  borderRadius: 4,
                  color: '#fafafa',
                  fontSize: 12,
                }}
                formatter={(value) => formatTokens(Number(value ?? 0))}
              />
            </PieChart>
          </ResponsiveContainer>
          <div className="flex-1">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-[var(--color-muted)] text-left">
                  <th className="pb-2">Model</th>
                  <th className="pb-2 text-right">Tokens</th>
                  <th className="pb-2 text-right">Cost</th>
                </tr>
              </thead>
              <tbody>
                {modelData.map((m) => (
                  <tr key={m.fullName} className="border-t border-[var(--color-border)]">
                    <td className="py-1.5 flex items-center gap-2">
                      <span
                        className="inline-block w-2 h-2 rounded-full"
                        style={{ background: getModelColor(m.fullName) }}
                      />
                      {m.name}
                    </td>
                    <td className="py-1.5 text-right">
                      {formatTokens(m.tokens)}
                    </td>
                    <td className="py-1.5 text-right">
                      ${m.cost.toFixed(2)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      </div>
    </div>
  );
}

function StatCard({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div className="bg-[var(--color-surface)] rounded border border-[var(--color-border)] p-4">
      <div className="text-xs text-[var(--color-muted)] mb-1">{label}</div>
      <div className="text-2xl font-bold">{value}</div>
      {sub && <div className="text-xs text-[var(--color-muted)] mt-1">{sub}</div>}
    </div>
  );
}
