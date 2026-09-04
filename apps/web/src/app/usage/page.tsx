'use client';

import { fetcher } from '@unturf/unfirehose-ui/fetcher';

import { useState, useEffect, useCallback } from 'react';
import useSWR from 'swr';
import Link from 'next/link';
import { formatTokens } from '@unturf/unfirehose/format';
import { PageContext } from '@unturf/unfirehose-ui/PageContext';

/* eslint-disable @typescript-eslint/no-explicit-any */

const HISTORY_DAYS = 14;

const METRIC_LABEL: Record<string, string> = {
  input_tokens: 'input (uncached)',
  output_tokens: 'output',
  total_tokens: 'total (incl. cache)',
};

function windowLabel(minutes: number) {
  return minutes >= 60 ? `${minutes / 60}h` : `${minutes}m`;
}

function windowBadgeClass(minutes: number) {
  return minutes >= 60 ? 'bg-red-800/80 text-red-200'
    : minutes >= 15 ? 'bg-orange-900/80 text-orange-300'
    : 'bg-yellow-900/60 text-yellow-300';
}

type Calibration = {
  at: string;
  days: number;
  factor: number;
  results: Array<{ id: number; window_minutes: number; metric: string; previous: number; p95: number; threshold: number; samples: number; acknowledged: number }>;
};

export default function UsageMonitorPage() {
  const [ingesting, setIngesting] = useState(false);

  const { data: alerts, mutate: mutateAlerts } = useSWR('/api/alerts?filter=unacknowledged', fetcher, { refreshInterval: 5000 });
  const { data: daily, mutate: mutateDaily } = useSWR(`/api/alerts?filter=daily&days=${HISTORY_DAYS}`, fetcher, { refreshInterval: 30000 });
  const { data: recent, mutate: mutateRecent } = useSWR('/api/alerts?limit=50', fetcher, { refreshInterval: 30000 });
  const { data: thresholds, mutate: mutateThresholds } = useSWR('/api/alerts?filter=thresholds', fetcher);
  const { data: settings, mutate: mutateSettings } = useSWR('/api/settings', fetcher, { revalidateOnFocus: false });

  const calibration: Calibration | null = (() => {
    try { return settings?.alert_calibration ? JSON.parse(settings.alert_calibration) : null; } catch { return null; }
  })();
  const calibratedById = new Map<number, Calibration['results'][number]>(
    (calibration?.results ?? []).map(r => [r.id, r])
  );

  const refreshAll = useCallback(() => {
    mutateAlerts(); mutateDaily(); mutateRecent(); mutateThresholds();
  }, [mutateAlerts, mutateDaily, mutateRecent, mutateThresholds]);

  const runIngest = useCallback(async () => {
    setIngesting(true);
    try {
      await fetch('/api/ingest', { method: 'POST' });
      refreshAll();
    } catch (err) {
      console.error('Ingest failed:', err);
    }
    setIngesting(false);
  }, [refreshAll]);

  // Auto-ingest on mount (file watcher handles ongoing ingestion server-side)
  useEffect(() => { runIngest(); }, [runIngest]);

  // --- Acknowledge all ---
  const [ackState, setAckState] = useState<{ kind: 'idle' } | { kind: 'pending'; n: number } | { kind: 'done'; n: number } | { kind: 'error'; msg: string }>({ kind: 'idle' });
  const acknowledgeAll = async () => {
    if (!alerts?.length || ackState.kind === 'pending') return;
    const n = alerts.length;
    setAckState({ kind: 'pending', n });
    try {
      const res = await fetch('/api/alerts', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'acknowledge_all' }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      refreshAll();
      setAckState({ kind: 'done', n });
      setTimeout(() => setAckState(s => s.kind === 'done' ? { kind: 'idle' } : s), 3000);
    } catch (err: any) {
      setAckState({ kind: 'error', msg: err?.message ?? 'failed' });
    }
  };

  // --- Calibrate from history ---
  const [calState, setCalState] = useState<{ kind: 'idle' } | { kind: 'pending' } | { kind: 'done'; moved: number; acked: number } | { kind: 'error'; msg: string }>({ kind: 'idle' });
  const calibrate = async () => {
    if (calState.kind === 'pending') return;
    setCalState({ kind: 'pending' });
    try {
      const res = await fetch('/api/alerts', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'calibrate', days: 7 }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      const results: Calibration['results'] = data.results ?? [];
      refreshAll(); mutateSettings();
      setCalState({
        kind: 'done',
        moved: results.filter(r => r.threshold !== r.previous).length,
        acked: results.reduce((s, r) => s + r.acknowledged, 0),
      });
      setTimeout(() => setCalState(s => s.kind === 'done' ? { kind: 'idle' } : s), 5000);
    } catch (err: any) {
      setCalState({ kind: 'error', msg: err?.message ?? 'failed' });
    }
  };

  const updateThreshold = async (t: any, value: number, enabled: boolean) => {
    await fetch('/api/alerts', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'update_threshold', id: t.id, value, enabled }),
    });
    refreshAll();
  };

  // --- Daily history, grouped by day ---
  const days: Array<{ day: string; total: number; open: number; rules: any[] }> = [];
  if (Array.isArray(daily)) {
    const byDay = new Map<string, { day: string; total: number; open: number; rules: any[] }>();
    for (const r of daily) {
      let d = byDay.get(r.day);
      if (!d) { d = { day: r.day, total: 0, open: 0, rules: [] }; byDay.set(r.day, d); days.push(d); }
      d.total += r.count; d.open += r.unacknowledged; d.rules.push(r);
    }
  }
  const historyMax = Math.max(1, ...days.map(d => d.total));

  return (
    <div className="space-y-6">
      <PageContext
        pageType="usage-monitor"
        summary={`Usage monitor. ${alerts?.length ?? 0} unacknowledged alerts. ${thresholds?.filter((t: any) => t.enabled).length ?? '?'} of ${thresholds?.length ?? '?'} threshold rules enabled.${calibration ? ` Thresholds calibrated ${calibration.at} from ${calibration.days}d of history at ${calibration.factor}x p95.` : ' Thresholds never calibrated.'}`}
        metrics={{
          unacknowledged_alerts: alerts?.length ?? 0,
          enabled_rules: thresholds?.filter((t: any) => t.enabled).length ?? 0,
          breaches_14d: days.reduce((s, d) => s + d.total, 0),
        }}
        details={alerts?.map((a: any) => `ALERT: ${a.metric} exceeded ${formatTokens(a.threshold_value)} in ${a.window_minutes}min — actual: ${formatTokens(a.actual_value)}`).join('\n')}
      />

      {/* Alert banner — grouped by metric + window */}
      {alerts && alerts.length > 0 && (() => {
        const groups: Record<string, { metric: string; window: number; threshold: number; alerts: any[] }> = {};
        for (const a of alerts) {
          const key = `${a.metric}:${a.window_minutes}`;
          if (!groups[key]) groups[key] = { metric: a.metric, window: a.window_minutes, threshold: a.threshold_value, alerts: [] };
          groups[key].alerts.push(a);
        }
        const sorted = Object.values(groups).sort((a, b) => b.window - a.window || b.alerts[0]?.triggered_at?.localeCompare(a.alerts[0]?.triggered_at));
        const globalPeak = Math.max(...alerts.map((a: any) => a.actual_value), 1);

        return (
          <div className="bg-red-950/60 border border-red-900/60 rounded p-4">
            <div className="flex items-center justify-between mb-3">
              <h3 className="text-sm font-bold text-[var(--color-error)] tracking-wide">
                USAGE ALERTS
                <span className="ml-2 text-xs font-normal text-[var(--color-muted)]">
                  {alerts.length} unacknowledged across {sorted.length} {sorted.length === 1 ? 'rule' : 'rules'}
                </span>
              </h3>
              <button
                onClick={acknowledgeAll}
                disabled={ackState.kind === 'pending' || !alerts?.length}
                className={`text-xs cursor-pointer px-2 py-1 rounded border transition-colors ${
                  ackState.kind === 'pending' ? 'text-[var(--color-foreground)] border-[var(--color-border)] bg-[var(--color-surface)] cursor-wait'
                  : ackState.kind === 'done'   ? 'text-green-300 border-green-700 bg-green-950/40'
                  : ackState.kind === 'error'  ? 'text-red-300 border-red-700 bg-red-950/40'
                  : 'text-[var(--color-muted)] hover:text-[var(--color-foreground)] border-transparent hover:border-[var(--color-border)]'
                }`}
                title={ackState.kind === 'error' ? ackState.msg : undefined}
              >
                {ackState.kind === 'pending' ? `Acknowledging ${ackState.n}...`
                : ackState.kind === 'done'   ? `Acknowledged ${ackState.n}`
                : ackState.kind === 'error'  ? `Failed: ${ackState.msg}`
                : 'Acknowledge all'}
              </button>
            </div>
            <div className="space-y-2">
              {sorted.map(group => {
                const peak = Math.max(...group.alerts.map((a: any) => a.actual_value));
                const latest = group.alerts[0];
                return (
                  <details key={`${group.metric}:${group.window}`} className="group">
                    <summary className="flex items-center gap-3 py-2 px-3 rounded bg-red-950/50 hover:bg-red-900/30 cursor-pointer list-none">
                      <span className={`text-[10px] font-bold font-mono px-1.5 py-0.5 rounded flex-shrink-0 ${windowBadgeClass(group.window)}`}>{windowLabel(group.window)}</span>
                      <span className="text-xs font-mono text-[var(--color-error)]">{group.metric}</span>
                      <span className="text-xs text-[var(--color-muted)]">
                        &gt; {formatTokens(group.threshold)} — peak{' '}
                        <span className="text-[var(--color-error)] font-bold">{formatTokens(peak)}</span>
                      </span>
                      <span className="flex-1 h-1 bg-red-950 rounded overflow-hidden mx-2">
                        <span className="block h-full bg-red-500/70 rounded" style={{ width: `${Math.min(100, (peak / globalPeak) * 100)}%` }} />
                      </span>
                      <span className="text-xs text-[var(--color-muted)] flex-shrink-0">{group.alerts.length}x</span>
                      <span className="text-[10px] text-[var(--color-muted)] flex-shrink-0 w-20 text-right truncate">
                        {latest.triggered_at?.replace(/^\d{4}-\d{2}-\d{2}\s*/, '')}
                      </span>
                      <span className="text-[10px] text-[var(--color-muted)] group-open:rotate-90 transition-transform">▸</span>
                    </summary>
                    <div className="ml-8 mt-1 space-y-0.5 max-h-40 overflow-y-auto">
                      {group.alerts.map((a: any) => (
                        <Link key={a.id} href={`/usage/alert/${a.id}`} className="flex items-center gap-2 py-0.5 px-2 text-xs rounded hover:bg-red-900/30">
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
        <button
          onClick={runIngest}
          disabled={ingesting}
          className="bg-[var(--color-accent)] text-black px-3 py-1.5 rounded text-base font-bold disabled:opacity-50"
        >
          {ingesting ? 'Ingesting...' : 'Ingest Now'}
        </button>
      </div>

      {/* Alert rules */}
      <div className="bg-[var(--color-surface)] rounded border border-[var(--color-border)] p-4">
        <div className="flex items-start justify-between gap-4 mb-3">
          <div>
            <h3 className="text-base font-bold text-[var(--color-muted)]">Alert Rules</h3>
            <p className="text-sm text-[var(--color-muted)] mt-1">
              A rule fires when tokens in its window exceed its threshold. Cache reads cost a tenth of fresh input,
              so <span className="font-mono">total_tokens</span> mostly measures context churn — the billable rules are on by default.
              {calibration
                ? <> Calibrated {new Date(calibration.at).toLocaleString()} from {calibration.days}d of history at {calibration.factor}× p95.</>
                : <> Thresholds are plan-tier guesses until calibrated.</>}
            </p>
          </div>
          <button
            onClick={calibrate}
            disabled={calState.kind === 'pending'}
            className={`shrink-0 text-sm px-3 py-1.5 rounded border transition-colors cursor-pointer ${
              calState.kind === 'pending' ? 'border-[var(--color-border)] text-[var(--color-muted)] cursor-wait'
              : calState.kind === 'done'  ? 'border-green-700 text-green-300 bg-green-950/40'
              : calState.kind === 'error' ? 'border-red-700 text-red-300 bg-red-950/40'
              : 'border-[var(--color-border)] text-[var(--color-foreground)] hover:border-[var(--color-accent)]'
            }`}
            title="Set every threshold to 1.5× the p95 of its own rolling window over the last 7 days. Alerts open against a moved rule are acknowledged."
          >
            {calState.kind === 'pending' ? 'Calibrating...'
            : calState.kind === 'done'   ? `Moved ${calState.moved} rules · acked ${calState.acked}`
            : calState.kind === 'error'  ? `Failed: ${calState.msg}`
            : 'Calibrate from last 7 days'}
          </button>
        </div>

        {thresholds && (
          <table className="w-full text-base [&_th]:px-2 [&_td]:px-2 [&_th]:whitespace-nowrap">
            <thead>
              <tr className="text-[var(--color-muted)] text-left border-b border-[var(--color-border)]">
                <th className="pb-2 w-16">Window</th>
                <th className="pb-2">Metric</th>
                <th className="pb-2 text-right">p95 (7d)</th>
                <th className="pb-2 text-right">Threshold</th>
                <th className="pb-2 text-center w-20">Enabled</th>
              </tr>
            </thead>
            <tbody>
              {thresholds.map((t: any) => {
                const cal = calibratedById.get(t.id);
                return (
                  <tr key={t.id} className={`border-b border-[var(--color-border)]/50 ${t.enabled ? '' : 'text-[var(--color-muted)]'}`}>
                    <td className="py-2">
                      <span className={`text-[10px] font-bold font-mono px-1.5 py-0.5 rounded ${windowBadgeClass(t.window_minutes)}`}>{windowLabel(t.window_minutes)}</span>
                    </td>
                    <td className="py-2">
                      <span className="font-mono">{t.metric}</span>
                      <span className="ml-2 text-sm text-[var(--color-muted)]">{METRIC_LABEL[t.metric] ?? ''}</span>
                    </td>
                    <td className="py-2 text-right font-mono text-sm text-[var(--color-muted)]">
                      {cal ? formatTokens(cal.p95) : '—'}
                    </td>
                    <td className="py-2 text-right">
                      <input
                        type="number"
                        defaultValue={t.threshold_value}
                        key={`${t.id}:${t.threshold_value}`}
                        className="bg-[var(--color-background)] border border-[var(--color-border)] rounded px-2 py-1 w-36 text-right font-mono"
                        onBlur={(e) => {
                          const v = parseFloat(e.target.value);
                          if (Number.isFinite(v) && v !== t.threshold_value) updateThreshold(t, v, !!t.enabled);
                        }}
                      />
                      <div className="text-xs text-[var(--color-muted)] mt-0.5">{formatTokens(t.threshold_value)}</div>
                    </td>
                    <td className="py-2 text-center">
                      <input
                        type="checkbox"
                        checked={!!t.enabled}
                        onChange={(e) => updateThreshold(t, t.threshold_value, e.target.checked)}
                      />
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>

      {/* Breach history — per day, raw rows behind a disclosure */}
      <div className="bg-[var(--color-surface)] rounded border border-[var(--color-border)] p-4">
        <h3 className="text-base font-bold mb-3 text-[var(--color-muted)]">
          Breaches — last {HISTORY_DAYS} days
        </h3>
        {days.length === 0 ? (
          <p className="text-base text-[var(--color-muted)]">No threshold breaches in the last {HISTORY_DAYS} days.</p>
        ) : (
          <div className="space-y-1">
            {days.map(d => (
              <div key={d.day} className="grid grid-cols-[7rem_3rem_1fr] items-center gap-3 py-1 text-base">
                <span className="font-mono text-[var(--color-muted)]">{d.day}</span>
                <span className={`font-mono text-right ${d.open > 0 ? 'text-[var(--color-error)] font-bold' : ''}`}>{d.total}</span>
                <div className="flex items-center gap-2 min-w-0">
                  <span className="h-2 rounded bg-red-500/60 shrink-0" style={{ width: `${Math.max(2, (d.total / historyMax) * 40)}%` }} />
                  <span className="flex flex-wrap gap-1 min-w-0">
                    {d.rules.map((r: any) => (
                      <span key={`${r.window_minutes}:${r.metric}`} className="text-[10px] font-mono px-1.5 py-0.5 rounded bg-[var(--color-background)] border border-[var(--color-border)] text-[var(--color-muted)]" title={`peak ${formatTokens(r.peak)}`}>
                        {windowLabel(r.window_minutes)} {r.metric} ×{r.count}{r.unacknowledged > 0 ? <span className="text-[var(--color-error)]"> ({r.unacknowledged} open)</span> : null}
                      </span>
                    ))}
                  </span>
                </div>
              </div>
            ))}
          </div>
        )}

        {Array.isArray(recent) && recent.length > 0 && (
          <details className="mt-3 group">
            <summary className="text-sm text-[var(--color-muted)] cursor-pointer hover:text-[var(--color-foreground)] list-none">
              <span className="inline-block group-open:rotate-90 transition-transform mr-1">▸</span>
              Most recent {recent.length} alerts
            </summary>
            <div className="mt-2 space-y-0.5 max-h-64 overflow-auto">
              {recent.map((a: any) => (
                <Link
                  key={a.id}
                  href={`/usage/alert/${a.id}`}
                  className={`text-sm py-0.5 grid grid-cols-[10rem_3rem_8rem_1fr_auto] gap-3 hover:bg-[var(--color-surface-hover)] rounded px-1 ${
                    a.acknowledged ? 'text-[var(--color-muted)]' : 'text-[var(--color-error)]'
                  }`}
                >
                  <span className="font-mono">{a.triggered_at}</span>
                  <span>{windowLabel(a.window_minutes)}</span>
                  <span className="font-mono font-bold">{a.metric}</span>
                  <span>{formatTokens(a.actual_value)} / {formatTokens(a.threshold_value)}</span>
                  {a.acknowledged ? <span className="text-[var(--color-accent)]">ack</span> : <span />}
                </Link>
              ))}
            </div>
          </details>
        )}
      </div>
    </div>
  );
}
