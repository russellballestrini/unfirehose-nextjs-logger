'use client';

import { useState } from 'react';
import { useParams, useRouter } from 'next/navigation';
import useSWR from 'swr';
import Link from 'next/link';
import { PageContext } from '@/components/PageContext';
import { formatTokens, formatRelativeTime, formatTimestamp } from '@/lib/format';

/* eslint-disable @typescript-eslint/no-explicit-any */

const fetcher = (url: string) => fetch(url).then((r) => r.json());

export default function AlertDrillDownPage() {
  const params = useParams();
  const router = useRouter();
  const id = params.id as string;
  const [acknowledging, setAcknowledging] = useState(false);

  const { data, error, mutate } = useSWR(`/api/alerts/${id}`, fetcher);

  if (error) {
    return (
      <div className="text-[var(--color-error)] p-8 text-base">
        Failed to load alert: {String(error)}
      </div>
    );
  }

  if (!data) {
    return (
      <div className="text-[var(--color-muted)] p-8 text-base animate-pulse">
        Loading alert...
      </div>
    );
  }

  if (data.error) {
    return (
      <div className="text-[var(--color-error)] p-8 text-base">
        {data.error}: {data.detail ?? ''}
      </div>
    );
  }

  const { alert, window: win, timeline, projectBreakdown, totals, stats } = data;

  const ratio = alert && alert.threshold_value > 0
    ? (alert.actual_value / alert.threshold_value).toFixed(2)
    : '?';

  const acknowledge = async () => {
    setAcknowledging(true);
    try {
      await fetch('/api/alerts', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'acknowledge', id: alert.id }),
      });
      mutate();
    } finally {
      setAcknowledging(false);
    }
  };

  // Determine if metric is token-based or cost-based
  const isTokenMetric = alert.metric !== 'cost_usd';

  const formatMetric = (v: number) =>
    isTokenMetric ? formatTokens(v) : `$${v.toFixed(4)}`;

  return (
    <div className="space-y-6 max-w-5xl">
      <PageContext
        pageType="alert-drilldown"
        summary={`Alert #${alert.id}: ${alert.metric} exceeded ${formatMetric(alert.threshold_value)} (actual: ${formatMetric(alert.actual_value)}, ${ratio}x) in ${alert.window_minutes}min window at ${alert.triggered_at}.`}
        metrics={{
          alert_id: alert.id,
          alert_type: alert.alert_type,
          metric: alert.metric,
          threshold: alert.threshold_value,
          actual: alert.actual_value,
          ratio,
          window_minutes: alert.window_minutes,
          acknowledged: alert.acknowledged,
          project_name: alert.project_name ?? 'global',
          total_cost: totals?.total_cost_usd ?? 0,
        }}
      />

      {/* Navigation */}
      <div className="flex items-center gap-3 text-base">
        <Link href="/usage" className="text-[var(--color-accent)] hover:underline">
          &larr; Usage Monitor
        </Link>
        <span className="text-[var(--color-border)]">/</span>
        <span className="text-[var(--color-muted)]">Alert #{alert.id}</span>
        <span className="ml-auto">
          <Link
            href={`/usage/alert/${alert.id}`}
            className="text-[var(--color-muted)] hover:text-[var(--color-accent)] text-xs"
          >
            Full forensic report &rarr;
          </Link>
        </span>
      </div>

      {/* Alert header card */}
      <div className={`rounded border p-5 space-y-3 ${
        alert.acknowledged
          ? 'bg-[var(--color-surface)] border-[var(--color-border)]'
          : 'bg-red-950/30 border-[var(--color-error)]'
      }`}>
        <div className="flex items-center justify-between gap-3 flex-wrap">
          <div className="text-xs text-[var(--color-muted)] uppercase tracking-widest font-bold">
            Usage Alert
          </div>
          {alert.acknowledged ? (
            <span className="text-xs text-[var(--color-accent)] bg-[var(--color-surface-hover)] px-2 py-0.5 rounded uppercase font-bold">
              Acknowledged
            </span>
          ) : (
            <button
              onClick={acknowledge}
              disabled={acknowledging}
              className="text-sm px-3 py-1 bg-[var(--color-error)] text-white rounded font-bold hover:opacity-90 transition-opacity disabled:opacity-50"
            >
              {acknowledging ? 'Acknowledging...' : 'Acknowledge'}
            </button>
          )}
        </div>

        <div className="text-lg font-bold">
          #{alert.id}{' '}
          <span className="text-[var(--color-muted)] font-normal text-base">
            {formatTimestamp(alert.triggered_at)}
          </span>
          <span className="ml-2 text-xs text-[var(--color-muted)]">
            ({formatRelativeTime(alert.triggered_at)})
          </span>
        </div>

        <div className="flex flex-wrap items-center gap-4 text-sm">
          <span className="bg-[var(--color-error)] text-white px-2 py-0.5 rounded text-xs font-bold uppercase">
            {alert.alert_type.replace(/_/g, ' ')}
          </span>
          <span className="bg-[var(--color-surface-hover)] text-[var(--color-muted)] px-2 py-0.5 rounded text-xs">
            {alert.metric.replace(/_/g, ' ')}
          </span>
          <span>
            <span className="text-[var(--color-muted)]">threshold </span>
            <span className="font-bold">{formatMetric(alert.threshold_value)}</span>
          </span>
          <span>
            <span className="text-[var(--color-muted)]">actual </span>
            <span className="font-bold text-[var(--color-error)]">{formatMetric(alert.actual_value)}</span>
          </span>
          <span className="text-[var(--color-error)] font-bold text-base">{ratio}x</span>
          <span className="text-[var(--color-muted)] text-xs">{alert.window_minutes}min window</span>
          {alert.project_name && (
            <Link
              href={`/projects/${encodeURIComponent(alert.project_name)}`}
              className="text-[var(--color-accent)] hover:underline text-xs"
            >
              project: {alert.project_name}
            </Link>
          )}
        </div>
      </div>

      {/* Summary stats row */}
      {totals && stats && (
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
          <div className="bg-[var(--color-surface)] border border-[var(--color-border)] rounded p-3">
            <div className="text-xs text-[var(--color-muted)] uppercase tracking-wide mb-1">Input Tokens</div>
            <div className="text-base font-bold">{formatTokens(totals.input_tokens)}</div>
          </div>
          <div className="bg-[var(--color-surface)] border border-[var(--color-border)] rounded p-3">
            <div className="text-xs text-[var(--color-muted)] uppercase tracking-wide mb-1">Output Tokens</div>
            <div className="text-base font-bold">{formatTokens(totals.output_tokens)}</div>
          </div>
          <div className="bg-[var(--color-surface)] border border-[var(--color-border)] rounded p-3">
            <div className="text-xs text-[var(--color-muted)] uppercase tracking-wide mb-1">Cache Read</div>
            <div className="text-base font-bold">{formatTokens(totals.cache_read_tokens)}</div>
          </div>
          <div className="bg-[var(--color-surface)] border border-[var(--color-border)] rounded p-3">
            <div className="text-xs text-[var(--color-muted)] uppercase tracking-wide mb-1">Messages</div>
            <div className="text-base font-bold">{totals.messages}</div>
            <div className="text-xs text-[var(--color-muted)]">{stats.active_sessions} sessions</div>
          </div>
        </div>
      )}

      {/* Usage minutes data table */}
      {timeline && timeline.length > 0 && (
        <div className="bg-[var(--color-surface)] border border-[var(--color-border)] rounded p-4 space-y-3">
          <div className="flex items-center justify-between">
            <h3 className="text-sm font-bold text-[var(--color-muted)] uppercase tracking-wide">
              Usage by Minute
            </h3>
            <span className="text-xs text-[var(--color-muted)]">
              {win.start.slice(0, 16)} &mdash; {win.end.slice(0, 16)}
            </span>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-[var(--color-muted)] border-b border-[var(--color-border)]">
                  <th className="pb-2 pr-4">Minute</th>
                  <th className="pb-2 pr-4 text-right">Input</th>
                  <th className="pb-2 pr-4 text-right">Output</th>
                  <th className="pb-2 pr-4 text-right">Cache Read</th>
                  <th className="pb-2 pr-4 text-right">Cache Write</th>
                  <th className="pb-2 text-right">Msgs</th>
                </tr>
              </thead>
              <tbody>
                {timeline.map((row: any) => {
                  const total = (row.input_tokens ?? 0) + (row.output_tokens ?? 0);
                  const isHot = total > (alert.threshold_value / alert.window_minutes);
                  return (
                    <tr
                      key={row.minute}
                      className={`border-b border-[var(--color-border)] last:border-0 ${
                        isHot ? 'text-[var(--color-error)]' : 'text-[var(--color-foreground)]'
                      }`}
                    >
                      <td className="py-1.5 pr-4 font-mono text-xs text-[var(--color-muted)]">
                        {row.minute}
                      </td>
                      <td className="py-1.5 pr-4 text-right">{formatTokens(row.input_tokens ?? 0)}</td>
                      <td className="py-1.5 pr-4 text-right">{formatTokens(row.output_tokens ?? 0)}</td>
                      <td className="py-1.5 pr-4 text-right text-[var(--color-muted)]">{formatTokens(row.cache_read_tokens ?? 0)}</td>
                      <td className="py-1.5 pr-4 text-right text-[var(--color-muted)]">{formatTokens(row.cache_creation_tokens ?? 0)}</td>
                      <td className="py-1.5 text-right text-[var(--color-muted)]">{row.message_count ?? 0}</td>
                    </tr>
                  );
                })}
              </tbody>
              {/* Totals footer */}
              {totals && (
                <tfoot>
                  <tr className="border-t-2 border-[var(--color-border)] font-bold text-[var(--color-foreground)]">
                    <td className="pt-2 pr-4 text-[var(--color-muted)] text-xs">TOTAL</td>
                    <td className="pt-2 pr-4 text-right">{formatTokens(totals.input_tokens)}</td>
                    <td className="pt-2 pr-4 text-right">{formatTokens(totals.output_tokens)}</td>
                    <td className="pt-2 pr-4 text-right text-[var(--color-muted)]">{formatTokens(totals.cache_read_tokens)}</td>
                    <td className="pt-2 pr-4 text-right text-[var(--color-muted)]">{formatTokens(totals.cache_creation_tokens)}</td>
                    <td className="pt-2 text-right text-[var(--color-muted)]">{totals.messages}</td>
                  </tr>
                </tfoot>
              )}
            </table>
          </div>
        </div>
      )}

      {/* Project breakdown table */}
      {projectBreakdown && projectBreakdown.length > 0 && (
        <div className="bg-[var(--color-surface)] border border-[var(--color-border)] rounded p-4 space-y-3">
          <h3 className="text-sm font-bold text-[var(--color-muted)] uppercase tracking-wide">
            Project Breakdown
          </h3>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-[var(--color-muted)] border-b border-[var(--color-border)]">
                  <th className="pb-2 pr-4">Project</th>
                  <th className="pb-2 pr-4 text-right">Input</th>
                  <th className="pb-2 pr-4 text-right">Output</th>
                  <th className="pb-2 pr-4 text-right">Msgs</th>
                  <th className="pb-2 pr-4 text-right">Cost</th>
                  <th className="pb-2 text-right">Share</th>
                </tr>
              </thead>
              <tbody>
                {projectBreakdown.map((p: any) => (
                  <tr key={p.name} className="border-b border-[var(--color-border)] last:border-0">
                    <td className="py-1.5 pr-4 font-bold">
                      <Link
                        href={`/projects/${encodeURIComponent(p.name)}`}
                        className="text-[var(--color-accent)] hover:underline"
                      >
                        {p.display_name}
                      </Link>
                    </td>
                    <td className="py-1.5 pr-4 text-right text-[var(--color-muted)]">{formatTokens(p.input_tokens)}</td>
                    <td className="py-1.5 pr-4 text-right text-[var(--color-muted)]">{formatTokens(p.output_tokens)}</td>
                    <td className="py-1.5 pr-4 text-right text-[var(--color-muted)]">{p.message_count}</td>
                    <td className="py-1.5 pr-4 text-right font-bold text-[var(--color-error)]">
                      ${p.cost_usd.toFixed(4)}
                    </td>
                    <td className="py-1.5 text-right text-[var(--color-muted)]">
                      {p.pct_of_total.toFixed(1)}%
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* Alert details JSON (if any) */}
      {alert.details && alert.details !== '{}' && (
        <div className="bg-[var(--color-surface)] border border-[var(--color-border)] rounded p-4 space-y-2">
          <h3 className="text-sm font-bold text-[var(--color-muted)] uppercase tracking-wide">
            Alert Details
          </h3>
          <pre className="text-xs font-mono text-[var(--color-foreground)] whitespace-pre-wrap overflow-auto max-h-40">
            {JSON.stringify(JSON.parse(alert.details), null, 2)}
          </pre>
        </div>
      )}

      {/* Link to full forensic report */}
      <div className="text-sm text-[var(--color-muted)]">
        Need more detail?{' '}
        <Link
          href={`/usage/alert/${alert.id}`}
          className="text-[var(--color-accent)] hover:underline"
        >
          View full forensic report
        </Link>{' '}
        with thinking streams, active sessions, and model breakdown.
      </div>

      {/* Back navigation */}
      <div className="flex gap-4 text-sm">
        <button
          onClick={() => router.back()}
          className="text-[var(--color-muted)] hover:text-[var(--color-foreground)]"
        >
          &larr; Back
        </button>
        <Link href="/usage" className="text-[var(--color-accent)] hover:underline">
          Usage Monitor
        </Link>
      </div>
    </div>
  );
}
