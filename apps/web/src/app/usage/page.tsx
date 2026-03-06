'use client';

import { useState, useEffect, useCallback, useRef, Fragment } from 'react';
import useSWR from 'swr';
import Link from 'next/link';
import { formatTokens, formatRelativeTime } from '@unfirehose/core/format';
import { PageContext } from '@unfirehose/ui/PageContext';
import { TimeRangeSelect, useTimeRange, getTimeRangeMinutes } from '@unfirehose/ui/TimeRangeSelect';
import { useCurrency } from '@unfirehose/ui/useCurrency';
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

  // Load per-node electricity rates from settings
  useEffect(() => {
    if (!settings) return;
    const rates: Record<string, number> = {};
    for (const [k, v] of Object.entries(settings)) {
      if (k.startsWith('electricity_rate_')) {
        rates[k.replace('electricity_rate_', '')] = parseFloat(v as string) || DEFAULT_KWH_RATE;
      }
    }
    setKwhRates(rates);
  }, [settings]);

  const getKwhRate = (hostname: string) => kwhRates[hostname] ?? DEFAULT_KWH_RATE;

  const saveKwhRate = (hostname: string, rate: number) => {
    setKwhRates(prev => ({ ...prev, [hostname]: rate }));
    fetch('/api/settings', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'set', key: `electricity_rate_${hostname}`, value: String(rate) }),
    });
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

  const { data: apmonitor } = useSWR('/api/apmonitor', fetcher, {
    refreshInterval: 15000,
  });
  const { data: projectActivity } = useSWR(
    '/api/projects/activity?days=30',
    fetcher,
    { refreshInterval: 30000 }
  );
  const [activeTab, setActiveTab] = useState<'model' | 'infra' | 'thresholds'>('model');
  const currency = useCurrency();
  const [expandedProject, setExpandedProject] = useState<string | null>(null);
  const { data: projectDetail } = useSWR(
    expandedProject ? `/api/projects/activity?project=${encodeURIComponent(expandedProject)}` : null,
    fetcher
  );

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
  useEffect(() => {
    runIngest();
  }, [runIngest]);

  const acknowledgeAll = async () => {
    if (!alerts?.length) return;
    for (const alert of alerts) {
      await fetch('/api/alerts', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'acknowledge', id: alert.id }),
      });
    }
    mutateAlerts();
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
      {/* Alert banner */}
      {alerts && alerts.length > 0 && (
        <div className="bg-red-950 border border-[var(--color-error)] rounded p-4">
          <div className="grid grid-cols-[1fr_auto] items-center mb-2">
            <h3 className="text-base font-bold text-[var(--color-error)]">
              USAGE ALERTS ({alerts.length})
            </h3>
            <button
              onClick={acknowledgeAll}
              className="text-base text-[var(--color-muted)] hover:text-[var(--color-foreground)]"
            >
              Acknowledge all
            </button>
          </div>
          {alerts.map((alert: any) => (
            <Link
              key={alert.id}
              href={`/alerts/${alert.id}`}
              className="text-base py-1 border-t border-red-900 block hover:bg-red-900/50 rounded px-1"
            >
              <span className="text-[var(--color-error)] font-bold">
                {alert.metric}
              </span>{' '}
              exceeded{' '}
              <span className="text-[var(--color-foreground)]">
                {formatTokens(alert.threshold_value)}
              </span>{' '}
              in {alert.window_minutes}min window:{' '}
              <span className="text-[var(--color-error)] font-bold">
                {formatTokens(alert.actual_value)}
              </span>{' '}
              <span className="text-base text-[var(--color-muted)]">
                ({alert.triggered_at})
              </span>
            </Link>
          ))}
        </div>
      )}

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

      {/* Usage by project — CSS Grid bar chart, labels get priority */}
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

      {/* Agent Standup — 30-day project activity */}
      {projectActivity && projectActivity.length > 0 && (
        <div className="bg-[var(--color-surface)] rounded border border-[var(--color-border)] p-4">
          <h3 className="text-base font-bold mb-3 text-[var(--color-muted)]">
            Agent Standup (30 days)
          </h3>
          <div className="space-y-1">
            {projectActivity.map((p: any) => (
              <div key={p.name}>
                <div
                  className={`grid grid-cols-[auto_10rem_minmax(0,1fr)_auto] items-center gap-3 text-base py-2 px-2 rounded cursor-pointer hover:bg-[var(--color-surface-hover)] ${
                    expandedProject === p.name ? 'bg-[var(--color-surface-hover)]' : ''
                  }`}
                  onClick={() => setExpandedProject(expandedProject === p.name ? null : p.name)}
                >
                  {/* Status indicator */}
                  <span className={`w-2 h-2 rounded-full shrink-0 ${
                    isActiveRecently(p.last_activity)
                      ? 'bg-[var(--color-accent)] animate-pulse'
                      : isActiveSameDay(p.last_activity)
                        ? 'bg-[var(--color-accent)]'
                        : 'bg-[var(--color-muted)]'
                  }`} />

                  {/* Project name */}
                  <span className="font-bold truncate">{p.display_name}</span>

                  {/* Metrics bar */}
                  <div className="flex flex-wrap gap-x-4 gap-y-0.5 text-base text-[var(--color-muted)] min-w-0">
                    <span>{p.user_messages.toLocaleString()} prompts</span>
                    <span>{p.session_count} sessions</span>
                    <span>{p.active_days}d active</span>
                    <span>{formatTokens(p.total_output)} out</span>
                    <span className="text-[var(--color-accent)]">{currency.format(p.cost_estimate)}</span>
                  </div>

                  {/* Last activity */}
                  <span className="text-base text-[var(--color-muted)] text-right whitespace-nowrap">
                    {p.last_activity ? formatRelativeTime(p.last_activity) : '-'}
                  </span>
                </div>

                {/* Expanded detail with recent prompts + git context */}
                {expandedProject === p.name && projectDetail && (
                  <div className="ml-7 pl-4 border-l-2 border-[var(--color-border)] py-2 space-y-1.5">
                    {/* Git status summary */}
                    {projectDetail.git && (projectDetail.git.isDirty || projectDetail.git.unpushedCount > 0) && (
                      <div className="flex gap-2 mb-1">
                        {projectDetail.git.isDirty && (
                          <span className="text-xs px-1.5 py-0.5 rounded bg-yellow-500/20 text-yellow-400 font-mono">
                            uncommitted changes
                          </span>
                        )}
                        {projectDetail.git.unpushedCount > 0 && (
                          <span className="text-xs px-1.5 py-0.5 rounded bg-orange-500/20 text-orange-400 font-mono">
                            {projectDetail.git.unpushedCount} unpushed
                          </span>
                        )}
                      </div>
                    )}
                    {projectDetail.recentPrompts && projectDetail.recentPrompts.length > 0 ? (
                      <>
                        <div className="text-base font-bold text-[var(--color-muted)] mb-1">Recent prompts:</div>
                        {projectDetail.recentPrompts.map((rp: any, i: number) => (
                          <div key={i} className="text-base grid grid-cols-[8rem_1fr] gap-2">
                            <span className="text-[var(--color-muted)] flex items-center gap-1.5">
                              {rp.timestamp ? formatRelativeTime(rp.timestamp) : ''}
                            </span>
                            <div className="flex items-start gap-2">
                              <span className="text-[var(--color-foreground)] break-words flex-1">
                                {rp.prompt}
                              </span>
                              {rp.commitHash && (
                                <span className="shrink-0 text-xs px-1.5 py-0.5 rounded bg-green-500/20 text-green-400 font-mono" title={rp.commitSubject}>
                                  {rp.commitHash}
                                </span>
                              )}
                              {rp.gitStatus === 'uncommitted' && (
                                <span className="shrink-0 text-xs px-1.5 py-0.5 rounded bg-yellow-500/20 text-yellow-400 font-mono">
                                  uncommitted
                                </span>
                              )}
                              {rp.gitStatus === 'unpushed' && (
                                <span className="shrink-0 text-xs px-1.5 py-0.5 rounded bg-orange-500/20 text-orange-400 font-mono">
                                  unpushed
                                </span>
                              )}
                            </div>
                          </div>
                        ))}
                      </>
                    ) : (
                      <div className="text-base text-[var(--color-muted)]">No recent prompts found.</div>
                    )}
                  </div>
                )}
              </div>
            ))}
          </div>
        </div>
      )}

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

      {/* Last ingest result */}
      {lastIngest && (
        <div className="text-base text-[var(--color-muted)] bg-[var(--color-surface)] rounded border border-[var(--color-border)] p-3">
          Last ingest: {lastIngest.ingested?.messagesAdded} msgs,{' '}
          {lastIngest.ingested?.blocksAdded} blocks,{' '}
          {lastIngest.ingested?.filesScanned} files scanned,{' '}
          {lastIngest.ingested?.alertsTriggered} alerts triggered.
          DB: {lastIngest.db?.messages} total msgs, {lastIngest.db?.thinkingBlocks} thinking blocks.
        </div>
      )}

      </>)}

      {/* ============ INFRASTRUCTURE TAB ============ */}
      {activeTab === 'infra' && (<>

      {/* Mesh Status */}
      {mesh && (
        <div className="bg-[var(--color-surface)] rounded border border-[var(--color-border)] p-4">
          <div className="flex items-center justify-between mb-3">
            <h3 className="text-base font-bold text-[var(--color-muted)]">
              Permacomputer Mesh
            </h3>
            <div className="flex items-center gap-4 text-sm">
              <span className="text-[var(--color-accent)] font-bold">{mesh.summary?.totalClaudes ?? 0} claudes</span>
              <span className="text-[var(--color-muted)]">{mesh.summary?.totalCores ?? 0} cores</span>
              <span className="text-[var(--color-muted)]">{mesh.summary?.totalMemGB ?? 0}GB total</span>
              <span className="text-[var(--color-muted)]">{mesh.summary?.reachableNodes ?? 0}/{mesh.summary?.totalNodes ?? 0} nodes</span>
              {(() => {
                const totalCost = (mesh.nodes ?? [])
                  .filter((n: any) => n.reachable)
                  .reduce((sum: number, n: any) => {
                    const watts = (n.powerWatts ?? estimateWatts(n.cpuCores, n.loadAvg[0])) + (n.gpuPowerWatts ?? 0);
                    return sum + (watts * 24 * 30 / 1000) * getKwhRate(n.hostname);
                  }, 0);
                return <span className="text-[var(--color-accent)]">~{currency.format(totalCost)}/mo elec</span>;
              })()}
              <span className="text-[var(--color-muted)]">{mesh.summary?.totalPowerWatts ?? 0}W total</span>
            </div>
          </div>
          <div className="grid gap-3" style={{ gridTemplateColumns: `repeat(${Math.min(mesh.nodes?.length ?? 1, 3)}, 1fr)` }}>
            {mesh.nodes?.map((node: any) => (
              <MeshNodeCard key={node.hostname} node={node} kwhRate={getKwhRate(node.hostname)} onRateChange={saveKwhRate} formatCost={currency.format} />
            ))}
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
      {meshHistory?.timeline?.length > 0 && (
        <div className="space-y-4">
          {/* Power Wattage */}
          <div className="bg-[var(--color-surface)] rounded border border-[var(--color-border)] p-4">
            <h3 className="text-base font-bold mb-3 text-[var(--color-muted)]">
              Compute Wattage
              <span className="text-xs font-normal ml-2 text-[var(--color-muted)]">
                {meshHistory.timeline[meshHistory.timeline.length - 1]?.totalWatts ?? 0}W current
              </span>
            </h3>
            <ResponsiveContainer width="100%" height={200}>
              <LineChart data={meshHistory.timeline}>
                <XAxis
                  dataKey="timestamp"
                  tick={{ fill: '#71717a', fontSize: 12 }}
                  tickFormatter={(t: string) => t.slice(11, 16)}
                />
                <YAxis tick={{ fill: '#71717a', fontSize: 12 }} unit="W" />
                <Tooltip
                  labelFormatter={(t) => String(t)}
                  formatter={(v, name) => [`${v}W`, name]}
                  contentStyle={{ background: '#18181b', border: '1px solid #3f3f46', borderRadius: 4 }}
                />
                <Legend />
                <Line type="monotone" dataKey="totalWatts" name="Total" stroke="var(--color-accent)" strokeWidth={2} dot={false} />
                <Line type="monotone" dataKey="cpuWatts" name="CPU" stroke="#f97316" strokeWidth={1.5} dot={false} />
                {meshHistory.timeline.some((t: any) => t.gpuWatts > 0) && (
                  <Line type="monotone" dataKey="gpuWatts" name="GPU" stroke="#a78bfa" strokeWidth={1.5} dot={false} />
                )}
              </LineChart>
            </ResponsiveContainer>
          </div>

          {/* CPU Load */}
          <div className="bg-[var(--color-surface)] rounded border border-[var(--color-border)] p-4">
            <h3 className="text-base font-bold mb-3 text-[var(--color-muted)]">
              CPU Load
              <span className="text-xs font-normal ml-2 text-[var(--color-muted)]">
                {meshHistory.timeline[meshHistory.timeline.length - 1]?.totalLoad ?? 0} / {meshHistory.timeline[meshHistory.timeline.length - 1]?.totalCores ?? 0} cores
              </span>
            </h3>
            <ResponsiveContainer width="100%" height={200}>
              <AreaChart data={meshHistory.timeline}>
                <XAxis
                  dataKey="timestamp"
                  tick={{ fill: '#71717a', fontSize: 12 }}
                  tickFormatter={(t: string) => t.slice(11, 16)}
                />
                <YAxis tick={{ fill: '#71717a', fontSize: 12 }} />
                <Tooltip
                  labelFormatter={(t) => String(t)}
                  formatter={(v, name) => [typeof v === 'number' ? v.toFixed(1) : v, name]}
                  contentStyle={{ background: '#18181b', border: '1px solid #3f3f46', borderRadius: 4 }}
                />
                <Legend />
                <Area type="monotone" dataKey="totalCores" name="Total Cores" stroke="#3f3f46" fill="#3f3f46" fillOpacity={0.2} dot={false} />
                <Area type="monotone" dataKey="totalLoad" name="Load Average" stroke="#f97316" fill="#f97316" fillOpacity={0.3} dot={false} />
              </AreaChart>
            </ResponsiveContainer>
          </div>

          {/* Memory Usage */}
          <div className="bg-[var(--color-surface)] rounded border border-[var(--color-border)] p-4">
            <h3 className="text-base font-bold mb-3 text-[var(--color-muted)]">
              Memory Usage
              <span className="text-xs font-normal ml-2 text-[var(--color-muted)]">
                {meshHistory.timeline[meshHistory.timeline.length - 1]?.memUsedGB ?? 0} / {meshHistory.timeline[meshHistory.timeline.length - 1]?.memTotalGB ?? 0} GB
              </span>
            </h3>
            <ResponsiveContainer width="100%" height={200}>
              <AreaChart data={meshHistory.timeline}>
                <XAxis
                  dataKey="timestamp"
                  tick={{ fill: '#71717a', fontSize: 12 }}
                  tickFormatter={(t: string) => t.slice(11, 16)}
                />
                <YAxis tick={{ fill: '#71717a', fontSize: 12 }} unit="GB" />
                <Tooltip
                  labelFormatter={(t) => String(t)}
                  formatter={(v, name) => [`${v}GB`, name]}
                  contentStyle={{ background: '#18181b', border: '1px solid #3f3f46', borderRadius: 4 }}
                />
                <Legend />
                <Area type="monotone" dataKey="memTotalGB" name="Total" stroke="#3f3f46" fill="#3f3f46" fillOpacity={0.2} dot={false} />
                <Area type="monotone" dataKey="memUsedGB" name="Used" stroke="#60a5fa" fill="#60a5fa" fillOpacity={0.3} dot={false} />
              </AreaChart>
            </ResponsiveContainer>
          </div>
        </div>
      )}

      </>)}

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

// Estimate watts from CPU cores and load average
// Rough model: idle core ~10W, loaded core ~40W, linear interpolation
function estimateWatts(cores: number, loadAvg1: number): number {
  const idleWattsPerCore = 10;
  const loadedWattsPerCore = 40;
  const utilization = Math.min(loadAvg1 / cores, 1);
  return cores * (idleWattsPerCore + utilization * (loadedWattsPerCore - idleWattsPerCore));
}

function MeshNodeCard({ node, kwhRate, onRateChange, formatCost }: { node: any; kwhRate: number; onRateChange: (hostname: string, rate: number) => void; formatCost: (usd: number) => string }) {
  if (!node.reachable) {
    return (
      <div className="rounded border border-[var(--color-border)] p-3 opacity-40">
        <div className="flex items-center gap-2 mb-2">
          <span className="w-2 h-2 rounded-full bg-[var(--color-error)]" />
          <span className="font-bold text-sm">{node.hostname}</span>
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
        <span className="font-bold text-sm">{node.hostname}</span>
        <span className="text-xs text-[var(--color-muted)] ml-auto">up {node.uptime}</span>
      </div>

      {/* Claude count — hero stat */}
      <div className="flex items-baseline gap-2 mb-3">
        <span className="text-3xl font-bold text-[var(--color-accent)]">{node.claudeProcesses}</span>
        <span className="text-sm text-[var(--color-muted)]">claudes</span>
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

      {/* Electricity */}
      {(() => {
        const cpuWatts = node.powerWatts ?? estimateWatts(node.cpuCores, node.loadAvg[0]);
        const gpuWatts = node.gpuPowerWatts ?? 0;
        const totalWatts = cpuWatts + gpuWatts;
        const kwhPerMonth = (totalWatts * 24 * 30) / 1000;
        const costPerMonth = kwhPerMonth * kwhRate;
        const sourceLabel = node.powerSource === 'rapl' ? 'rapl' : node.powerSource === 'nvidia' ? 'nvidia' : 'est.';
        return (
          <div className="mt-2 pt-2 border-t border-[var(--color-border)]">
            <div className="flex justify-between text-xs text-[var(--color-muted)]">
              <span>
                {cpuWatts.toFixed(0)}W cpu
                {gpuWatts > 0 && <> + {gpuWatts.toFixed(0)}W gpu</>}
                {' '}
                <span className={`text-[10px] ${node.powerSource === 'rapl' ? 'text-[var(--color-accent)]' : 'opacity-60'}`}>
                  [{sourceLabel}]
                </span>
              </span>
              <span className="text-[var(--color-accent)] font-bold">{formatCost(costPerMonth)}/mo</span>
            </div>
            <div className="flex items-center gap-1.5 mt-1">
              <span className="text-[10px] text-[var(--color-muted)]">$</span>
              <input
                type="number"
                step="0.01"
                min="0"
                value={kwhRate}
                onChange={(e) => onRateChange(node.hostname, parseFloat(e.target.value) || 0)}
                className="w-14 text-[10px] bg-[var(--color-background)] border border-[var(--color-border)] rounded px-1 py-0.5 font-mono"
              />
              <span className="text-[10px] text-[var(--color-muted)]">/kWh</span>
            </div>
          </div>
        );
      })()}
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
