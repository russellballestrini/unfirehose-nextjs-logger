'use client';

import useSWR from 'swr';
import { PageContext } from '@unturf/unfirehose-ui/PageContext';
import { TimeRangeSelect, useTimeRange, getTimeRangeMinutes } from '@unturf/unfirehose-ui/TimeRangeSelect';
import { useStickyState } from '@unturf/unfirehose-ui/useStickyState';
import { formatRelativeTime } from '@unturf/unfirehose/format';

/* eslint-disable @typescript-eslint/no-explicit-any */

const fetcher = (url: string) => fetch(url).then((r) => r.json());

// What each bucket means, spelled out — "rate limit" gets used for four
// different conditions and the difference decides what you do about it.
const KIND_HELP: Record<string, string> = {
  rate_limit:  'too many requests per unit time — slow down or spread across providers',
  concurrency: 'too many calls in flight at once — queue them, do not retry harder',
  quota:       'plan or credit exhausted — waiting will not help until it resets',
  overloaded:  'the provider ran out of capacity — not caused by our usage',
};

const KIND_COLOR: Record<string, string> = {
  rate_limit:  'var(--color-error)',
  concurrency: '#fbbf24',
  quota:       '#f87171',
  overloaded:  '#a78bfa',
};

const TARGET_HELP: Record<string, string> = {
  inference: 'an LLM provider refused the call — this is the one that shapes cost and routing',
  service:   'our own infrastructure (unsandbox concurrency, Matrix)',
  web:       'a site we crawled answered 429 — real, but says nothing about our API budget',
};

export default function RateLimitsPage() {
  const [range, setRange] = useTimeRange('rate_limits_range', '28d');
  const [target, setTarget] = useStickyState<string>('rate_limits_target', 'inference');

  const minutes = getTimeRangeMinutes(range);
  const days = minutes > 0 ? Math.max(1, Math.ceil(minutes / 1440)) : 365;

  const { data, error, isLoading } = useSWR<any>(
    `/api/rate-limits?days=${days}&target=${encodeURIComponent(target)}&limit=200`,
    fetcher,
    { refreshInterval: 30_000, keepPreviousData: true },
  );

  const byProvider: any[] = data?.byProvider ?? [];
  const byUpstream: any[] = data?.byUpstream ?? [];
  const attribution = data?.attribution ?? { named: 0, total: 0 };
  const unnamed = Math.max(0, (attribution.total ?? 0) - (attribution.named ?? 0));
  const byDay: any[] = data?.byDay ?? [];
  const recent: any[] = data?.recent ?? [];
  const targets: any[] = data?.targets ?? [];
  const maxDay = byDay.reduce((m, d) => Math.max(m, d.events), 0);

  return (
    <div className="space-y-5">
      <PageContext
        pageType="rate-limits"
        summary={`Rate limits. ${data?.total ?? 0} ${target} events over ${days}d.`}
        metrics={{ total: data?.total ?? 0, target, days }}
        details={byProvider.map((r) => `${r.provider} ${r.kind}: ${r.events}`).join('\n')}
      />

      <div className="flex items-center gap-4 flex-wrap">
        <h1 className="text-2xl font-bold">Rate Limits</h1>
        <TimeRangeSelect value={range} onChange={setRange} />
        <div className="flex items-center gap-1.5">
          <span className="text-xs text-[var(--color-muted)]">Throttled by</span>
          <select
            value={target}
            onChange={(e) => setTarget(e.target.value)}
            title={TARGET_HELP[target]}
            className="text-sm bg-[var(--color-background)] border border-[var(--color-border)] rounded px-2 py-1"
          >
            <option value="inference">inference providers</option>
            <option value="service">our services</option>
            <option value="web">crawled sites</option>
            <option value="all">everything</option>
          </select>
        </div>
        <span className="text-xs text-[var(--color-muted)]">
          {targets.map((t: any) => `${t.events} ${t.target}`).join(' · ')}
        </span>
      </div>

      <p className="text-sm text-[var(--color-muted)] max-w-3xl">
        {TARGET_HELP[target] ?? 'Every throttling event we recorded.'}
      </p>

      {error && <div className="text-[var(--color-error)]">Failed to load: {String(error)}</div>}
      {isLoading && !data && <div className="text-[var(--color-muted)]">Loading…</div>}

      {data && data.total === 0 && (
        <div className="text-[var(--color-muted)] border border-dashed border-[var(--color-border)] rounded p-6">
          No {target} throttling in this window. Nothing refused a call.
        </div>
      )}

      {byUpstream.length > 0 && (
        <div className="bg-[var(--color-surface)] border border-[var(--color-border)] rounded p-4">
          <h2 className="text-sm font-bold text-[var(--color-muted)] uppercase tracking-wide mb-1">
            Which upstream refused
          </h2>
          {unnamed > 0 && (
            <p className="text-xs text-[var(--color-muted)] mb-3">
              {unnamed} of {attribution.total} events do not name an upstream — the
              harness recorded that it was throttled but not by whom. That is a gap
              in the harness, not in this table.
            </p>
          )}
          <table className="w-full text-sm mb-4">
            <thead>
              <tr className="text-[var(--color-muted)] text-left">
                <th className="pb-2">Upstream</th>
                <th className="pb-2">Harness</th>
                <th className="pb-2">Call</th>
                <th className="pb-2">Kind</th>
                <th className="pb-2 text-right">Events</th>
                <th className="pb-2 text-right">Last</th>
              </tr>
            </thead>
            <tbody>
              {byUpstream.map((r, i) => {
                const named = r.upstream !== '(not reported)';
                return (
                  <tr key={i} className="border-t border-[var(--color-border)]">
                    <td className="py-1.5 font-mono">
                      {named ? r.upstream : (
                        <span
                          className="text-[var(--color-muted)] italic"
                          title="The harness logged a throttle without saying which provider refused."
                        >
                          not reported
                        </span>
                      )}
                    </td>
                    <td className="py-1.5 font-mono text-[var(--color-muted)]">{r.harness}</td>
                    <td className="py-1.5 text-[var(--color-muted)]">{r.operation || '—'}</td>
                    <td className="py-1.5" style={{ color: KIND_COLOR[r.kind] ?? 'inherit' }} title={KIND_HELP[r.kind]}>
                      {r.kind}
                    </td>
                    <td className="py-1.5 text-right font-bold">{r.events}</td>
                    <td className="py-1.5 text-right text-[var(--color-muted)]">
                      {formatRelativeTime(r.last_seen)}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {byProvider.length > 0 && (
        <div className="bg-[var(--color-surface)] border border-[var(--color-border)] rounded p-4">
          <h2 className="text-sm font-bold text-[var(--color-muted)] uppercase tracking-wide mb-3">
            Which harness hit it
          </h2>
          <table className="w-full text-sm">
            <thead>
              <tr className="text-[var(--color-muted)] text-left">
                <th className="pb-2">Provider</th>
                <th className="pb-2">Kind</th>
                <th className="pb-2 text-right">Events</th>
                <th className="pb-2 text-right">Avg retry-after</th>
                <th className="pb-2 text-right">Last</th>
              </tr>
            </thead>
            <tbody>
              {byProvider.map((r, i) => (
                <tr key={i} className="border-t border-[var(--color-border)]">
                  <td className="py-1.5 font-mono">{r.provider}</td>
                  <td className="py-1.5">
                    <span
                      title={KIND_HELP[r.kind]}
                      style={{ color: KIND_COLOR[r.kind] ?? 'inherit' }}
                    >
                      {r.kind}
                    </span>
                  </td>
                  <td className="py-1.5 text-right font-bold">{r.events}</td>
                  <td className="py-1.5 text-right text-[var(--color-muted)]">
                    {r.avg_retry_after_s ? `${Math.round(r.avg_retry_after_s)}s` : '—'}
                  </td>
                  <td className="py-1.5 text-right text-[var(--color-muted)]">
                    {formatRelativeTime(r.last_seen)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {byDay.length > 0 && (
        <div className="bg-[var(--color-surface)] border border-[var(--color-border)] rounded p-4">
          <h2 className="text-sm font-bold text-[var(--color-muted)] uppercase tracking-wide mb-3">
            By day
          </h2>
          <div className="flex items-end gap-0.5 h-24">
            {byDay.map((d) => (
              <div
                key={d.day}
                title={`${d.day}: ${d.events} event${d.events === 1 ? '' : 's'}`}
                className="flex-1 min-w-[2px] bg-[var(--color-error)] rounded-t opacity-80 hover:opacity-100"
                style={{ height: `${maxDay > 0 ? Math.max(2, (d.events / maxDay) * 100) : 0}%` }}
              />
            ))}
          </div>
          <div className="flex justify-between text-xs text-[var(--color-muted)] mt-1">
            <span>{byDay[0]?.day}</span>
            <span>peak {maxDay}/day</span>
            <span>{byDay[byDay.length - 1]?.day}</span>
          </div>
        </div>
      )}

      {recent.length > 0 && (
        <div className="bg-[var(--color-surface)] border border-[var(--color-border)] rounded p-4">
          <h2 className="text-sm font-bold text-[var(--color-muted)] uppercase tracking-wide mb-3">
            Most recent ({recent.length})
          </h2>
          <div className="space-y-1.5">
            {recent.map((r, i) => (
              <div key={i} className="text-sm border-t border-[var(--color-border)] pt-1.5">
                <div className="flex items-center gap-2 flex-wrap">
                  <span className="text-[var(--color-muted)] shrink-0">
                    {formatRelativeTime(r.timestamp)}
                  </span>
                  <span
                    className="font-bold shrink-0"
                    style={{ color: KIND_COLOR[r.kind] ?? 'inherit' }}
                    title={KIND_HELP[r.kind]}
                  >
                    {r.kind}
                  </span>
                  <span className="font-mono text-[var(--color-muted)] shrink-0">{r.provider ?? '—'}</span>
                  <span className="font-mono shrink-0" title="upstream that refused">
                    {r.upstream
                      ? `→ ${r.upstream}`
                      : <span className="text-[var(--color-muted)] italic opacity-60">→ upstream not reported</span>}
                  </span>
                  {r.operation && (
                    <span className="text-[var(--color-muted)] shrink-0">{r.operation} call</span>
                  )}
                  {r.http_status && (
                    <span className="text-[var(--color-muted)] shrink-0">HTTP {r.http_status}</span>
                  )}
                  {r.retry_after_s != null && (
                    <span className="text-[var(--color-muted)] shrink-0">retry {r.retry_after_s}s</span>
                  )}
                  {r.model && <span className="text-[var(--color-muted)] shrink-0">{r.model}</span>}
                  {r.project && (
                    <span className="text-[var(--color-muted)] shrink-0 opacity-70">{r.project}</span>
                  )}
                </div>
                <div className="font-mono text-xs text-[var(--color-foreground)] opacity-70 break-words">
                  {r.detail}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
