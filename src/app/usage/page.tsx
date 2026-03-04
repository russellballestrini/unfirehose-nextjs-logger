'use client';

import { useState, useEffect, useCallback, Fragment } from 'react';
import useSWR from 'swr';
import Link from 'next/link';
import { formatTokens, formatRelativeTime } from '@/lib/format';
import { PageContext } from '@/components/PageContext';
import {
  AreaChart,
  Area,
  XAxis,
  YAxis,
  Tooltip,
  ResponsiveContainer,
} from 'recharts';

/* eslint-disable @typescript-eslint/no-explicit-any */

const fetcher = (url: string) => fetch(url).then((r) => r.json());

export default function UsageMonitorPage() {
  const [window, setWindow] = useState(1440);
  const [ingesting, setIngesting] = useState(false);
  const [lastIngest, setLastIngest] = useState<any>(null);

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
  const { data: projectActivity } = useSWR(
    '/api/projects/activity?days=30',
    fetcher,
    { refreshInterval: 30000 }
  );
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
        summary={`Usage monitor. Window: ${window === 0 ? 'Lifetime' : `${window}min`}. Input (5min): ${formatTokens(currentRate.input)}, Output (5min): ${formatTokens(currentRate.output)}, Messages (5min): ${currentRate.messages}. ${alerts?.length ?? 0} unacknowledged alerts. DB: ${dbStats ? formatTokens(dbStats.messages) : '?'} messages.`}
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
              href={`/usage/alert/${alert.id}`}
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
          <select
            value={window}
            onChange={(e) => setWindow(Number(e.target.value))}
            className="bg-[var(--color-surface)] border border-[var(--color-border)] rounded px-3 py-1.5 text-base"
          >
            <option value={60}>1 hour</option>
            <option value={180}>3 hours</option>
            <option value={360}>6 hours</option>
            <option value={720}>12 hours</option>
            <option value={1440}>24 hours</option>
            <option value={10080}>7 days</option>
            <option value={20160}>14 days</option>
            <option value={40320}>28 days</option>
            <option value={0}>Lifetime</option>
          </select>
          <button
            onClick={runIngest}
            disabled={ingesting}
            className="bg-[var(--color-accent)] text-black px-3 py-1.5 rounded text-base font-bold disabled:opacity-50"
          >
            {ingesting ? 'Ingesting...' : 'Ingest Now'}
          </button>
        </div>
      </div>

      {/* Live rate cards */}
      <div className="grid grid-cols-4 gap-4">
        <RateCard label="Input (5min)" value={formatTokens(currentRate.input)} warn={currentRate.input > 500000} />
        <RateCard label="Output (5min)" value={formatTokens(currentRate.output)} warn={currentRate.output > 100000} />
        <RateCard label="Messages (5min)" value={String(currentRate.messages)} warn={currentRate.messages > 50} />
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
                    <span className="text-[var(--color-accent)]">${p.cost_estimate.toLocaleString()}</span>
                  </div>

                  {/* Last activity */}
                  <span className="text-base text-[var(--color-muted)] text-right whitespace-nowrap">
                    {p.last_activity ? formatRelativeTime(p.last_activity) : '-'}
                  </span>
                </div>

                {/* Expanded detail with recent prompts */}
                {expandedProject === p.name && projectDetail && (
                  <div className="ml-7 pl-4 border-l-2 border-[var(--color-border)] py-2 space-y-1.5">
                    {projectDetail.recentPrompts && projectDetail.recentPrompts.length > 0 ? (
                      <>
                        <div className="text-base font-bold text-[var(--color-muted)] mb-1">Recent prompts:</div>
                        {projectDetail.recentPrompts.map((rp: any, i: number) => (
                          <div key={i} className="text-base grid grid-cols-[8rem_1fr] gap-2">
                            <span className="text-[var(--color-muted)]">
                              {rp.timestamp ? formatRelativeTime(rp.timestamp) : ''}
                            </span>
                            <span className="text-[var(--color-foreground)] break-words">
                              {rp.prompt}
                            </span>
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
                href={`/usage/alert/${a.id}`}
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
