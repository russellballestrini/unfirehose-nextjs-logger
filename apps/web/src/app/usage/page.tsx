'use client';

import { useState, useEffect, useCallback, useRef, Fragment } from 'react';
import useSWR from 'swr';
import Link from 'next/link';
import { formatTokens, formatRelativeTime } from '@unturf/unfirehose/format';
import { PageContext } from '@unturf/unfirehose-ui/PageContext';
import { TimeRangeSelect, useTimeRange, getTimeRangeMinutes } from '@unturf/unfirehose-ui/TimeRangeSelect';
import { useCurrency } from '@unturf/unfirehose-ui/useCurrency';
import {
  AreaChart,
  Area,
  LineChart,
  Line,
  XAxis,
  YAxis,
  Tooltip,
  Legend,
  ResponsiveContainer,
} from 'recharts';

/* eslint-disable @typescript-eslint/no-explicit-any */

const fetcher = (url: string) => fetch(url).then((r) => r.json());

export default function UsageMonitorPage() {
  const [range, setRange] = useTimeRange('usage_range', '24h');
  const window = getTimeRangeMinutes(range);
  const [ingesting, setIngesting] = useState(false);
  const [lastIngest, setLastIngest] = useState<any>(null);
  const { data: settings } = useSWR('/api/settings', fetcher, { revalidateOnFocus: false });
  const [kwhRates, setKwhRates] = useState<Record<string, number>>({});
  const [ispCosts, setIspCosts] = useState<Record<string, number>>({});
  const [diskOverrides, setDiskOverrides] = useState<Record<string, number>>({});
  const [wattsOverrides, setWattsOverrides] = useState<Record<string, number>>({});

  // Load per-node electricity rates and ISP costs from settings
  /* eslint-disable react-hooks/set-state-in-effect -- sync derived state from settings */
  useEffect(() => {
    if (!settings) return;
    const rates: Record<string, number> = {};
    const isps: Record<string, number> = {};
    const disks: Record<string, number> = {};
    const watts: Record<string, number> = {};
    for (const [k, v] of Object.entries(settings)) {
      if (k.startsWith('electricity_rate_')) {
        rates[k.replace('electricity_rate_', '')] = parseFloat(v as string) || DEFAULT_KWH_RATE;
      }
      if (k.startsWith('isp_cost_')) {
        isps[k.replace('isp_cost_', '')] = parseFloat(v as string) || 0;
      }
      if (k.startsWith('disk_override_')) {
        disks[k.replace('disk_override_', '')] = parseInt(v as string) || 0;
      }
      if (k.startsWith('watts_override_')) {
        watts[k.replace('watts_override_', '')] = parseFloat(v as string) || 0;
      }
    }
    setKwhRates(rates);
    setIspCosts(isps);
    setDiskOverrides(disks);
    setWattsOverrides(watts);
  }, [settings]);
  /* eslint-enable react-hooks/set-state-in-effect */

  const getKwhRate = (hostname: string) => kwhRates[hostname] ?? DEFAULT_KWH_RATE;
  const getIspCost = (hostname: string) => ispCosts[hostname] ?? (parseFloat(settings?.mesh_default_isp_cost ?? '0') || 0);
  const getDiskOverride = (hostname: string) => diskOverrides[hostname] ?? undefined;
  const getWattsOverride = (hostname: string) => wattsOverrides[hostname] ?? undefined;

  const saveSetting = (key: string, value: string) => {
    fetch('/api/settings', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'set', key, value }),
    });
  };

  const saveKwhRate = (hostname: string, rate: number) => {
    setKwhRates(prev => ({ ...prev, [hostname]: rate }));
    saveSetting(`electricity_rate_${hostname}`, String(rate));
  };

  const saveIspCost = (hostname: string, cost: number) => {
    setIspCosts(prev => ({ ...prev, [hostname]: cost }));
    saveSetting(`isp_cost_${hostname}`, String(cost));
  };

  const saveDiskOverride = (hostname: string, count: number) => {
    setDiskOverrides(prev => ({ ...prev, [hostname]: count }));
    saveSetting(`disk_override_${hostname}`, String(count));
  };

  const saveWattsOverride = (hostname: string, watts: number) => {
    setWattsOverrides(prev => ({ ...prev, [hostname]: watts }));
    saveSetting(`watts_override_${hostname}`, String(watts));
  };

  // Auto-refresh every 10 seconds
  const { data: timeline, mutate: mutateTimeline } = useSWR(
    `/api/usage?minutes=${window}`,
    fetcher,
    { refreshInterval: 10000 }
  );
  const { data: byProject, mutate: mutateProjects } = useSWR(
    `/api/usage?view=projects&minutes=${window}`,
    fetcher,
    { refreshInterval: 10000 }
  );
  const { data: alerts, mutate: mutateAlerts } = useSWR(
    '/api/alerts?filter=unacknowledged',
    fetcher,
    { refreshInterval: 5000 }
  );
  const { data: allAlerts } = useSWR('/api/alerts?limit=50', fetcher, {
    refreshInterval: 10000,
  });
  const { data: thresholds, mutate: mutateThresholds } = useSWR(
    '/api/alerts?filter=thresholds',
    fetcher
  );
  const { data: dbStats } = useSWR('/api/ingest', fetcher, {
    refreshInterval: 30000,
  });
  const { data: plan } = useSWR('/api/usage/plan', fetcher, {
    refreshInterval: 60000,
  });
  const { data: extra } = useSWR('/api/usage/extra', fetcher, {
    refreshInterval: 60000,
  });
  const { data: mesh } = useSWR('/api/mesh', fetcher, {
    refreshInterval: 15000,
  });
  const meshHistoryHours = window === 0 ? 720 : Math.max(1, Math.ceil(window / 60));
  const { data: meshHistory, mutate: mutateMeshHistory } = useSWR(
    `/api/mesh/history?hours=${meshHistoryHours}`,
    fetcher,
    { refreshInterval: 30000 }
  );

  // Record mesh snapshot every time mesh data refreshes
  const lastSnapshotRef = useRef<string>('');
  useEffect(() => {
    if (!mesh?.nodes?.length) return;
    const key = mesh.nodes.map((n: any) => `${n.hostname}:${n.loadAvg?.[0]}`).join(',');
    if (key === lastSnapshotRef.current) return;
    lastSnapshotRef.current = key;
    fetch('/api/mesh/history', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ nodes: mesh.nodes }),
    }).then(() => mutateMeshHistory());
  }, [mesh, mutateMeshHistory]);

  // Unsandbox status + probe
  const { data: unsandbox } = useSWR('/api/unsandbox', fetcher, { refreshInterval: 30000 });
  const [unsandboxProbe, setUnsandboxProbe] = useState<any>(null);
  const unsandboxProbeRef = useRef(false);
  useEffect(() => {
    if (!unsandbox?.connected || unsandboxProbeRef.current) return;
    unsandboxProbeRef.current = true;
    fetch('/api/unsandbox', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'probe' }) })
      .then(r => r.json())
      .then(d => { if (d.probe) setUnsandboxProbe(d.probe); })
      .catch(() => {});
  }, [unsandbox?.connected]);

  const { data: apmonitor } = useSWR('/api/apmonitor', fetcher, {
    refreshInterval: 15000,
  });
  const standupDays = window === 0 ? 9999 : Math.max(1, Math.ceil(window / 1440));
  const { data: projectActivity } = useSWR(
    `/api/projects/activity?days=${standupDays}`,
    fetcher,
    { refreshInterval: 30000 }
  );
  const usageTabs = ['model', 'infra', 'thresholds'] as const;
  type UsageTab = (typeof usageTabs)[number];
  const [activeTab, setActiveTabRaw] = useState<UsageTab>(() => {
    if (typeof globalThis !== 'undefined' && globalThis.location) {
      const hash = globalThis.location.hash.slice(1) as UsageTab;
      if (usageTabs.includes(hash)) return hash;
    }
    return 'model';
  });
  const setActiveTab = (tab: UsageTab) => { setActiveTabRaw(tab); };
  useEffect(() => { globalThis.location.hash = activeTab; }, [activeTab]);
  const [chartHostname, setChartHostname] = useState<string>('all');
  const currency = useCurrency();
  const [collapsedProjects, setCollapsedProjects] = useState<Set<string>>(new Set());
  const allExpanded = projectActivity ? projectActivity.every((p: any) => !collapsedProjects.has(p.name)) : true;
  const toggleProject = useCallback((name: string) => {
    setCollapsedProjects(prev => {
      const next = new Set(prev);
      if (next.has(name)) next.delete(name);
      else next.add(name);
      return next;
    });
  }, []);
  const toggleAll = useCallback(() => {
    if (allExpanded && projectActivity) {
      setCollapsedProjects(new Set(projectActivity.map((p: any) => p.name)));
    } else {
      setCollapsedProjects(new Set());
    }
  }, [allExpanded, projectActivity]);

  const runIngest = useCallback(async () => {
    setIngesting(true);
    try {
      const res = await fetch('/api/ingest', { method: 'POST' });
      const data = await res.json();
      setLastIngest(data);
      mutateTimeline();
      mutateProjects();
      mutateAlerts();
    } catch (err) {
      console.error('Ingest failed:', err);
    }
    setIngesting(false);
  }, [mutateTimeline, mutateProjects, mutateAlerts]);

  // Auto-ingest on mount (file watcher handles ongoing ingestion server-side)
  /* eslint-disable react-hooks/set-state-in-effect -- intentional fetch on mount */
  useEffect(() => {
    runIngest();
  }, [runIngest]);
  /* eslint-enable react-hooks/set-state-in-effect */

  const acknowledgeAll = async () => {
    if (!alerts?.length) return;
    await fetch('/api/alerts', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'acknowledge_all' }),
    });
    await mutateAlerts();
  };

  // Current rate calculation
  const recentMinutes = (timeline ?? []).slice(-5);
  const currentRate = {
    input: recentMinutes.reduce((s: number, m: any) => s + (m.input_tokens ?? 0), 0),
    output: recentMinutes.reduce((s: number, m: any) => s + (m.output_tokens ?? 0), 0),
    messages: recentMinutes.reduce((s: number, m: any) => s + (m.message_count ?? 0), 0),
  };

  // Project bar chart scaling
  const projectMaxTotal = byProject
    ? Math.max(...byProject.map((p: any) => (p.input_tokens ?? 0) + (p.output_tokens ?? 0)), 1)
    : 1;

  return (
    <div className="space-y-6">
      <PageContext
        pageType="usage-monitor"
        summary={`Usage monitor. Window: ${window === 0 ? 'Lifetime' : `${window}min`}. Input (5min): ${formatTokens(currentRate.input)}, Output (5min): ${formatTokens(currentRate.output)}, Messages (5min): ${currentRate.messages}. ${alerts?.length ?? 0} unacknowledged alerts. DB: ${dbStats ? formatTokens(dbStats.messages) : '?'} messages. Mesh: ${mesh?.summary?.reachableNodes ?? '?'} nodes, ${mesh?.summary?.totalClaudes ?? '?'} claudes, ${mesh?.summary?.totalCores ?? '?'} cores, ${mesh?.summary?.totalMemGB ?? '?'}GB.`}
        metrics={{
          window_minutes: window,
          input_5min: currentRate.input,
          output_5min: currentRate.output,
          messages_5min: currentRate.messages,
          unacknowledged_alerts: alerts?.length ?? 0,
          db_messages: dbStats?.messages ?? 0,
          db_thinking_blocks: dbStats?.thinkingBlocks ?? 0,
        }}
        details={alerts?.map((a: any) => `ALERT: ${a.metric} exceeded ${formatTokens(a.threshold_value)} in ${a.window_minutes}min — actual: ${formatTokens(a.actual_value)}`).join('\n')}
      />
      {/* Alert banner — grouped by metric + window */}
      {alerts && alerts.length > 0 && (() => {
        // Group alerts by metric + window_minutes
        const groups: Record<string, { metric: string; window: number; threshold: number; alerts: any[] }> = {};
        for (const a of alerts) {
          const key = `${a.metric}:${a.window_minutes}`;
          if (!groups[key]) groups[key] = { metric: a.metric, window: a.window_minutes, threshold: a.threshold_value, alerts: [] };
          groups[key].alerts.push(a);
        }
        // Sort groups: higher window first (60 > 15 > 5), then by most recent alert
        const sorted = Object.values(groups).sort((a, b) => b.window - a.window || b.alerts[0]?.triggered_at?.localeCompare(a.alerts[0]?.triggered_at));
        // Peak value across all alerts for sparkline scaling
        const globalPeak = Math.max(...alerts.map((a: any) => a.actual_value), 1);

        return (
          <div className="bg-red-950/60 border border-red-900/60 rounded p-4">
            <div className="flex items-center justify-between mb-3">
              <h3 className="text-sm font-bold text-[var(--color-error)] tracking-wide">
                USAGE ALERTS
                <span className="ml-2 text-xs font-normal text-[var(--color-muted)]">
                  {alerts.length} unacknowledged across {sorted.length} {sorted.length === 1 ? 'threshold' : 'thresholds'}
                </span>
              </h3>
              <button
                onClick={acknowledgeAll}
                className="text-xs text-[var(--color-muted)] hover:text-[var(--color-foreground)] cursor-pointer px-2 py-1 rounded border border-transparent hover:border-[var(--color-border)]"
              >
                Acknowledge all
              </button>
            </div>
            <div className="space-y-2">
              {sorted.map(group => {
                const peak = Math.max(...group.alerts.map((a: any) => a.actual_value));
                const latest = group.alerts[0];
                const windowLabel = group.window >= 60 ? `${group.window / 60}h` : `${group.window}m`;
                return (
                  <details key={`${group.metric}:${group.window}`} className="group">
                    <summary className="flex items-center gap-3 py-2 px-3 rounded bg-red-950/50 hover:bg-red-900/30 cursor-pointer list-none">
                      {/* Window badge */}
                      <span className={`text-[10px] font-bold font-mono px-1.5 py-0.5 rounded flex-shrink-0 ${
                        group.window >= 60 ? 'bg-red-800/80 text-red-200' : group.window >= 15 ? 'bg-orange-900/80 text-orange-300' : 'bg-yellow-900/60 text-yellow-300'
                      }`}>{windowLabel}</span>
                      {/* Metric */}
                      <span className="text-xs font-mono text-[var(--color-error)]">{group.metric}</span>
                      {/* Threshold → peak */}
                      <span className="text-xs text-[var(--color-muted)]">
                        &gt; {formatTokens(group.threshold)} — peak{' '}
                        <span className="text-[var(--color-error)] font-bold">{formatTokens(peak)}</span>
                      </span>
                      {/* Mini bar showing peak relative to global */}
                      <span className="flex-1 h-1 bg-red-950 rounded overflow-hidden mx-2">
                        <span className="block h-full bg-red-500/70 rounded" style={{ width: `${Math.min(100, (peak / globalPeak) * 100)}%` }} />
                      </span>
                      {/* Count */}
                      <span className="text-xs text-[var(--color-muted)] flex-shrink-0">
                        {group.alerts.length}x
                      </span>
                      {/* Recency */}
                      <span className="text-[10px] text-[var(--color-muted)] flex-shrink-0 w-20 text-right truncate">
                        {latest.triggered_at?.replace(/^\d{4}-\d{2}-\d{2}\s*/, '')}
                      </span>
                      <span className="text-[10px] text-[var(--color-muted)] group-open:rotate-90 transition-transform">▸</span>
                    </summary>
                    <div className="ml-8 mt-1 space-y-0.5 max-h-40 overflow-y-auto">
                      {group.alerts.map((a: any) => (
                        <Link
                          key={a.id}
                          href={`/usage/alert/${a.id}`}
                          className="flex items-center gap-2 py-0.5 px-2 text-xs rounded hover:bg-red-900/30"
                        >
                          <span className="text-[var(--color-error)] font-mono font-bold w-16 text-right">{formatTokens(a.actual_value)}</span>
                          <span className="flex-1 h-0.5 bg-red-950 rounded overflow-hidden">
                            <span className="block h-full bg-red-500/50 rounded" style={{ width: `${Math.min(100, (a.actual_value / globalPeak) * 100)}%` }} />
                          </span>
                          <span className="text-[var(--color-muted)] w-28 text-right truncate">{a.triggered_at}</span>
                        </Link>
                      ))}
                    </div>
                  </details>
                );
              })}
            </div>
          </div>
        );
      })()}

      {/* Header */}
      <div className="grid grid-cols-[1fr_auto] items-center">
        <h2 className="text-lg font-bold">Usage Monitor</h2>
        <div className="grid grid-flow-col auto-cols-max items-center gap-3">
          <TimeRangeSelect value={range} onChange={setRange} />
          <button
            onClick={runIngest}
            disabled={ingesting}
            className="bg-[var(--color-accent)] text-black px-3 py-1.5 rounded text-base font-bold disabled:opacity-50"
          >
            {ingesting ? 'Ingesting...' : 'Ingest Now'}
          </button>
        </div>
      </div>

      {/* Tabs */}
      <div className="flex items-center gap-0.5 border-b border-[var(--color-border)]">
        {([
          { id: 'model' as const, label: 'Model Usage', icon: '¤' },
          { id: 'infra' as const, label: 'Infrastructure', icon: '⚡' },
          { id: 'thresholds' as const, label: 'Thresholds', icon: '⚠' },
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

      {/* ============ MODEL USAGE TAB ============ */}
      {activeTab === 'model' && (<>

      {/* Plan spend overview */}
      {plan && (() => {
        const planCap = plan.monthlyPlanCost ?? 0;
        const periodCost = plan.periodCostUSD ?? 0;
        const overage = Math.max(0, periodCost - planCap);
        const pct = planCap > 0 ? Math.min(100, (periodCost / planCap) * 100) : 0;
        const isOver = periodCost > planCap;
        const extraSpent = extra ? parseFloat(extra.extraSpent) : null;
        const extraLimit = extra ? parseFloat(extra.extraLimit) : null;
        const extraPct = extraLimit && extraLimit > 0 ? Math.min(100, ((extraSpent ?? 0) / extraLimit) * 100) : 0;
        return (
          <div className="bg-[var(--color-surface)] rounded border border-[var(--color-border)] p-4">
            <div className="flex items-center justify-between mb-3">
              <h3 className="text-base font-bold text-[var(--color-muted)]">
                Billing Period
                <span className="font-normal ml-2">{plan.periodStart} → {plan.periodEnd}</span>
              </h3>
              <span className="text-xs text-[var(--color-muted)]">
                {plan.subscriptionType} / {(plan.rateLimitTier ?? '').replace('default_claude_', '')}
              </span>
            </div>
            <div className="grid grid-cols-5 gap-4 mb-3">
              <RateCard label="Plan Value" value={`$${planCap}`} />
              <RateCard label="Equiv API Cost" value={`$${periodCost.toFixed(0)}`} warn={isOver} sub={`${pct.toFixed(0)}% of plan`} />
              <RateCard label="Overage Equiv" value={overage > 0 ? `$${overage.toFixed(0)}` : '$0'} warn={overage > 0} sub={overage > 0 ? `${(overage / planCap * 100).toFixed(0)}% over` : 'within plan'} />
              <RateCard label="Card Charges" value={extraSpent !== null ? `$${extraSpent.toFixed(2)}` : '—'} warn={extraPct > 80} sub={extraLimit ? `of $${extraLimit} limit` : ''} />
              <RateCard label="Balance" value={extra?.extraBalance ? `$${parseFloat(extra.extraBalance).toFixed(2)}` : '—'} sub={extra?.extraResetDate ? `resets ${extra.extraResetDate}` : ''} />
            </div>
            {/* Budget bar */}
            <div className="relative h-3 rounded-full bg-[var(--color-background)] border border-[var(--color-border)] overflow-hidden">
              <div
                className="absolute inset-y-0 left-0 rounded-full transition-all"
                style={{
                  width: `${Math.min(pct, 100)}%`,
                  background: isOver
                    ? 'linear-gradient(90deg, #22c55e 0%, #f59e0b 70%, #ef4444 100%)'
                    : 'linear-gradient(90deg, #22c55e, #10b981)',
                }}
              />
              {isOver && (
                <div
                  className="absolute inset-y-0 rounded-r-full bg-red-500/60"
                  style={{
                    left: '100%',
                    width: '0%', // already capped at 100%
                  }}
                />
              )}
              {/* Plan cap marker */}
              <div className="absolute top-0 bottom-0 w-px bg-[var(--color-foreground)]" style={{ left: `${Math.min(100, 100)}%`, opacity: 0.3 }} />
            </div>
            <div className="flex justify-between mt-1 text-xs text-[var(--color-muted)]">
              <span>$0</span>
              <span className={isOver ? 'text-[var(--color-error)] font-bold' : ''}>${periodCost.toFixed(0)} used</span>
              <span>${planCap} plan</span>
            </div>
          </div>
        );
      })()}

      {/* Live rate cards */}
      <div className="grid grid-cols-4 gap-4">
        <RateCard label="Input (5min)" value={formatTokens(currentRate.input)} warn={currentRate.input > 5000000} />
        <RateCard label="Output (5min)" value={formatTokens(currentRate.output)} warn={currentRate.output > 10000000} />
        <RateCard label="Messages (5min)" value={String(currentRate.messages)} warn={currentRate.messages > 50000} />
        <RateCard
          label="DB Records"
          value={dbStats ? formatTokens(dbStats.messages) : '...'}
          sub={dbStats ? `${formatTokens(dbStats.thinkingBlocks)} thinking` : ''}
        />
      </div>

      {/* Token usage timeline */}
      <div className="bg-[var(--color-surface)] rounded border border-[var(--color-border)] p-4">
        <h3 className="text-base font-bold mb-3 text-[var(--color-muted)]">
          Token Usage Timeline
        </h3>
        {timeline && timeline.length > 0 ? (
          <ResponsiveContainer width="100%" height={220}>
            <AreaChart data={timeline}>
              <XAxis
                dataKey="minute"
                tick={{ fill: '#71717a', fontSize: 16 }}
                tickFormatter={(m: string) => {
                  if (m.length <= 10) return m.slice(5); // day: MM-DD
                  if (m.length <= 13) return m.slice(5, 13).replace('T', ' ') + 'h'; // hour: MM-DD HHh
                  return m.slice(11, 16); // minute: HH:MM
                }}
              />
              <YAxis tick={{ fill: '#71717a', fontSize: 16 }} tickFormatter={(v: number) => formatTokens(v)} />
              <Tooltip
                formatter={(v) => formatTokens(Number(v ?? 0))}
              />
              <Area
                type="monotone"
                dataKey="input_tokens"
                name="Input"
                stroke="#22c55e"
                fill="#22c55e"
                fillOpacity={0.2}
                stackId="1"
              />
              <Area
                type="monotone"
                dataKey="output_tokens"
                name="Output"
                stroke="#a78bfa"
                fill="#a78bfa"
                fillOpacity={0.2}
                stackId="1"
              />
              <Area
                type="monotone"
                dataKey="cache_read_tokens"
                name="Cache Read"
                stroke="#10b981"
                fill="#10b981"
                fillOpacity={0.1}
                stackId="1"
              />
            </AreaChart>
          </ResponsiveContainer>
        ) : (
          <div className="text-[var(--color-muted)] text-base py-8 text-center">
            No usage data in window. Hit &quot;Ingest Now&quot; to populate.
          </div>
        )}
      </div>

      {/* Agent Standup + Usage by Project — side by side */}
      <div className="grid grid-cols-2 gap-4 items-start">
        {/* Agent Standup — 30-day project activity */}
        <div className="bg-[var(--color-surface)] rounded border border-[var(--color-border)] p-4">
          <div className="flex items-center justify-between mb-3">
            <h3 className="text-base font-bold text-[var(--color-muted)]">
              Agent Standup ({window === 0 ? 'Lifetime' : window < 1440 ? `${window / 60}h` : `${standupDays}d`})
            </h3>
            {projectActivity && projectActivity.length > 0 && (
              <button
                onClick={toggleAll}
                className="text-xs px-2 py-1 rounded font-mono cursor-pointer transition-colors"
                style={{ color: 'var(--color-muted)', border: '1px solid var(--color-border)' }}
              >
                {allExpanded ? 'Collapse all' : 'Expand all'}
              </button>
            )}
          </div>
          {projectActivity && projectActivity.length > 0 ? (
            <div className="space-y-1">
              {projectActivity.map((p: any) => (
                <div key={p.name}>
                  <div
                    className={`grid grid-cols-[auto_1fr_auto] items-center gap-2 text-base py-1.5 px-2 rounded cursor-pointer hover:bg-[var(--color-surface-hover)] ${
                      !collapsedProjects.has(p.name) ? 'bg-[var(--color-surface-hover)]' : ''
                    }`}
                    onClick={() => toggleProject(p.name)}
                  >
                    <span className={`w-2 h-2 rounded-full shrink-0 ${
                      isActiveRecently(p.last_activity)
                        ? 'bg-[var(--color-accent)] animate-pulse'
                        : isActiveSameDay(p.last_activity)
                          ? 'bg-[var(--color-accent)]'
                          : 'bg-[var(--color-muted)]'
                    }`} />
                    <div className="min-w-0">
                      <span className="font-bold truncate block">{p.display_name}</span>
                      <div className="flex flex-wrap gap-x-3 gap-y-0 text-xs text-[var(--color-muted)]">
                        <span>{p.user_messages.toLocaleString()} prompts</span>
                        <span>{p.session_count} sess</span>
                        <span>{p.active_days}d</span>
                        <span>{formatTokens(p.total_output)} out</span>
                        <span className="text-[var(--color-accent)]">{currency.format(p.cost_estimate)}</span>
                      </div>
                    </div>
                    <span className="text-xs text-[var(--color-muted)] text-right whitespace-nowrap">
                      {p.last_activity ? formatRelativeTime(p.last_activity) : '-'}
                    </span>
                  </div>

                  {!collapsedProjects.has(p.name) && (
                    <StandupProjectDetail projectName={p.name} mutateProjects={mutateProjects} />
                  )}
                </div>
              ))}
            </div>
          ) : (
            <div className="text-[var(--color-muted)] text-base py-4 text-center">
              No project activity in this time range.
            </div>
          )}
        </div>

        {/* Usage by project — CSS Grid bar chart */}
        <div className="bg-[var(--color-surface)] rounded border border-[var(--color-border)] p-4">
          <h3 className="text-base font-bold mb-3 text-[var(--color-muted)]">
            Usage by Project ({window === 0 ? 'Lifetime' : window < 1440 ? `${window / 60}h` : `${window / 1440}d`})
          </h3>
          {byProject && byProject.length > 0 ? (
            <div className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-2 items-center">
              {byProject.map((p: any) => {
                const input = p.input_tokens ?? 0;
                const output = p.output_tokens ?? 0;
                const total = input + output;
                const pct = projectMaxTotal > 0 ? (total / projectMaxTotal) * 100 : 0;
                return (
                  <Fragment key={p.name}>
                    <span className="text-base text-[var(--color-muted)] whitespace-nowrap">{p.display_name}</span>
                    <div
                      className="h-7 rounded bg-[var(--color-background)] overflow-hidden"
                      title={`Input: ${formatTokens(input)} — Output: ${formatTokens(output)}`}
                    >
                      {total > 0 && (
                        <div
                          className="h-full grid"
                          style={{
                            width: `${Math.max(pct, 0.5)}%`,
                            gridTemplateColumns: `${input}fr ${output}fr`,
                          }}
                        >
                          <div className="bg-[#22c55e] h-full" />
                          <div className="bg-[#a78bfa] h-full" />
                        </div>
                      )}
                    </div>
                  </Fragment>
                );
              })}
              {/* Scale */}
              <span />
              <div className="grid grid-cols-[auto_1fr_auto] text-base text-[var(--color-muted)]">
                <span>0</span>
                <span />
                <span>{formatTokens(projectMaxTotal)}</span>
              </div>
              {/* Legend */}
              <span />
              <div className="grid grid-flow-col auto-cols-max gap-4 text-base text-[var(--color-muted)]">
                <span><span className="inline-block w-3 h-3 rounded bg-[#22c55e] mr-1.5 align-middle" />Input</span>
                <span><span className="inline-block w-3 h-3 rounded bg-[#a78bfa] mr-1.5 align-middle" />Output</span>
              </div>
            </div>
          ) : (
            <div className="text-[var(--color-muted)] text-base py-4 text-center">
              No per-project usage data in window.
            </div>
          )}
        </div>
      </div>

      {/* Last ingest result */}
      {lastIngest && (
        <div className="text-base text-[var(--color-muted)] bg-[var(--color-surface)] rounded border border-[var(--color-border)] p-3">
          Last ingest: {lastIngest.ingested?.messagesAdded} msgs,{' '}
          {lastIngest.ingested?.blocksAdded} blocks,{' '}
          {lastIngest.ingested?.filesScanned} files scanned,{' '}
          {lastIngest.ingested?.providenceAdded ?? 0} providence,{' '}
          {lastIngest.ingested?.alertsTriggered} alerts triggered.
          DB: {lastIngest.db?.messages} total msgs, {lastIngest.db?.thinkingBlocks} thinking blocks.
        </div>
      )}

      </>)}

      {/* ============ THRESHOLDS TAB ============ */}
      {activeTab === 'thresholds' && (<>

      {/* Alert thresholds config */}
      <div className="bg-[var(--color-surface)] rounded border border-[var(--color-border)] p-4">
        <h3 className="text-base font-bold mb-3 text-[var(--color-muted)]">
          Alert Thresholds
        </h3>
        {thresholds && (
          <table className="w-full text-base">
            <thead>
              <tr className="text-left text-[var(--color-muted)] border-b border-[var(--color-border)]">
                <th className="pb-2">Window</th>
                <th className="pb-2">Metric</th>
                <th className="pb-2 text-right">Threshold</th>
                <th className="pb-2 text-center">Enabled</th>
              </tr>
            </thead>
            <tbody>
              {thresholds.map((t: any) => (
                <tr
                  key={t.id}
                  className="border-b border-[var(--color-border)]"
                >
                  <td className="py-1.5">{t.window_minutes}min</td>
                  <td className="py-1.5">{t.metric}</td>
                  <td className="py-1.5 text-right">
                    <input
                      type="number"
                      defaultValue={t.threshold_value}
                      className="bg-[var(--color-background)] border border-[var(--color-border)] rounded px-2 py-0.5 text-right w-28 text-base"
                      onBlur={async (e) => {
                        const val = Number(e.target.value);
                        if (val > 0) {
                          await fetch('/api/alerts', {
                            method: 'POST',
                            headers: { 'Content-Type': 'application/json' },
                            body: JSON.stringify({
                              action: 'update_threshold',
                              id: t.id,
                              value: val,
                              enabled: !!t.enabled,
                            }),
                          });
                          mutateThresholds();
                        }
                      }}
                    />
                  </td>
                  <td className="py-1.5 text-center">
                    <input
                      type="checkbox"
                      defaultChecked={!!t.enabled}
                      className="accent-[var(--color-accent)]"
                      onChange={async (e) => {
                        await fetch('/api/alerts', {
                          method: 'POST',
                          headers: { 'Content-Type': 'application/json' },
                          body: JSON.stringify({
                            action: 'update_threshold',
                            id: t.id,
                            value: t.threshold_value,
                            enabled: e.target.checked,
                          }),
                        });
                        mutateThresholds();
                      }}
                    />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {/* Recent alerts log */}
      {allAlerts && allAlerts.length > 0 && (
        <div className="bg-[var(--color-surface)] rounded border border-[var(--color-border)] p-4">
          <h3 className="text-base font-bold mb-3 text-[var(--color-muted)]">
            Alert History
          </h3>
          <div className="space-y-1 max-h-64 overflow-auto">
            {allAlerts.map((a: any) => (
              <Link
                key={a.id}
                href={`/alerts/${a.id}`}
                className={`text-base py-1 grid grid-cols-[9rem_5rem_6rem_1fr_auto] gap-3 hover:bg-[var(--color-surface-hover)] rounded px-1 cursor-pointer ${
                  a.acknowledged
                    ? 'text-[var(--color-muted)]'
                    : 'text-[var(--color-error)]'
                }`}
              >
                <span>{a.triggered_at}</span>
                <span>{a.window_minutes}min</span>
                <span className="font-bold">{a.metric}</span>
                <span>
                  {formatTokens(a.actual_value)} / {formatTokens(a.threshold_value)}
                </span>
                {a.acknowledged ? (
                  <span className="text-[var(--color-accent)]">ack</span>
                ) : (
                  <span />
                )}
              </Link>
            ))}
          </div>
        </div>
      )}

      </>)}

      {/* ============ INFRASTRUCTURE TAB ============ */}
      {activeTab === 'infra' && (<>

      {/* Mesh Status */}
      {(mesh || unsandbox) && (
        <div className="bg-[var(--color-surface)] rounded border border-[var(--color-border)] p-4">
          <div className="flex items-center justify-between mb-3">
            <h3 className="text-base font-bold text-[var(--color-muted)]">
              Permacomputer Mesh
            </h3>
            <div className="flex items-center gap-4 text-sm">
              <span className="text-[var(--color-accent)] font-bold">{mesh.summary?.totalClaudes ?? 0} claudes</span>
              <span className="text-[var(--color-muted)]">{mesh.summary?.totalCores ?? 0} cores</span>
              <span className="text-[var(--color-muted)]">{mesh.summary?.totalMemGB ?? 0}GB total</span>
              <span className="text-[var(--color-muted)]">{(mesh.summary?.reachableNodes ?? 0) + (unsandbox?.connected ? 1 : 0)}/{(mesh.summary?.totalNodes ?? 0) + (unsandbox ? 1 : 0)} nodes</span>
              {(() => {
                const reachable = (mesh.nodes ?? []).filter((n: any) => n.reachable);
                const elecCost = reachable.reduce((sum: number, n: any) => {
                  const wo = getWattsOverride(n.hostname);
                  let sysW = wo || n.powerWatts || 0;
                  const diskOv = getDiskOverride(n.hostname);
                  if (!wo && diskOv !== undefined) {
                    sysW += Math.max(0, diskOv - (n.spinningDisks ?? 0)) * 8;
                  }
                  const watts = sysW + (n.gpuPowerWatts ?? 0);
                  return sum + (watts * 24 * 30 / 1000) * getKwhRate(n.hostname);
                }, 0);
                const ispTotal = reachable.reduce((sum: number, n: any) => sum + getIspCost(n.hostname), 0);
                const totalCost = elecCost + ispTotal;
                return <span className="text-[var(--color-accent)]">~{currency.format(totalCost)}/mo</span>;
              })()}
              <span className="text-[var(--color-muted)]">{mesh.summary?.totalPowerWatts ?? 0}W total</span>
            </div>
          </div>
          <div className="grid gap-3" style={{ gridTemplateColumns: `repeat(${Math.min((mesh.nodes?.length ?? 0) + (unsandbox ? 1 : 0), 3)}, 1fr)` }}>
            {mesh.nodes?.map((node: any) => (
              <MeshNodeCard key={node.hostname} node={node} kwhRate={getKwhRate(node.hostname)} onRateChange={saveKwhRate} ispCost={getIspCost(node.hostname)} onIspCostChange={saveIspCost} diskOverride={getDiskOverride(node.hostname)} onDiskOverrideChange={saveDiskOverride} wattsOverride={getWattsOverride(node.hostname)} onWattsOverrideChange={saveWattsOverride} formatCost={currency.format} />
            ))}
            {unsandbox && <UnsandboxCard status={unsandbox} probe={unsandboxProbe} />}
          </div>
        </div>
      )}

      {/* APMonitor Network Status */}
      {apmonitor && apmonitor.summary?.totalResources > 0 && (
        <div className="bg-[var(--color-surface)] rounded border border-[var(--color-border)] p-4">
          <div className="flex items-center justify-between mb-3">
            <h3 className="text-base font-bold text-[var(--color-muted)]">
              APMonitor Network Status
            </h3>
            <div className="flex items-center gap-4 text-sm">
              <span className="text-[var(--color-accent)] font-bold">{apmonitor.summary.up} up</span>
              {apmonitor.summary.down > 0 && (
                <span className="text-[var(--color-error)] font-bold">{apmonitor.summary.down} down</span>
              )}
              <span className="text-[var(--color-muted)]">{apmonitor.summary.totalResources} resources</span>
              <span className="text-[var(--color-muted)]">{apmonitor.summary.nodesWithData}/{apmonitor.summary.nodesPolled} nodes</span>
            </div>
          </div>
          <div className="grid gap-2">
            {apmonitor.nodes?.filter((n: any) => n.resources?.length > 0).map((node: any) => (
              <div key={node.host}>
                <div className="text-xs text-[var(--color-muted)] mb-1 font-bold uppercase tracking-wider">{node.host}</div>
                <div className="grid gap-1">
                  {node.resources.map((r: any) => (
                    <div
                      key={`${node.host}-${r.name}`}
                      className={`flex items-center gap-3 px-3 py-1.5 rounded text-sm ${
                        r.isUp
                          ? 'text-[var(--color-muted)]'
                          : 'bg-red-950/30 text-[var(--color-error)]'
                      }`}
                    >
                      <span className={`w-2 h-2 rounded-full shrink-0 ${r.isUp ? 'bg-[var(--color-accent)]' : 'bg-[var(--color-error)] animate-pulse'}`} />
                      <span className="font-bold min-w-[10rem]">{r.name}</span>
                      {r.lastResponseTimeMs != null && (
                        <span className="text-xs">{r.lastResponseTimeMs}ms</span>
                      )}
                      {!r.isUp && r.errorReason && (
                        <span className="text-xs truncate">{r.errorReason}</span>
                      )}
                      {!r.isUp && r.downCount > 0 && (
                        <span className="text-xs">({r.downCount}x)</span>
                      )}
                      <span className="text-xs text-[var(--color-muted)] ml-auto">
                        {r.lastChecked ? formatRelativeTime(r.lastChecked) : 'never'}
                      </span>
                    </div>
                  ))}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Mesh Time-Series Charts */}
      {meshHistory?.timeline?.length > 0 && (() => {
        const hostnames: string[] = meshHistory.hostnames ?? [];
        const NODE_COLORS = ['#22c55e', '#f97316', '#a78bfa', '#60a5fa', '#f43f5e', '#facc15', '#2dd4bf', '#e879f9'];
        const isPerNode = chartHostname === 'per-node' && hostnames.length > 1;
        const isSingleNode = chartHostname !== 'all' && chartHostname !== 'per-node';

        // Enrich timeline with per-node flattened keys and electricity cost
        const chartData = meshHistory.timeline.map((t: any) => {
          const point: any = { ...t };
          // Electricity cost: watts → $/hour
          point.elecCostPerHour = Math.round((t.totalWatts / 1000) * DEFAULT_KWH_RATE * 100) / 100;
          // Single-node filter
          if (isSingleNode && t.nodes?.[chartHostname]) {
            const n = t.nodes[chartHostname];
            point.totalWatts = n.watts;
            point.cpuWatts = n.watts - (n.gpuWatts ?? 0);
            point.gpuWatts = n.gpuWatts ?? 0;
            point.totalLoad = n.load;
            point.totalCores = n.cores;
            point.memUsedGB = n.memUsed;
            point.claudes = n.claudes;
            point.gpuUtil = n.gpuUtil ?? 0;
            point.gpuMemUsedGB = Math.round((n.gpuMemUsedMB ?? 0) / 1024 * 10) / 10;
            point.gpuMemTotalGB = Math.round((n.gpuMemTotalMB ?? 0) / 1024 * 10) / 10;
            point.elecCostPerHour = Math.round((n.watts / 1000) * getKwhRate(chartHostname) * 100) / 100;
          }
          // Per-node breakout keys
          if (isPerNode && t.nodes) {
            for (const h of hostnames) {
              point[`watts_${h}`] = t.nodes[h]?.watts ?? 0;
              point[`load_${h}`] = t.nodes[h]?.load ?? 0;
              point[`mem_${h}`] = t.nodes[h]?.memUsed ?? 0;
              point[`claudes_${h}`] = t.nodes[h]?.claudes ?? 0;
              point[`gpuUtil_${h}`] = t.nodes[h]?.gpuUtil ?? 0;
              point[`gpuWatts_${h}`] = t.nodes[h]?.gpuWatts ?? 0;
            }
          }
          return point;
        });
        const last = chartData[chartData.length - 1];
        const tooltipStyle = { background: '#18181b', border: '1px solid #3f3f46', borderRadius: 4 };
        const xAxisProps = { dataKey: 'timestamp', tick: { fill: '#71717a', fontSize: 12 }, tickFormatter: (t: string) => t.slice(11, 16) };

        return (
        <div className="space-y-4">
          {/* Hostname filter */}
          <div className="flex items-center gap-3">
            <span className="text-xs text-[var(--color-muted)] uppercase tracking-wider">Filter</span>
            <select
              value={chartHostname}
              onChange={(e) => setChartHostname(e.target.value)}
              className="bg-[var(--color-background)] border border-[var(--color-border)] rounded px-2 py-1 text-sm"
            >
              <option value="all">All Nodes (aggregate)</option>
              <option value="per-node">Per-Node Breakout</option>
              {hostnames.map((h: string) => (
                <option key={h} value={h}>{h}</option>
              ))}
            </select>
          </div>

          <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">

          {/* Claude Processes */}
          <div className="bg-[var(--color-surface)] rounded border border-[var(--color-border)] p-4">
            <h3 className="text-base font-bold mb-3 text-[var(--color-muted)]">
              Active Claudes
              <span className="text-xs font-normal ml-2 text-[var(--color-muted)]">
                {last?.claudes ?? 0} current
              </span>
            </h3>
            <ResponsiveContainer width="100%" height={160}>
              <AreaChart data={chartData}>
                <XAxis {...xAxisProps} />
                <YAxis tick={{ fill: '#71717a', fontSize: 12 }} allowDecimals={false} />
                <Tooltip labelFormatter={(t) => String(t)} formatter={(v, name) => [v, name]} contentStyle={tooltipStyle} />
                {isPerNode ? (<>
                  <Legend />
                  {hostnames.map((h, i) => (
                    <Area key={h} type="stepAfter" dataKey={`claudes_${h}`} name={h} stroke={NODE_COLORS[i % NODE_COLORS.length]} fill={NODE_COLORS[i % NODE_COLORS.length]} fillOpacity={0.15} stackId="claudes" dot={false} />
                  ))}
                </>) : (
                  <Area type="stepAfter" dataKey="claudes" name="Claudes" stroke="var(--color-accent)" fill="var(--color-accent)" fillOpacity={0.2} dot={false} />
                )}
              </AreaChart>
            </ResponsiveContainer>
          </div>

          {/* Power Wattage */}
          <div className="bg-[var(--color-surface)] rounded border border-[var(--color-border)] p-4">
            <h3 className="text-base font-bold mb-3 text-[var(--color-muted)]">
              Compute Wattage
              <span className="text-xs font-normal ml-2 text-[var(--color-muted)]">
                {last?.totalWatts ?? 0}W current
              </span>
            </h3>
            <ResponsiveContainer width="100%" height={200}>
              <LineChart data={chartData}>
                <XAxis {...xAxisProps} />
                <YAxis tick={{ fill: '#71717a', fontSize: 12 }} unit="W" />
                <Tooltip labelFormatter={(t) => String(t)} formatter={(v, name) => [`${v}W`, name]} contentStyle={tooltipStyle} />
                <Legend />
                {isPerNode ? (
                  hostnames.map((h, i) => (
                    <Line key={h} type="monotone" dataKey={`watts_${h}`} name={h} stroke={NODE_COLORS[i % NODE_COLORS.length]} strokeWidth={1.5} dot={false} />
                  ))
                ) : (<>
                  <Line type="monotone" dataKey="totalWatts" name="Total" stroke="var(--color-accent)" strokeWidth={2} dot={false} />
                  <Line type="monotone" dataKey="cpuWatts" name="CPU" stroke="#f97316" strokeWidth={1.5} dot={false} />
                  {chartData.some((t: any) => t.gpuWatts > 0) && (
                    <Line type="monotone" dataKey="gpuWatts" name="GPU" stroke="#a78bfa" strokeWidth={1.5} dot={false} />
                  )}
                </>)}
              </LineChart>
            </ResponsiveContainer>
          </div>

          {/* Electricity Cost */}
          <div className="bg-[var(--color-surface)] rounded border border-[var(--color-border)] p-4">
            <h3 className="text-base font-bold mb-3 text-[var(--color-muted)]">
              Electricity Cost
              <span className="text-xs font-normal ml-2 text-[var(--color-muted)]">
                {currency.format(last?.elecCostPerHour ?? 0)}/hr &middot; ~{currency.format((last?.elecCostPerHour ?? 0) * 24 * 30)}/mo
              </span>
            </h3>
            <ResponsiveContainer width="100%" height={160}>
              <AreaChart data={chartData}>
                <XAxis {...xAxisProps} />
                <YAxis tick={{ fill: '#71717a', fontSize: 12 }} tickFormatter={(v: number) => `$${v.toFixed(2)}`} />
                <Tooltip labelFormatter={(t) => String(t)} formatter={(v) => [`$${Number(v).toFixed(3)}/hr`]} contentStyle={tooltipStyle} />
                <Area type="monotone" dataKey="elecCostPerHour" name="$/hr" stroke="#facc15" fill="#facc15" fillOpacity={0.2} dot={false} />
              </AreaChart>
            </ResponsiveContainer>
          </div>

          {/* CPU Load */}
          <div className="bg-[var(--color-surface)] rounded border border-[var(--color-border)] p-4">
            <h3 className="text-base font-bold mb-3 text-[var(--color-muted)]">
              CPU Load
              <span className="text-xs font-normal ml-2 text-[var(--color-muted)]">
                {last?.totalLoad ?? 0} / {last?.totalCores ?? 0} cores
              </span>
            </h3>
            <ResponsiveContainer width="100%" height={200}>
              <AreaChart data={chartData}>
                <XAxis {...xAxisProps} />
                <YAxis tick={{ fill: '#71717a', fontSize: 12 }} />
                <Tooltip labelFormatter={(t) => String(t)} formatter={(v, name) => [typeof v === 'number' ? v.toFixed(1) : v, name]} contentStyle={tooltipStyle} />
                <Legend />
                {isPerNode ? (
                  hostnames.map((h, i) => (
                    <Area key={h} type="monotone" dataKey={`load_${h}`} name={h} stroke={NODE_COLORS[i % NODE_COLORS.length]} fill={NODE_COLORS[i % NODE_COLORS.length]} fillOpacity={0.15} stackId="load" dot={false} />
                  ))
                ) : (<>
                  <Area type="monotone" dataKey="totalCores" name="Total Cores" stroke="#3f3f46" fill="#3f3f46" fillOpacity={0.2} dot={false} />
                  <Area type="monotone" dataKey="totalLoad" name="Load Average" stroke="#f97316" fill="#f97316" fillOpacity={0.3} dot={false} />
                </>)}
              </AreaChart>
            </ResponsiveContainer>
          </div>

          {/* Memory Usage */}
          <div className="bg-[var(--color-surface)] rounded border border-[var(--color-border)] p-4">
            <h3 className="text-base font-bold mb-3 text-[var(--color-muted)]">
              Memory Usage
              <span className="text-xs font-normal ml-2 text-[var(--color-muted)]">
                {last?.memUsedGB ?? 0} / {last?.memTotalGB ?? 0} GB
              </span>
            </h3>
            <ResponsiveContainer width="100%" height={200}>
              <AreaChart data={chartData}>
                <XAxis {...xAxisProps} />
                <YAxis tick={{ fill: '#71717a', fontSize: 12 }} unit="GB" />
                <Tooltip labelFormatter={(t) => String(t)} formatter={(v, name) => [`${v}GB`, name]} contentStyle={tooltipStyle} />
                <Legend />
                {isPerNode ? (
                  hostnames.map((h, i) => (
                    <Area key={h} type="monotone" dataKey={`mem_${h}`} name={h} stroke={NODE_COLORS[i % NODE_COLORS.length]} fill={NODE_COLORS[i % NODE_COLORS.length]} fillOpacity={0.15} stackId="mem" dot={false} />
                  ))
                ) : (<>
                  <Area type="monotone" dataKey="memTotalGB" name="Total" stroke="#3f3f46" fill="#3f3f46" fillOpacity={0.2} dot={false} />
                  <Area type="monotone" dataKey="memUsedGB" name="Used" stroke="#60a5fa" fill="#60a5fa" fillOpacity={0.3} dot={false} />
                </>)}
              </AreaChart>
            </ResponsiveContainer>
          </div>

          {/* GPU Utilization */}
          {chartData.some((t: any) => t.gpuUtil > 0 || t.gpuWatts > 0) && (
          <div className="bg-[var(--color-surface)] rounded border border-[var(--color-border)] p-4">
            <h3 className="text-base font-bold mb-3 text-[var(--color-muted)]">
              GPU Utilization
              <span className="text-xs font-normal ml-2 text-[var(--color-muted)]">
                {last?.gpuUtil ?? 0}%
              </span>
            </h3>
            <ResponsiveContainer width="100%" height={200}>
              <AreaChart data={chartData}>
                <XAxis {...xAxisProps} />
                <YAxis tick={{ fill: '#71717a', fontSize: 12 }} unit="%" domain={[0, 100]} />
                <Tooltip labelFormatter={(t) => String(t)} formatter={(v, name) => [`${v}%`, name]} contentStyle={tooltipStyle} />
                <Legend />
                {isPerNode ? (
                  hostnames.map((h, i) => (
                    <Area key={h} type="monotone" dataKey={`gpuUtil_${h}`} name={h} stroke={NODE_COLORS[i % NODE_COLORS.length]} fill={NODE_COLORS[i % NODE_COLORS.length]} fillOpacity={0.15} stackId="gpuUtil" dot={false} />
                  ))
                ) : (
                  <Area type="monotone" dataKey="gpuUtil" name="GPU Util" stroke="#22c55e" fill="#22c55e" fillOpacity={0.3} dot={false} />
                )}
              </AreaChart>
            </ResponsiveContainer>
          </div>
          )}

          {/* GPU Power */}
          {chartData.some((t: any) => t.gpuWatts > 0) && (
          <div className="bg-[var(--color-surface)] rounded border border-[var(--color-border)] p-4">
            <h3 className="text-base font-bold mb-3 text-[var(--color-muted)]">
              GPU Power
              <span className="text-xs font-normal ml-2 text-[var(--color-muted)]">
                {last?.gpuWatts ?? 0}W
              </span>
            </h3>
            <ResponsiveContainer width="100%" height={200}>
              <AreaChart data={chartData}>
                <XAxis {...xAxisProps} />
                <YAxis tick={{ fill: '#71717a', fontSize: 12 }} unit="W" />
                <Tooltip labelFormatter={(t) => String(t)} formatter={(v, name) => [`${v}W`, name]} contentStyle={tooltipStyle} />
                <Legend />
                {isPerNode ? (
                  hostnames.map((h, i) => (
                    <Area key={h} type="monotone" dataKey={`gpuWatts_${h}`} name={h} stroke={NODE_COLORS[i % NODE_COLORS.length]} fill={NODE_COLORS[i % NODE_COLORS.length]} fillOpacity={0.15} stackId="gpuW" dot={false} />
                  ))
                ) : (
                  <Area type="monotone" dataKey="gpuWatts" name="GPU Power" stroke="#a78bfa" fill="#a78bfa" fillOpacity={0.3} dot={false} />
                )}
              </AreaChart>
            </ResponsiveContainer>
          </div>
          )}

          {/* GPU Memory */}
          {chartData.some((t: any) => t.gpuMemTotalGB > 0) && (
          <div className="bg-[var(--color-surface)] rounded border border-[var(--color-border)] p-4">
            <h3 className="text-base font-bold mb-3 text-[var(--color-muted)]">
              GPU Memory
              <span className="text-xs font-normal ml-2 text-[var(--color-muted)]">
                {last?.gpuMemUsedGB ?? 0} / {last?.gpuMemTotalGB ?? 0} GB
              </span>
            </h3>
            <ResponsiveContainer width="100%" height={200}>
              <AreaChart data={chartData}>
                <XAxis {...xAxisProps} />
                <YAxis tick={{ fill: '#71717a', fontSize: 12 }} unit="GB" />
                <Tooltip labelFormatter={(t) => String(t)} formatter={(v, name) => [`${v}GB`, name]} contentStyle={tooltipStyle} />
                <Legend />
                <Area type="monotone" dataKey="gpuMemTotalGB" name="Total" stroke="#3f3f46" fill="#3f3f46" fillOpacity={0.2} dot={false} />
                <Area type="monotone" dataKey="gpuMemUsedGB" name="Used" stroke="#22c55e" fill="#22c55e" fillOpacity={0.3} dot={false} />
              </AreaChart>
            </ResponsiveContainer>
          </div>
          )}

          </div>{/* end grid */}
        </div>
        );
      })()}

      </>)}

    </div>
  );
}

// ---------- standup project detail (own SWR per project) ----------

function StandupProjectDetail({ projectName, mutateProjects }: {
  projectName: string;
  mutateProjects: () => void;
}) {
  const { data: projectDetail, mutate: mutateDetail } = useSWR(
    `/api/projects/activity?project=${encodeURIComponent(projectName)}`,
    fetcher
  );
  const [agentAction, setAgentAction] = useState<{ action: string; loading: boolean; result: any } | null>(null);

  const dispatch = useCallback(async (action: string) => {
    setAgentAction({ action, loading: true, result: null });
    try {
      const res = await fetch(`/api/projects/${encodeURIComponent(projectName)}/agent`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action }),
      });
      if (!res.ok) {
        const text = await res.text();
        let msg: string;
        try { msg = JSON.parse(text).error; } catch { msg = text.slice(0, 200); }
        setAgentAction({ action, loading: false, result: { summary: msg, severity: 'error' } });
        return;
      }
      const data = await res.json();

      if (action === 'nudge' && data.status === 'spawned') {
        setAgentAction({ action, loading: true, result: { summary: `Agent spawned (${data.harness})...`, severity: 'info' } });
        const pollId = data.actionId;
        (async () => {
          for (let i = 0; i < 120; i++) {
            await new Promise(r => setTimeout(r, 5000));
            try {
              const pr = await fetch(`/api/projects/${encodeURIComponent(projectName)}/agent`);
              const pd = await pr.json();
              const found = pd.actions?.find((a: any) => a.id === pollId);
              if (found && found.status !== 'running') {
                const parsed = typeof found.result === 'string' ? JSON.parse(found.result) : found.result;
                setAgentAction({ action, loading: false, result: parsed });
                mutateDetail();
                mutateProjects();
                return;
              }
            } catch { /* retry */ }
          }
          setAgentAction({ action, loading: false, result: { summary: 'Agent timed out', severity: 'error' } });
        })();
        return;
      }

      setAgentAction({ action, loading: false, result: data.result ?? data });
      if (action === 'finish') { mutateDetail(); mutateProjects(); }
    } catch (err: any) {
      setAgentAction({ action, loading: false, result: { error: err.message } });
    }
  }, [projectName, mutateDetail, mutateProjects]);

  if (!projectDetail) {
    return <div className="ml-5 pl-3 border-l-2 border-[var(--color-border)] py-2 text-xs text-[var(--color-muted)]">Loading...</div>;
  }

  const aa = agentAction;

  return (
    <div className="ml-5 pl-3 border-l-2 border-[var(--color-border)] py-2 space-y-1.5">
      {projectDetail.git && (projectDetail.git.isDirty || projectDetail.git.unpushedCount > 0) && (
        <div className="flex gap-2 mb-1">
          {projectDetail.git.isDirty && (
            <Link
              href={`/usage/review/${encodeURIComponent(projectName)}`}
              className="text-xs px-1.5 py-0.5 rounded bg-yellow-500/20 text-yellow-400 font-mono hover:bg-yellow-500/30 transition-colors"
              onClick={(e) => e.stopPropagation()}
            >
              uncommitted changes &rarr;
            </Link>
          )}
          {projectDetail.git.unpushedCount > 0 && (
            <span className="text-xs px-1.5 py-0.5 rounded bg-orange-500/20 text-orange-400 font-mono">
              {projectDetail.git.unpushedCount} unpushed
            </span>
          )}
        </div>
      )}
      {/* Agent action buttons — only when filesystem is dirty or has unpushed commits */}
      {projectDetail.git && (projectDetail.git.isDirty || projectDetail.git.unpushedCount > 0) && <div className="flex gap-1.5 mb-2">
        {(['status', 'blockers', 'finish', 'nudge'] as const).map((act) => (
          <button
            key={act}
            onClick={(e) => { e.stopPropagation(); dispatch(act); }}
            disabled={!!aa?.loading}
            className="text-xs px-2 py-1 rounded font-mono cursor-pointer transition-colors disabled:opacity-50"
            style={{
              backgroundColor: act === 'finish' ? 'var(--color-accent)' : act === 'nudge' ? '#7c3aed' : 'var(--color-background)',
              color: act === 'finish' || act === 'nudge' ? '#fff' : 'var(--color-foreground)',
              border: `1px solid ${act === 'finish' ? 'var(--color-accent)' : act === 'nudge' ? '#7c3aed' : 'var(--color-border)'}`,
            }}
          >
            {aa?.action === act && aa.loading
              ? act === 'nudge' ? 'Agent running...' : '...'
              : act === 'status' ? 'Status' : act === 'blockers' ? 'Blockers' : act === 'finish' ? 'Finish & Push' : 'Nudge Agent'}
          </button>
        ))}
      </div>}
      {aa?.result && (
        <div
          className="text-xs font-mono rounded p-2 mb-2 whitespace-pre-wrap"
          style={{
            backgroundColor: 'var(--color-background)',
            border: `1px solid ${
              aa.loading
                ? '#7c3aed'
                : aa.result.severity === 'error' || aa.result.needsHuman
                  ? 'var(--color-error)'
                  : aa.result.severity === 'warning'
                    ? '#f59e0b'
                    : 'var(--color-border)'
            }`,
            color: 'var(--color-foreground)',
          }}
        >
          <div className="font-bold mb-1 flex items-center gap-2" style={{
            color: aa.loading
              ? '#7c3aed'
              : aa.result.error
                ? 'var(--color-error)'
                : aa.result.needsHuman
                  ? 'var(--color-error)'
                  : aa.result.severity === 'warning'
                    ? '#f59e0b'
                    : '#10b981',
          }}>
            {aa.loading && <span className="inline-block w-2 h-2 rounded-full animate-pulse" style={{ backgroundColor: '#7c3aed' }} />}
            {aa.result.summary ?? aa.result.error ?? 'Done'}
          </div>
          {aa.result.lines?.map((l: string, i: number) => (
            <div key={i} style={{ color: 'var(--color-muted)' }}>{l}</div>
          ))}
          {aa.result.blockers?.map((b: any, i: number) => (
            <div key={i} className="flex gap-2 mt-1">
              <span style={{ color: b.severity === 'error' ? 'var(--color-error)' : '#f59e0b' }}>
                {b.severity === 'error' ? '!' : '?'}
              </span>
              <span>{b.description}</span>
            </div>
          ))}
          {aa.result.actions?.map((a: string, i: number) => (
            <div key={i} style={{ color: '#10b981' }}>{a}</div>
          ))}
          {aa.result.response && typeof aa.result.response === 'string' && (
            <div className="mt-1 border-t border-[var(--color-border)] pt-1" style={{ color: 'var(--color-foreground)' }}>
              {aa.result.response.slice(0, 2000)}
            </div>
          )}
          {aa.result.stderr && (
            <div className="mt-1 border-t border-[var(--color-border)] pt-1" style={{ color: 'var(--color-error)' }}>
              {aa.result.stderr}
            </div>
          )}
        </div>
      )}

      {projectDetail.recentPrompts && projectDetail.recentPrompts.length > 0 ? (
        <>
          <div className="text-xs font-bold text-[var(--color-muted)] mb-1">Recent prompts:</div>
          {projectDetail.recentPrompts.map((rp: any, i: number) => (
            <div key={i} className="text-xs grid grid-cols-[6rem_1fr] gap-2">
              <span className="text-[var(--color-muted)]">
                {rp.timestamp ? formatRelativeTime(rp.timestamp) : ''}
              </span>
              <div className="flex items-start gap-1.5">
                <span className="text-[var(--color-foreground)] break-words flex-1">
                  {rp.prompt}
                </span>
                {rp.commitHash && (
                  <span className="shrink-0 text-xs px-1 py-0.5 rounded bg-green-500/20 text-green-400 font-mono" title={rp.commitSubject}>
                    {rp.commitHash}
                  </span>
                )}
                {rp.gitStatus === 'uncommitted' && (
                  <span className="shrink-0 text-xs px-1 py-0.5 rounded bg-yellow-500/20 text-yellow-400 font-mono">
                    uncommitted
                  </span>
                )}
                {rp.gitStatus === 'unpushed' && (
                  <span className="shrink-0 text-xs px-1 py-0.5 rounded bg-orange-500/20 text-orange-400 font-mono">
                    unpushed
                  </span>
                )}
              </div>
            </div>
          ))}
        </>
      ) : (
        <div className="text-xs text-[var(--color-muted)]">No recent prompts found.</div>
      )}
    </div>
  );
}

function isActiveRecently(timestamp: string | null): boolean {
  if (!timestamp) return false;
  const diff = Date.now() - new Date(timestamp).getTime();
  return diff < 10 * 60 * 1000; // active in last 10 minutes
}

function isActiveSameDay(timestamp: string | null): boolean {
  if (!timestamp) return false;
  const d = new Date(timestamp);
  const now = new Date();
  return d.toDateString() === now.toDateString();
}

const DEFAULT_KWH_RATE = 0.31; // USD per kWh — unsandbox default

// No longer estimating power — mesh API provides TDP-based or RAPL watts

function MeshNodeCard({ node, kwhRate, onRateChange, ispCost, onIspCostChange, diskOverride, onDiskOverrideChange, wattsOverride, onWattsOverrideChange, formatCost }: { node: any; kwhRate: number; onRateChange: (hostname: string, rate: number) => void; ispCost: number; onIspCostChange: (hostname: string, cost: number) => void; diskOverride?: number; onDiskOverrideChange: (hostname: string, count: number) => void; wattsOverride?: number; onWattsOverrideChange: (hostname: string, watts: number) => void; formatCost: (usd: number) => string }) {
  if (!node.reachable) {
    return (
      <div className="rounded border border-[var(--color-border)] p-3 opacity-40">
        <div className="flex items-center gap-2 mb-2">
          <span className="w-2 h-2 rounded-full bg-[var(--color-error)]" />
          <Link href={`/usage/node/${encodeURIComponent(node.hostname)}`} className="font-bold text-sm text-[var(--color-accent)] hover:underline">
            {node.hostname}
          </Link>
          <span className="text-xs text-[var(--color-error)] ml-auto">{node.error || 'Unreachable'}</span>
        </div>
      </div>
    );
  }

  const memPct = node.memTotalGB > 0 ? (node.memUsedGB / node.memTotalGB) * 100 : 0;
  const loadPerCore = node.cpuCores > 0 ? node.loadAvg[0] / node.cpuCores : 0;
  const loadWarn = loadPerCore > 2;
  const memWarn = memPct > 85;

  return (
    <div className={`rounded border p-3 ${loadWarn || memWarn ? 'border-[var(--color-error)] bg-red-950/30' : 'border-[var(--color-border)]'}`}>
      {/* Header */}
      <div className="flex items-center gap-2 mb-3">
        <span className="w-2 h-2 rounded-full bg-[var(--color-accent)] animate-pulse" />
        <Link href={`/usage/node/${encodeURIComponent(node.hostname)}`} className="font-bold text-sm text-[var(--color-accent)] hover:underline transition-colors">
          {node.hostname}
        </Link>
        <span className="text-xs text-[var(--color-muted)] ml-auto">up {node.uptime}</span>
      </div>

      {/* Claude count — hero stat */}
      <div className="flex items-baseline gap-2 mb-3">
        <span className="text-3xl font-bold text-[var(--color-accent)]">{node.claudeProcesses}</span>
        <span className="text-sm text-[var(--color-muted)]">claudes</span>
      </div>

      {/* Processor info */}
      <div className="mb-2 text-xs text-[var(--color-muted)] space-y-0.5">
        {node.cpuModel && (
          <div className="truncate" title={node.cpuModel}>
            {node.cpuModel.replace(/\(R\)|\(TM\)/g, '').replace(/CPU\s+/i, '').trim()}
          </div>
        )}
        <div className="flex gap-2 flex-wrap">
          {node.arch && <span className="text-xs px-1 py-0.5 rounded bg-[var(--color-surface-hover)]">{node.arch}</span>}
          {node.cpuModel && /intel/i.test(node.cpuModel) && <span className="text-xs px-1 py-0.5 rounded bg-blue-500/20 text-blue-400">Intel</span>}
          {node.cpuModel && /amd|epyc|ryzen/i.test(node.cpuModel) && <span className="text-xs px-1 py-0.5 rounded bg-red-500/20 text-red-400">AMD</span>}
          {node.cpuModel && /arm|aarch/i.test(node.arch ?? '') && <span className="text-xs px-1 py-0.5 rounded bg-green-500/20 text-green-400">ARM</span>}
          {node.cpuModel && /risc/i.test(node.arch ?? '') && <span className="text-xs px-1 py-0.5 rounded bg-purple-500/20 text-purple-400">RISC-V</span>}
        </div>
        {node.gpuModel && (
          <div className="flex items-center gap-1.5 mt-1">
            <span className="text-xs px-1 py-0.5 rounded bg-green-500/20 text-green-400">GPU</span>
            <span className="truncate" title={node.gpuModel}>{node.gpuModel}</span>
            {node.gpuMemTotalMB && (
              <span className="shrink-0">{node.gpuMemUsedMB ? `${(node.gpuMemUsedMB / 1024).toFixed(1)}/${(node.gpuMemTotalMB / 1024).toFixed(0)}GB` : `${(node.gpuMemTotalMB / 1024).toFixed(0)}GB`}</span>
            )}
            {node.gpuUtil !== undefined && (
              <span className={node.gpuUtil > 80 ? 'text-[var(--color-error)]' : ''}>{node.gpuUtil}%</span>
            )}
          </div>
        )}
      </div>

      {/* CPU */}
      <div className="mb-2">
        <div className="flex justify-between text-xs text-[var(--color-muted)] mb-1">
          <span>{node.cpuCores} cores</span>
          <span className={loadWarn ? 'text-[var(--color-error)] font-bold' : ''}>
            load {node.loadAvg[0].toFixed(1)} / {node.loadAvg[1].toFixed(1)} / {node.loadAvg[2].toFixed(1)}
          </span>
        </div>
        <div className="h-1.5 rounded bg-[var(--color-background)] overflow-hidden">
          <div
            className={`h-full rounded ${loadWarn ? 'bg-[var(--color-error)]' : 'bg-[#f97316]'}`}
            style={{ width: `${Math.min(loadPerCore * 100, 100)}%` }}
          />
        </div>
      </div>

      {/* Memory */}
      <div className="mb-2">
        <div className="flex justify-between text-xs text-[var(--color-muted)] mb-1">
          <span>{node.memUsedGB}GB / {node.memTotalGB}GB</span>
          <span className={memWarn ? 'text-[var(--color-error)] font-bold' : ''}>
            {memPct.toFixed(0)}%
          </span>
        </div>
        <div className="h-1.5 rounded bg-[var(--color-background)] overflow-hidden">
          <div
            className={`h-full rounded ${memWarn ? 'bg-[var(--color-error)]' : 'bg-[#60a5fa]'}`}
            style={{ width: `${memPct}%` }}
          />
        </div>
      </div>

      {/* Swap */}
      {node.swapUsedGB > 0.1 && (
        <div className="text-xs text-[var(--color-muted)]">
          Swap: {node.swapUsedGB}GB / {node.swapTotalGB}GB
        </div>
      )}

      {/* Costs */}
      {(() => {
        // If watts override is set, use it directly; otherwise use API value
        // If disk override is set, add extra disk wattage on top of API value
        let systemWatts = wattsOverride || node.powerWatts || 0;
        if (!wattsOverride && diskOverride !== undefined) {
          // Add extra spinning disk watts beyond what lsblk detected
          const apiDisks = node.spinningDisks ?? 0;
          const extraDisks = Math.max(0, diskOverride - apiDisks);
          systemWatts += extraDisks * 8;
        }
        const gpuWatts = node.gpuPowerWatts ?? 0;
        const totalWatts = systemWatts + gpuWatts;
        const kwhPerMonth = (totalWatts * 24 * 30) / 1000;
        const elecPerMonth = kwhPerMonth * kwhRate;
        const totalPerMonth = elecPerMonth + ispCost;
        const cpuSourceLabel = wattsOverride ? 'override' : node.powerSource === 'rapl' ? 'rapl' : node.powerSource === 'tdp' ? `tdp ${node.cpuTdpWatts ?? '?'}W` : 'n/a';
        return (
          <div className="mt-2 pt-2 border-t border-[var(--color-border)]">
            <div className="flex justify-between text-xs text-[var(--color-muted)]">
              <span>
                {systemWatts.toFixed(0)}W sys
                {gpuWatts > 0 && <> + {gpuWatts.toFixed(0)}W gpu</>}
                {' = '}{totalWatts.toFixed(0)}W
                {' '}
                <span className={`text-xs ${wattsOverride ? 'text-yellow-400' : node.powerSource ? 'text-[var(--color-accent)]' : 'opacity-60'}`}>
                  [{cpuSourceLabel}]
                </span>
                {gpuWatts > 0 && (
                  <span className="text-xs text-green-400"> [gpu nvidia-smi]</span>
                )}
              </span>
              <span className="text-[var(--color-accent)] font-bold">{formatCost(totalPerMonth)}/mo</span>
            </div>
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1 mt-1">
              <div className="flex items-center gap-1">
                <span className="text-xs text-[var(--color-muted)]">$</span>
                <input
                  type="number"
                  step="0.01"
                  min="0"
                  value={kwhRate}
                  onChange={(e) => onRateChange(node.hostname, parseFloat(e.target.value) || 0)}
                  className="w-14 text-xs bg-[var(--color-background)] border border-[var(--color-border)] rounded px-1 py-0.5 font-mono"
                />
                <span className="text-xs text-[var(--color-muted)]">/kWh</span>
              </div>
              <div className="flex items-center gap-1">
                <span className="text-xs text-[var(--color-muted)]">ISP $</span>
                <input
                  type="number"
                  step="1"
                  min="0"
                  value={ispCost}
                  onChange={(e) => onIspCostChange(node.hostname, parseFloat(e.target.value) || 0)}
                  className="w-14 text-xs bg-[var(--color-background)] border border-[var(--color-border)] rounded px-1 py-0.5 font-mono"
                />
                <span className="text-xs text-[var(--color-muted)]">/mo</span>
              </div>
              <div className="flex items-center gap-1">
                <span className="text-xs text-[var(--color-muted)]">HDDs</span>
                <input
                  type="number"
                  step="1"
                  min="0"
                  value={diskOverride ?? ''}
                  placeholder={String(node.spinningDisks ?? 0)}
                  onChange={(e) => onDiskOverrideChange(node.hostname, parseInt(e.target.value) || 0)}
                  className="w-10 text-xs bg-[var(--color-background)] border border-[var(--color-border)] rounded px-1 py-0.5 font-mono"
                />
              </div>
              <div className="flex items-center gap-1">
                <span className="text-xs text-[var(--color-muted)]">W</span>
                <input
                  type="number"
                  step="1"
                  min="0"
                  value={wattsOverride ?? ''}
                  placeholder="auto"
                  onChange={(e) => onWattsOverrideChange(node.hostname, parseFloat(e.target.value) || 0)}
                  className="w-14 text-xs bg-[var(--color-background)] border border-[var(--color-border)] rounded px-1 py-0.5 font-mono"
                />
                <span className="text-xs text-[var(--color-muted)]">override</span>
              </div>
            </div>
          </div>
        );
      })()}
    </div>
  );
}

function UnsandboxCard({ status, probe }: { status: any; probe: any }) {
  const connected = status?.connected;
  if (!connected) {
    return (
      <div className="rounded border border-[var(--color-border)] p-3 opacity-40">
        <div className="flex items-center gap-2 mb-2">
          <span className="w-2 h-2 rounded-full bg-[var(--color-error)]" />
          <Link href="/permacomputer/unsandbox" className="font-bold text-sm text-purple-400 hover:underline">
            unsandbox.com
          </Link>
          <span className="text-xs text-[var(--color-error)] ml-auto">Disconnected</span>
        </div>
      </div>
    );
  }

  const memPct = probe?.memTotalGB > 0 ? (probe.memUsedGB / probe.memTotalGB) * 100 : 0;
  const loadPerCore = probe?.cpuCores > 0 ? probe.loadAvg[0] / probe.cpuCores : 0;
  const loadWarn = loadPerCore > 2;
  const memWarn = memPct > 85;

  return (
    <div className={`rounded border p-3 ${loadWarn || memWarn ? 'border-[var(--color-error)] bg-red-950/30' : 'border-purple-500/30'}`}>
      {/* Header */}
      <div className="flex items-center gap-2 mb-3">
        <span className="w-2 h-2 rounded-full bg-purple-400 animate-pulse" />
        <Link href="/permacomputer/unsandbox" className="font-bold text-sm text-purple-400 hover:underline transition-colors">
          unsandbox.com
        </Link>
        <span className="text-xs px-1.5 py-0.5 rounded bg-purple-500/20 text-purple-400">ephemeral</span>
        {probe?.uptime && <span className="text-xs text-[var(--color-muted)] ml-auto">up {probe.uptime}</span>}
      </div>

      {/* Tier info */}
      <div className="flex items-baseline gap-2 mb-3">
        <span className="text-3xl font-bold text-purple-400">T{status.tier}</span>
        <span className="text-sm text-[var(--color-muted)]">tier</span>
        <span className="text-xs text-[var(--color-muted)] ml-2">{status.maxSessions} max sessions</span>
      </div>

      {probe ? (<>
        {/* CPU info */}
        <div className="mb-2 text-xs text-[var(--color-muted)] space-y-0.5">
          {probe.cpuModel && (
            <div className="truncate" title={probe.cpuModel}>
              {probe.cpuModel.replace(/\(R\)|\(TM\)/g, '').replace(/CPU\s+/i, '').trim()}
            </div>
          )}
          <div className="flex gap-2 flex-wrap">
            <span className="text-xs px-1 py-0.5 rounded bg-[var(--color-surface-hover)]">x86_64</span>
            {probe.cpuModel && /intel/i.test(probe.cpuModel) && <span className="text-xs px-1 py-0.5 rounded bg-blue-500/20 text-blue-400">Intel</span>}
            {probe.cpuModel && /amd|epyc|ryzen/i.test(probe.cpuModel) && <span className="text-xs px-1 py-0.5 rounded bg-red-500/20 text-red-400">AMD</span>}
          </div>
        </div>

        {/* CPU load */}
        <div className="mb-2">
          <div className="flex justify-between text-xs text-[var(--color-muted)] mb-1">
            <span>{probe.cpuCores} cores</span>
            <span className={loadWarn ? 'text-[var(--color-error)] font-bold' : ''}>
              load {probe.loadAvg[0].toFixed(1)} / {probe.loadAvg[1].toFixed(1)} / {probe.loadAvg[2].toFixed(1)}
            </span>
          </div>
          <div className="h-1.5 rounded bg-[var(--color-background)] overflow-hidden">
            <div
              className={`h-full rounded ${loadWarn ? 'bg-[var(--color-error)]' : 'bg-[#f97316]'}`}
              style={{ width: `${Math.min(loadPerCore * 100, 100)}%` }}
            />
          </div>
        </div>

        {/* Memory */}
        <div className="mb-2">
          <div className="flex justify-between text-xs text-[var(--color-muted)] mb-1">
            <span>{probe.memUsedGB}GB / {probe.memTotalGB}GB</span>
            <span className={memWarn ? 'text-[var(--color-error)] font-bold' : ''}>
              {memPct.toFixed(0)}%
            </span>
          </div>
          <div className="h-1.5 rounded bg-[var(--color-background)] overflow-hidden">
            <div
              className={`h-full rounded ${memWarn ? 'bg-[var(--color-error)]' : 'bg-[#60a5fa]'}`}
              style={{ width: `${memPct}%` }}
            />
          </div>
        </div>
      </>) : (
        <div className="text-xs text-[var(--color-muted)] animate-pulse">Probing...</div>
      )}

      {/* Rate limit */}
      <div className="mt-2 pt-2 border-t border-[var(--color-border)]">
        <div className="flex justify-between text-xs text-[var(--color-muted)]">
          <span>Rate: {status.rateLimit}/min</span>
          <span>Burst: {status.burst}</span>
        </div>
      </div>
    </div>
  );
}

function RateCard({
  label,
  value,
  warn,
  sub,
}: {
  label: string;
  value: string;
  warn?: boolean;
  sub?: string;
}) {
  return (
    <div
      className={`rounded border p-4 ${
        warn
          ? 'bg-red-950 border-[var(--color-error)]'
          : 'bg-[var(--color-surface)] border-[var(--color-border)]'
      }`}
    >
      <div className="text-base text-[var(--color-muted)] mb-1">{label}</div>
      <div
        className={`text-2xl font-bold ${
          warn ? 'text-[var(--color-error)]' : ''
        }`}
      >
        {value}
      </div>
      {sub && <div className="text-base text-[var(--color-muted)] mt-1">{sub}</div>}
    </div>
  );
}
