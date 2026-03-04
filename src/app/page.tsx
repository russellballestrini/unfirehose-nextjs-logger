'use client';

import { useState } from 'react';
import useSWR from 'swr';
import { formatTokens } from '@/lib/format';
import { PageContext } from '@/components/PageContext';
import {
  BarChart,
  Bar,
  AreaChart,
  Area,
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

const TIME_RANGES = [
  { label: '1h', value: '1h' },
  { label: '3h', value: '3h' },
  { label: '6h', value: '6h' },
  { label: '24h', value: '24h' },
  { label: '7d', value: '7d' },
  { label: '14d', value: '14d' },
  { label: '28d', value: '28d' },
];

const DAY_COLORS = [
  '#ef4444', // Sun - red
  '#f59e0b', // Mon - amber
  '#10b981', // Tue - emerald
  '#06b6d4', // Wed - cyan
  '#6366f1', // Thu - indigo
  '#a78bfa', // Fri - violet
  '#ec4899', // Sat - pink
];

/* eslint-disable @typescript-eslint/no-explicit-any */

export default function DashboardPage() {
  const [range, setRange] = useState('7d');
  const { data, error } = useSWR(`/api/dashboard?range=${range}`, fetcher, {
    refreshInterval: 30000,
  });

  if (error) {
    return (
      <div className="text-[var(--color-error)]">
        Failed to load dashboard: {String(error)}
      </div>
    );
  }
  if (!data) {
    return <div className="text-[var(--color-muted)]">Loading dashboard...</div>;
  }

  const modelData = (data.modelBreakdown ?? []).map((m: any) => ({
    name: shortModel(m.model),
    fullName: m.model,
    tokens: m.totalTokens,
    cost: m.costUSD ?? 0,
  }));

  // Find sleep center and rotate hour data for bell curve
  const sleepCenter = findSleepCenter(data.hourCounts ?? []);
  const rotatedHours = rotateHours(data.hourCounts ?? [], sleepCenter);
  const localOffset = getLocalOffsetHours();
  const tzName = Intl.DateTimeFormat().resolvedOptions().timeZone;

  // Build day-of-week × hour curves for the heatmap
  const dowHourData = buildDowHourCurves(data.dowHourHeatmap ?? [], sleepCenter);

  return (
    <div className="space-y-6">
      <PageContext
        pageType="dashboard"
        summary={`Dashboard (${range}). ${data.summary.sessions} sessions, ${data.summary.messages} messages, $${data.summary.totalCost} equiv cost.`}
        metrics={data.summary}
      />

      {/* Header with time range dropdown */}
      <div className="flex items-center justify-between">
        <h2 className="text-lg font-bold">Dashboard</h2>
        <select
          value={range}
          onChange={(e) => setRange(e.target.value)}
          className="bg-[var(--color-surface)] border border-[var(--color-border)] rounded px-3 py-1.5 text-base text-[var(--color-foreground)] cursor-pointer"
        >
          {TIME_RANGES.map((r) => (
            <option key={r.value} value={r.value}>{r.label}</option>
          ))}
        </select>
      </div>

      {/* Stats cards */}
      <div className="grid grid-cols-5 gap-4">
        <StatCard label="Sessions" value={String(data.summary.sessions)} />
        <StatCard label="Messages" value={formatTokens(data.summary.messages)} />
        <StatCard label="Models" value={String(data.summary.models)} />
        <StatCard
          label="Equiv Cost"
          value={`$${data.summary.totalCost.toLocaleString()}`}
          sub="at API rates"
        />
        <StatCard
          label="Since"
          value={data.summary.since ?? '?'}
        />
      </div>

      {/* Charts row: activity + hour distribution */}
      <div className="grid grid-cols-2 gap-4">
        <div className="bg-[var(--color-surface)] rounded border border-[var(--color-border)] p-4">
          <h3 className="text-base font-bold mb-3 text-[var(--color-muted)]">
            Activity ({range})
          </h3>
          <ResponsiveContainer width="100%" height={200}>
            <BarChart data={data.dailyActivity}>
              <XAxis
                dataKey="date"
                tick={{ fill: '#71717a', fontSize: 16 }}
                tickFormatter={(d: string) => d.slice(5)}
              />
              <YAxis tick={{ fill: '#71717a', fontSize: 16 }} />
              <Tooltip
                contentStyle={{ background: '#18181b', border: '1px solid #3f3f46', borderRadius: 4, color: '#fafafa', fontSize: 14 }}
              />
              <Bar dataKey="messageCount" fill="#10b981" radius={[2, 2, 0, 0]} />
            </BarChart>
          </ResponsiveContainer>
        </div>

        <div className="bg-[var(--color-surface)] rounded border border-[var(--color-border)] p-4">
          <h3 className="text-base font-bold mb-3 text-[var(--color-muted)]">
            Hour Distribution
            <span className="font-normal text-[var(--color-muted)] ml-2">
              UTC {localOffset >= 0 ? '+' : ''}{localOffset} ({tzName})
            </span>
          </h3>
          <ResponsiveContainer width="100%" height={220}>
            <BarChart data={rotatedHours} margin={{ bottom: 16 }}>
              <XAxis
                dataKey="hour"
                tick={<DualHourTick offset={localOffset} />}
                interval={2}
                height={40}
              />
              <YAxis tick={{ fill: '#71717a', fontSize: 16 }} />
              <Tooltip
                contentStyle={{ background: '#18181b', border: '1px solid #3f3f46', borderRadius: 4, color: '#fafafa', fontSize: 14 }}
                labelFormatter={(h) => formatDualHourTooltip(h as number)}
              />
              <Bar dataKey="count" fill="#a78bfa" radius={[2, 2, 0, 0]} />
            </BarChart>
          </ResponsiveContainer>
        </div>
      </div>

      {/* Day of week charts row */}
      <div className="grid grid-cols-2 gap-4">
        {/* Day of week totals */}
        <div className="bg-[var(--color-surface)] rounded border border-[var(--color-border)] p-4">
          <h3 className="text-base font-bold mb-3 text-[var(--color-muted)]">
            Day of Week ({range})
          </h3>
          <ResponsiveContainer width="100%" height={200}>
            <BarChart data={data.dayOfWeekCounts}>
              <XAxis dataKey="day" tick={{ fill: '#71717a', fontSize: 16 }} />
              <YAxis tick={{ fill: '#71717a', fontSize: 16 }} />
              <Tooltip
                contentStyle={{ background: '#18181b', border: '1px solid #3f3f46', borderRadius: 4, color: '#fafafa', fontSize: 14 }}
              />
              <Bar dataKey="count" radius={[2, 2, 0, 0]}>
                {(data.dayOfWeekCounts ?? []).map((d: any) => (
                  <Cell key={d.day} fill={DAY_COLORS[d.dow]} />
                ))}
              </Bar>
            </BarChart>
          </ResponsiveContainer>
        </div>

        {/* Day × Hour hotspot curves */}
        <div className="bg-[var(--color-surface)] rounded border border-[var(--color-border)] p-4">
          <h3 className="text-base font-bold mb-3 text-[var(--color-muted)]">
            Hotspots by Day &times; Hour
            <span className="font-normal text-[var(--color-muted)] ml-2">
              UTC {localOffset >= 0 ? '+' : ''}{localOffset}
            </span>
          </h3>
          <ResponsiveContainer width="100%" height={220}>
            <AreaChart data={dowHourData} margin={{ bottom: 16 }}>
              <XAxis
                dataKey="hour"
                tick={<DualHourTick offset={localOffset} />}
                interval={2}
                height={40}
              />
              <YAxis tick={{ fill: '#71717a', fontSize: 16 }} />
              <Tooltip
                contentStyle={{ background: '#18181b', border: '1px solid #3f3f46', borderRadius: 4, color: '#fafafa', fontSize: 14 }}
                labelFormatter={(h) => formatDualHourTooltip(h as number)}
              />
              {['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].map((day, i) => (
                <Area
                  key={day}
                  type="monotone"
                  dataKey={day}
                  stroke={DAY_COLORS[i]}
                  fill={DAY_COLORS[i]}
                  fillOpacity={0.1}
                  strokeWidth={1.5}
                />
              ))}
            </AreaChart>
          </ResponsiveContainer>
        </div>
      </div>

      {/* Model usage */}
      <div className="bg-[var(--color-surface)] rounded border border-[var(--color-border)] p-4">
        <h3 className="text-base font-bold mb-3 text-[var(--color-muted)]">
          Model Usage ({range})
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
                {modelData.map((entry: any) => (
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
                  fontSize: 16,
                }}
                formatter={(value: any) => formatTokens(Number(value ?? 0))}
              />
            </PieChart>
          </ResponsiveContainer>
          <div className="flex-1">
            <table className="w-full text-base">
              <thead>
                <tr className="text-[var(--color-muted)] text-left">
                  <th className="pb-2">Model</th>
                  <th className="pb-2 text-right">Tokens</th>
                  <th className="pb-2 text-right">Cost</th>
                </tr>
              </thead>
              <tbody>
                {modelData.map((m: any) => (
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

/**
 * Find the sleep trough: the 6-hour contiguous window (circular) with minimum total activity.
 * Returns the hour at the center of that window — the chart starts there so sleep is at the edges
 * and the activity bell curve peaks in the middle.
 */
function findSleepCenter(hourCounts: { hour: number; count: number }[]): number {
  const counts = new Array(24).fill(0);
  for (const h of hourCounts) counts[h.hour] = h.count;

  const windowSize = 6;
  let minSum = Infinity;
  let minStart = 0;

  for (let start = 0; start < 24; start++) {
    let sum = 0;
    for (let j = 0; j < windowSize; j++) {
      sum += counts[(start + j) % 24];
    }
    if (sum < minSum) {
      minSum = sum;
      minStart = start;
    }
  }

  // Center of the sleep window = start offset for the chart
  return (minStart + Math.floor(windowSize / 2)) % 24;
}

/** Rotate an array of 24 hourly items so that `startHour` is index 0 */
function rotateHours<T extends { hour: number }>(data: T[], startHour: number): T[] {
  // Fill sparse data into a full 24-hour array
  const full = new Array(24).fill(null).map((_, i) => {
    const existing = data.find((d) => d.hour === i);
    return existing ?? { hour: i, count: 0 } as unknown as T;
  });
  return [...full.slice(startHour), ...full.slice(0, startHour)];
}

/** Get the browser's UTC offset in hours (e.g., -5 for EST) */
function getLocalOffsetHours(): number {
  return -(new Date().getTimezoneOffset() / 60);
}

function formatDualHourTooltip(utcHour: number): string {
  const offset = getLocalOffsetHours();
  const localHour = ((utcHour + offset) % 24 + 24) % 24;
  return `${utcHour}:00 UTC / ${localHour}:00 local`;
}

/** Pivot dow×hour rows into {hour, Sun, Mon, Tue, ...} for area chart */
function buildDowHourCurves(heatmap: any[], startHour: number): any[] {
  const dayNames = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const rows: any[] = [];
  for (let h = 0; h < 24; h++) {
    const row: any = { hour: h };
    for (const day of dayNames) row[day] = 0;
    rows.push(row);
  }
  for (const entry of heatmap) {
    const day = dayNames[entry.dow];
    if (day && rows[entry.hour]) {
      rows[entry.hour][day] = entry.count;
    }
  }
  // Rotate to match the same sleep-centered ordering
  return [...rows.slice(startHour), ...rows.slice(0, startHour)];
}

/** Custom tick that renders UTC on top, local below */
function DualHourTick({ x, y, payload, offset }: any) {
  const utcH = payload.value;
  const localH = ((utcH + offset) % 24 + 24) % 24;
  return (
    <g transform={`translate(${x},${y})`}>
      <text x={0} y={0} dy={12} textAnchor="middle" fill="#71717a" fontSize={11}>
        {utcH}:00
      </text>
      <text x={0} y={0} dy={24} textAnchor="middle" fill="#a78bfa" fontSize={10}>
        {localH}:00
      </text>
    </g>
  );
}

function StatCard({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div className="bg-[var(--color-surface)] rounded border border-[var(--color-border)] p-4">
      <div className="text-base text-[var(--color-muted)] mb-1">{label}</div>
      <div className="text-2xl font-bold">{value}</div>
      {sub && <div className="text-base text-[var(--color-muted)] mt-1">{sub}</div>}
    </div>
  );
}
