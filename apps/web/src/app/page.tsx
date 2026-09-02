'use client';

import useSWR from 'swr';
import { BootScreen } from './BootScreen';
import { formatTokens, formatCost } from '@unturf/unfirehose/format';
import { PageContext } from '@unturf/unfirehose-ui/PageContext';
import { TimeRangeSelect, useTimeRange } from '@unturf/unfirehose-ui/TimeRangeSelect';
import { TokenSplitCards, TOKEN_TYPE_COLORS } from '@unturf/unfirehose-ui/TokenSplit';
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
  // Opus tier — purple shades
  'claude-opus-4-7':            '#c084fc',
  'claude-opus-4-6':            '#a78bfa',
  'claude-opus-4-5-20251101':   '#818cf8',
  // Sonnet tier — green shades
  'claude-sonnet-4-6':          '#10b981',
  'claude-sonnet-4-5-20250929': '#34d399',
  'claude-sonnet-4-20250514':   '#22c55e',
  // Haiku tier — amber shades
  'claude-haiku-4-5-20251001':  '#fbbf24',
};

function getModelColor(model: string): string {
  return MODEL_COLORS[model] ?? '#6b7280';
}

function shortModel(model: string): string {
  return model
    .replace('claude-', '')
    .replace(/-\d{8}$/, '');
}


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
  const [range, setRange] = useTimeRange('dashboard_range', '7d');
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
    return <BootScreen />;
  }

  const modelData = (data.modelBreakdown ?? []).map((m: any) => ({
    name: shortModel(m.model),
    fullName: m.model,
    tokens: m.totalTokens,
    inputTokens: m.inputTokens ?? 0,
    outputTokens: m.outputTokens ?? 0,
    cacheReadTokens: m.cacheReadTokens ?? 0,
    cacheWriteTokens: m.cacheCreationTokens ?? 0,
    // Self-hosted rows book energy into the total and leave these at zero, so
    // an absent per-type price stays absent rather than reading as free.
    inputCost: m.selfHosted ? null : m.inputCostUSD,
    outputCost: m.selfHosted ? null : m.outputCostUSD,
    cacheCost: m.selfHosted ? null : (m.cacheReadCostUSD ?? 0) + (m.cacheWriteCostUSD ?? 0),
    // vLLM's own count, for models we serve. A self-hosted model reports no
    // cache_read tokens, so without this our own cache reads as nonexistent.
    measuredCacheHitRate: m.measuredCacheHitRate ?? null,
    measuredCacheQueries: m.measuredCacheQueries ?? null,
    measuredCacheHits: m.measuredCacheHits ?? null,
    measuredCacheNodes: m.measuredCacheNodes ?? null,
    cost: m.costUSD ?? 0,
    // What these tokens are worth at oracle rates, and what our own hardware
    // saved by serving them. Both zero for ordinary cloud rows.
    market: m.marketUSD ?? 0,
    avoided: m.avoidedUSD ?? 0,
    costSource: m.costSource ?? 'unknown',
    pricedAgainst: m.pricedAgainst ?? null,
    promo: m.promo ?? null,
    selfHosted: !!m.selfHosted,
    host: m.host ?? null,
    provider: m.provider ?? null,
    meshObservedUSD: m.meshObservedUSD,
  }));

  const avoidedTotal = modelData.reduce((s: number, m: any) => s + (m.avoided ?? 0), 0);

  // How much of every token we moved was cache. On a coding-agent workload
  // this runs above 90%, which is exactly why the headline has to say it.
  const summaryTokens = data.summary.totalTokens ?? 0;
  const cacheShare = summaryTokens > 0
    ? ((data.summary.cacheReadTokens ?? 0) + (data.summary.cacheWriteTokens ?? 0)) / summaryTokens
    : null;

  // Find sleep center and rotate hour data for bell curve
  const sleepCenter = findSleepCenter(data.hourCounts ?? []);
  const rotatedHours = rotateHours(data.hourCounts ?? [], sleepCenter);
  const localOffset = getLocalOffsetHours();
  const tzName = Intl.DateTimeFormat().resolvedOptions().timeZone;

  // Build day-of-week × hour curves for the heatmap
  const dowHourData = buildDowHourCurves(data.dowHourHeatmap ?? [], sleepCenter);

  // First-time visitor lands here after the vault. Zero sessions = teach the
  // product, hide the embarrassing zeros.
  if (data.summary.sessions === 0) {
    return (
      <div className="space-y-6">
        <PageContext
          pageType="dashboard"
          summary={`Dashboard (${range}). First-run state — no sessions ingested yet.`}
          metrics={{ ...data.summary, first_run: 'yes' }}
        />
        <div className="flex items-center justify-between">
          <h2 className="text-lg font-bold">Dashboard</h2>
          <TimeRangeSelect value={range} onChange={setRange} />
        </div>
        <div className="border border-[var(--color-border)] rounded-xl p-8 bg-[var(--color-surface)] space-y-5 max-w-3xl">
          <div>
            <h3 className="text-2xl font-bold mb-2">Welcome to unfirehose</h3>
            <p className="text-base text-[var(--color-muted)]">
              A local-first observability dashboard for AI coding agents. Watch your sessions,
              tokens, reasoning, and cost across every harness you run — Claude Code, agnt,
              uncloseai, fetch, and more — without sending a byte to the cloud.
            </p>
          </div>
          <div>
            <h4 className="text-base font-bold mb-2">Get started</h4>
            <ol className="list-decimal list-inside text-base text-[var(--color-muted)] space-y-1.5">
              <li>Run a Claude Code session in any git repo: <code className="text-[var(--color-accent)]">cd ~/your/repo &amp;&amp; claude</code></li>
              <li>Or point another harness at <code className="text-[var(--color-accent)]">~/.unfirehose/</code>.</li>
              <li>Refresh this page — sessions, projects, todos, and reasoning appear automatically.</li>
            </ol>
          </div>
          <div className="flex flex-wrap gap-3 pt-2 border-t border-[var(--color-border)]">
            <a href="/projects" className="px-3 py-1.5 text-sm rounded border border-[var(--color-accent)] text-[var(--color-accent)] hover:bg-[var(--color-accent)]/10">Projects</a>
            <a href="/schema" className="px-3 py-1.5 text-sm rounded border border-[var(--color-border)] text-[var(--color-muted)] hover:text-[var(--color-foreground)]">Schema docs</a>
            <a href="/settings" className="px-3 py-1.5 text-sm rounded border border-[var(--color-border)] text-[var(--color-muted)] hover:text-[var(--color-foreground)]">Settings</a>
            <a href="/live" className="px-3 py-1.5 text-sm rounded border border-[var(--color-border)] text-[var(--color-muted)] hover:text-[var(--color-foreground)]">Live stream</a>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <PageContext
        pageType="dashboard"
        summary={`Dashboard (${range}). ${data.summary.sessions} sessions, ${data.summary.messages} messages, ${formatTokens(data.summary.totalTokens ?? 0)} tokens (${cacheShare == null ? 'n/a' : (cacheShare * 100).toFixed(0) + '%'} cache), $${data.summary.totalCost} equiv cost.`}
        metrics={data.summary}
      />

      {/* Header with time range dropdown */}
      <div className="flex items-center justify-between">
        <h2 className="text-lg font-bold">Dashboard</h2>
        <TimeRangeSelect value={range} onChange={setRange} />
      </div>

      {/* Stats cards */}
      <div className="grid grid-cols-5 gap-4">
        <StatCard label="Sessions" value={String(data.summary.sessions)} />
        <StatCard label="Messages" value={formatTokens(data.summary.messages)} />
        <StatCard label="Models" value={String(data.summary.models)} />
        <StatCard
          label="Equiv Cost"
          value={`$${data.summary.totalCost.toLocaleString()}`}
          sub={
            data.summary.cacheCost > 0 && data.summary.totalCost > 0
              ? `$${data.summary.cacheCost.toLocaleString()} of it cache`
              : 'at API rates'
          }
          title="At API rates, cache read and cache write billed at their own rates — not free, and not folded into input."
        />
        <StatCard
          label="Since"
          value={data.summary.since ?? '?'}
        />
      </div>

      {/* Every token we moved, split by type and priced. Cache is the pile
          that matters — hiding it inside a single total hides the workload. */}
      <TokenSplitCards
        tokens={{
          input: data.summary.inputTokens ?? 0,
          output: data.summary.outputTokens ?? 0,
          cacheRead: data.summary.cacheReadTokens ?? 0,
          cacheWrite: data.summary.cacheWriteTokens ?? 0,
        }}
        costs={data.summary.costSplit && { ...data.summary.costSplit, total: data.summary.totalCost }}
      />

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
                formatter={(value: any, _n: any, entry: any) => {
                  const p = entry?.payload ?? {};
                  return [
                    `${formatTokens(Number(value ?? 0))} (in ${formatTokens(p.inputTokens ?? 0)} · out ${formatTokens(p.outputTokens ?? 0)} · cache ${formatTokens((p.cacheReadTokens ?? 0) + (p.cacheWriteTokens ?? 0))})`,
                    'tokens',
                  ];
                }}
              />
            </PieChart>
          </ResponsiveContainer>
          <div className="flex-1">
            <table className="w-full text-base">
              <thead>
                <tr className="text-[var(--color-muted)] text-left">
                  <th className="pb-2">Model</th>
                  <th className="pb-2 text-right" style={{ color: TOKEN_TYPE_COLORS.input }} title="Fresh prompt tokens the provider read for the first time.">Input</th>
                  <th className="pb-2 text-right" style={{ color: TOKEN_TYPE_COLORS.cacheRead }} title="Cache read + cache write. A model we serve ourselves reports no cache tokens at all, so its cell shows the hit rate vLLM measured instead. Hover a cell either way.">Cache</th>
                  <th className="pb-2 text-right" style={{ color: TOKEN_TYPE_COLORS.output }} title="Tokens the model generated.">Output</th>
                  <th className="pb-2 text-right" title="Input + output + cache read + cache write.">Tokens</th>
                  <th className="pb-2 text-right" title="What we pay. Invoice for cloud, electricity for our own hardware.">Cost</th>
                  <th className="pb-2 text-right" title="What these tokens would cost at OpenRouter / Nous rates, whoever served them.">Market</th>
                  <th className="pb-2 text-right" title="Market minus cost — what running it ourselves saved.">Saved</th>
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
                      <span>{m.name}</span>
                      {m.selfHosted && (
                        <span
                          className="text-xs text-[var(--color-muted)] opacity-70"
                          title={
                            m.host && m.meshObservedUSD != null
                              ? `self-hosted on ${m.host}. cost = watts × GPU-seconds × $/kWh, prefill and decode billed at their own rates. mesh-observed during window: $${m.meshObservedUSD.toFixed(4)} (sparse polling under-counts)`
                              : m.host
                                ? `self-hosted on ${m.host}. cost from peak-watt estimate.`
                                : `self-hosted, node unknown — no endpoint URL logged. Cost from peak-watt estimate.`
                          }
                        >
                          ⚡{m.host ?? 'local'}
                        </span>
                      )}
                      {m.costSource === 'synthetic' && (
                        <span
                          className="text-xs text-[var(--color-muted)] opacity-70"
                          title="Test fixture, not a real model. $0 by construction."
                        >
                          test
                        </span>
                      )}
                      {m.promo && (
                        <span
                          className="text-xs text-[var(--color-muted)] opacity-70"
                          title={`List price. ${m.promo.reason} — noted ${m.promo.notedOn}. The provider bills less than this today; a temporary discount is the wrong basis for deciding where work should run.`}
                        >
                          list
                        </span>
                      )}
                      {m.pricedAgainst && m.pricedAgainst.toLowerCase() !== m.fullName.toLowerCase() && (
                        <span
                          className="text-xs text-[var(--color-muted)] opacity-70"
                          title={`No own price — shadow-priced against ${m.pricedAgainst}.`}
                        >
                          ≈{m.pricedAgainst}
                        </span>
                      )}
                    </td>
                    <td className="py-1.5 text-right" title={m.inputCost != null ? `${formatCost(m.inputCost)} at API rates` : undefined}>
                      {formatTokens(m.inputTokens)}
                    </td>
                    <td
                      className="py-1.5 text-right"
                      title={
                        m.cacheReadTokens + m.cacheWriteTokens === 0 && m.measuredCacheHitRate != null
                          ? `${formatTokens(m.measuredCacheHits ?? 0)} of ${formatTokens(m.measuredCacheQueries ?? 0)} prompt tokens served from vLLM's prefix cache` +
                            `\non ${(m.measuredCacheNodes ?? []).join(', ')}.` +
                            `\n\nA model we serve ourselves reports no cache_read tokens, so token accounting cannot see this. vLLM counts it; we sample the counters and difference them over the window.`
                          : `cache read ${formatTokens(m.cacheReadTokens)} · ` +
                            `cache write ${formatTokens(m.cacheWriteTokens)}` +
                            (m.cacheCost != null ? `\n${formatCost(m.cacheCost)} at API rates` : '')
                      }
                    >
                      {m.cacheReadTokens + m.cacheWriteTokens === 0 && m.measuredCacheHitRate != null
                        ? <span style={{ color: TOKEN_TYPE_COLORS.cacheRead }}>
                            {(m.measuredCacheHitRate * 100).toFixed(1)}% hit
                          </span>
                        : formatTokens(m.cacheReadTokens + m.cacheWriteTokens)}
                    </td>
                    <td className="py-1.5 text-right" title={m.outputCost != null ? `${formatCost(m.outputCost)} at API rates` : undefined}>
                      {formatTokens(m.outputTokens)}
                    </td>
                    <td className="py-1.5 text-right">
                      {formatTokens(m.tokens)}
                    </td>
                    <td className="py-1.5 text-right">
                      {/* An unpriced model must never render as $0 — that is the
                          defect this panel had. Show it as unknown instead. */}
                      {m.costSource === 'unknown'
                        ? <span className="text-[var(--color-muted)]" title="No price from either oracle. Not free — unknown.">—</span>
                        : m.costSource === 'synthetic'
                          ? <span className="text-[var(--color-muted)]" title="Test fixture. $0 by construction, not by measurement.">—</span>
                          : `$${m.cost.toFixed(2)}`}
                    </td>
                    <td className="py-1.5 text-right text-[var(--color-muted)]">
                      {m.market > 0 ? `$${m.market.toFixed(2)}` : '—'}
                    </td>
                    <td className="py-1.5 text-right">
                      {m.avoided > 0
                        ? <span className="text-[var(--color-success,#4ade80)]">${m.avoided.toFixed(2)}</span>
                        : <span className="text-[var(--color-muted)]">—</span>}
                    </td>
                  </tr>
                ))}
              </tbody>
              {avoidedTotal > 0 && (
                <tfoot>
                  <tr className="border-t border-[var(--color-border)] text-[var(--color-muted)]">
                    <td className="pt-2" colSpan={7}>
                      saved by running our own hardware
                    </td>
                    <td className="pt-2 text-right text-[var(--color-success,#4ade80)]">
                      ${avoidedTotal.toFixed(2)}
                    </td>
                  </tr>
                </tfoot>
              )}
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

function StatCard({ label, value, sub, title }: { label: string; value: string; sub?: string; title?: string }) {
  return (
    <div className="bg-[var(--color-surface)] rounded border border-[var(--color-border)] p-4" title={title}>
      <div className="text-base text-[var(--color-muted)] mb-1">{label}</div>
      <div className="text-2xl font-bold">{value}</div>
      {sub && <div className="text-base text-[var(--color-muted)] mt-1">{sub}</div>}
    </div>
  );
}
