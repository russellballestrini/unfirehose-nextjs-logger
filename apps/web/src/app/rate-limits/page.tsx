'use client';

import useSWR from 'swr';
import { PageContext } from '@unturf/unfirehose-ui/PageContext';
import { TimeRangeSelect, useTimeRange, getTimeRangeMinutes } from '@unturf/unfirehose-ui/TimeRangeSelect';
import { useStickyState } from '@unturf/unfirehose-ui/useStickyState';
import { formatRelativeTime } from '@unturf/unfirehose/format';
import { VendorStatusTab, NowBanner } from './VendorStatus';

/* eslint-disable @typescript-eslint/no-explicit-any */

const fetcher = (url: string) => fetch(url).then((r) => r.json());

// What each bucket means, spelled out — "rate limit" gets used for four
// different conditions and the difference decides what you do about it.
// The last four are not throttles at all: a provider can refuse a call
// without limiting us, and those refusals were invisible here until the
// harness started reporting them.
const KIND_HELP: Record<string, string> = {
  rate_limit:  'too many requests per unit time — slow down or spread across providers',
  concurrency: 'too many calls in flight at once — queue them, do not retry harder',
  quota:       'plan or credit exhausted — waiting will not help until it resets',
  overloaded:  'the provider ran out of capacity — not caused by our usage',
  model_gone:  'this host no longer serves that model (404/410) — route elsewhere, retrying cannot bring it back',
  server_error: 'the provider returned a 5xx — its problem, not our request',
  timeout:     'no answer within the deadline',
  content_policy: 'a safety filter refused the call',
};

// Throttles share the warm end of the scale; non-throttle refusals sit on
// the cool end, so the two classes stay separable at a glance even when the
// kind filter is set to everything.
const KIND_COLOR: Record<string, string> = {
  rate_limit:  'var(--color-error)',
  concurrency: '#fbbf24',
  quota:       '#f87171',
  overloaded:  '#a78bfa',
  model_gone:  '#38bdf8',
  server_error: '#fb923c',
  timeout:     '#94a3b8',
  content_policy: '#f472b6',
};

// Which kinds are the provider limiting us, versus refusing us some other
// way. Drives the kind filter's two grouped shortcuts.
const THROTTLE_KINDS = ['rate_limit', 'concurrency', 'quota', 'overloaded'];

const TARGET_HELP: Record<string, string> = {
  inference: 'an LLM provider refused the call — this is the one that shapes cost and routing',
  service:   'our own infrastructure (unsandbox concurrency, Matrix)',
  web:       'a site we crawled answered 429 — real, but says nothing about our API budget',
};

/**
 * The HTTP status a refusal carried, always rendered: a dash says the harness
 * reported no code, which is itself information about that harness.
 */
function StatusCell({ status }: { status: number | null | undefined }) {
  if (status == null) return <span className="text-[var(--color-muted)]">—</span>;
  const color = status === 429 ? '#f59e0b' : status >= 500 ? '#ef4444' : 'inherit';
  return <span style={{ color }}>{status}</span>;
}

export default function RateLimitsPage() {
  const [range, setRange] = useTimeRange('rate_limits_range', '28d');
  const [target, setTarget] = useStickyState<string>('rate_limits_target', 'inference');
  const [kind, setKind] = useStickyState<string>('rate_limits_kind', 'all');
  // Vendor status is a tab here, not a page: to the person waiting on an
  // answer, the provider falling over and the provider refusing us are the
  // same event.
  const [tab, setTab] = useStickyState<'refusals' | 'status'>('rate_limits_tab', 'refusals');

  const minutes = getTimeRangeMinutes(range);

  const { data, error, isLoading } = useSWR<any>(
    `/api/rate-limits?minutes=${minutes}&target=${encodeURIComponent(target)}`
      + `&kind=${encodeURIComponent(kind)}&limit=200`,
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
  const kinds: any[] = data?.kinds ?? [];
  const maxDay = byDay.reduce((m, d) => Math.max(m, d.events), 0);

  return (
    <div className="space-y-5">
      <PageContext
        pageType="rate-limits"
        summary={`Refusals. Now: ${(data?.now?.rows ?? []).reduce((s: number, r: any) => s + r.m15, 0)} in the last 15 min, ${(data?.now?.rows ?? []).reduce((s: number, r: any) => s + r.m60, 0)} in the last hour. `
          + `${data?.total ?? 0} ${target} events over ${range === 'all' ? 'lifetime' : range}`
          + `${kind === 'all' ? '' : ` (kind: ${kind})`}.`}
        metrics={{ total: data?.total ?? 0, now_15m: (data?.now?.rows ?? []).reduce((s: number, r: any) => s + r.m15, 0), now_60m: (data?.now?.rows ?? []).reduce((s: number, r: any) => s + r.m60, 0), target, kind, range, minutes }}
        details={byProvider.map((r) => `${r.provider} ${r.kind}: ${r.events}`).join('\n')}
      />

      <div className="flex items-center gap-4 flex-wrap">
        <h1 className="text-2xl font-bold">Refusals</h1>
        <div className="flex rounded border border-[var(--color-border)] overflow-hidden text-sm">
          {([['refusals', 'What we hit'], ['status', 'What vendors admit']] as const).map(([id, label]) => (
            <button
              key={id}
              onClick={() => setTab(id)}
              className={`px-3 py-1 cursor-pointer ${tab === id ? 'bg-[var(--color-accent)] text-black font-bold' : 'text-[var(--color-muted)] hover:text-[var(--color-foreground)]'}`}
            >
              {label}
            </button>
          ))}
        </div>
        {tab === 'refusals' && (<>
        <TimeRangeSelect value={range} onChange={setRange} />
        <div className="flex items-center gap-1.5">
          <span className="text-xs text-[var(--color-muted)]">Kind</span>
          <select
            value={kind}
            onChange={(e) => setKind(e.target.value)}
            title={KIND_HELP[kind] ?? 'Every way a call was refused.'}
            className="text-sm bg-[var(--color-background)] border border-[var(--color-border)] rounded px-2 py-1"
          >
            <option value="all">all refusals</option>
            <option value="throttles">throttles only</option>
            <optgroup label="throttles">
              {THROTTLE_KINDS.map((k) => (
                <option key={k} value={k}>{k}</option>
              ))}
            </optgroup>
            <optgroup label="other refusals">
              {Object.keys(KIND_HELP)
                .filter((k) => !THROTTLE_KINDS.includes(k))
                .map((k) => (
                  <option key={k} value={k}>{k}</option>
                ))}
            </optgroup>
          </select>
        </div>
        <div className="flex items-center gap-1.5">
          <span className="text-xs text-[var(--color-muted)]">Refused by</span>
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
        </>)}
      </div>

      {tab === 'status' && <VendorStatusTab />}

      {tab === 'refusals' && (<>
      <NowBanner rows={data?.now?.rows ?? []} at={data?.now?.at} />

      {/* Every kind present in this window, whether or not the filter shows
          it. A kind that exists but is currently hidden should be one click
          away and visibly there — the whole defect being fixed here was a
          class of refusal nobody knew we were recording. */}
      {kinds.length > 0 && (
        <div className="flex items-center gap-2 flex-wrap text-xs">
          {kinds.map((k: any) => {
            const active = kind === k.kind
              || kind === 'all'
              || (kind === 'throttles' && THROTTLE_KINDS.includes(k.kind));
            return (
              <button
                key={k.kind}
                onClick={() => setKind(kind === k.kind ? 'all' : k.kind)}
                title={KIND_HELP[k.kind] ?? k.kind}
                className={`px-2 py-0.5 rounded border transition-opacity ${
                  active ? 'opacity-100' : 'opacity-40 hover:opacity-70'
                }`}
                style={{
                  borderColor: KIND_COLOR[k.kind] ?? 'var(--color-border)',
                  color: KIND_COLOR[k.kind] ?? 'inherit',
                }}
              >
                {k.kind} <span className="font-bold">{k.events}</span>
              </button>
            );
          })}
        </div>
      )}

      <p className="text-sm text-[var(--color-muted)] max-w-3xl">
        {TARGET_HELP[target] ?? 'Every refusal we recorded.'}
        {kind === 'all' && ' Throttles and every other way a call was refused — a provider can decline without limiting us, and a model that stops existing 404s rather than throttling.'}
      </p>

      {error && <div className="text-[var(--color-error)]">Failed to load: {String(error)}</div>}
      {isLoading && !data && <div className="text-[var(--color-muted)]">Loading…</div>}

      {data && data.total === 0 && (
        <div className="text-[var(--color-muted)] border border-dashed border-[var(--color-border)] rounded p-6">
          No {target} refusals{kind === 'all' ? '' : ` of kind ${kind}`} in this
          window. Nothing refused a call.
        </div>
      )}

      {byUpstream.length > 0 && (
        <div className="bg-[var(--color-surface)] border border-[var(--color-border)] rounded p-4">
          <h2 className="text-sm font-bold text-[var(--color-muted)] uppercase tracking-wide mb-1">
            Which upstream refused
          </h2>
          {unnamed > 0 && (
            <p className="text-xs text-[var(--color-muted)] mb-3">
              {unnamed} of {attribution.total} events do not name an upstream.
              {' '}Those were recovered by scanning harness output, and an error
              string does not carry the route it took — the provider is not in
              the text to find. The {attribution.reported ?? 0} reported directly
              by a harness know who refused them, because they were written at
              the moment of failure while the route was still known.
            </p>
          )}
          <table className="w-full text-sm mb-4 [&_th]:px-2 [&_td]:px-2 [&_th]:whitespace-nowrap">
            <thead>
              <tr className="text-[var(--color-muted)] text-left">
                <th className="pb-2">Upstream</th>
                <th className="pb-2">Harness</th>
                <th className="pb-2">Call</th>
                <th className="pb-2">Kind</th>
                <th className="pb-2 text-right">Status</th>
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
                    <td className="py-1.5 text-right font-mono">
                      <StatusCell status={r.http_status} />
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
          <table className="w-full text-sm [&_th]:px-2 [&_td]:px-2 [&_th]:whitespace-nowrap">
            <thead>
              <tr className="text-[var(--color-muted)] text-left">
                <th className="pb-2">Provider</th>
                <th className="pb-2">Kind</th>
                <th className="pb-2 text-right">Status</th>
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
                  <td className="py-1.5 text-right font-mono">
                    <StatusCell status={r.http_status} />
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
          <div className="space-y-1">
            {byDay.slice(-28).map((d) => (
              <div key={d.day} className="grid grid-cols-[6.5rem_1fr_3.5rem] items-center gap-3 text-sm">
                <span className="font-mono text-[var(--color-muted)]">{d.day}</span>
                <div className="h-3 rounded bg-[var(--color-border)]/40 overflow-hidden">
                  <div
                    className="h-full rounded bg-[var(--color-error)] opacity-80"
                    style={{ width: `${maxDay > 0 ? Math.max(1, (d.events / maxDay) * 100) : 0}%` }}
                    title={`${d.day}: ${d.events} event${d.events === 1 ? '' : 's'}`}
                  />
                </div>
                <span className="font-mono text-right">{d.events}</span>
              </div>
            ))}
          </div>
          {byDay.length > 28 && (
            <div className="text-xs text-[var(--color-muted)] mt-2">last 28 of {byDay.length} days shown</div>
          )}
        </div>
      )}

      {recent.length > 0 && (
        <div className="bg-[var(--color-surface)] border border-[var(--color-border)] rounded p-4">
          <h2 className="text-sm font-bold text-[var(--color-muted)] uppercase tracking-wide mb-3">
            Most recent ({recent.length})
          </h2>
          <div className="overflow-x-auto">
            <table className="w-full text-sm [&_th]:px-2 [&_td]:px-2 [&_th]:whitespace-nowrap">
              <thead>
                <tr className="text-[var(--color-muted)] text-left">
                  <th className="pb-2">When</th>
                  <th className="pb-2">Kind</th>
                  <th className="pb-2 text-right">Status</th>
                  <th className="pb-2">Harness</th>
                  <th className="pb-2">Upstream</th>
                  <th className="pb-2">Call</th>
                  <th className="pb-2 text-right">Retry</th>
                  <th className="pb-2">Model</th>
                  <th className="pb-2">Detail</th>
                </tr>
              </thead>
              <tbody>
                {recent.map((r, i) => (
                  <tr key={i} className="border-t border-[var(--color-border)] align-top">
                    <td className="py-1.5 text-[var(--color-muted)] whitespace-nowrap" title={r.timestamp}>
                      {formatRelativeTime(r.timestamp)}
                    </td>
                    <td className="py-1.5 font-bold whitespace-nowrap" style={{ color: KIND_COLOR[r.kind] ?? 'inherit' }} title={KIND_HELP[r.kind]}>
                      {r.kind}
                    </td>
                    <td className="py-1.5 text-right font-mono">
                      <StatusCell status={r.http_status} />
                    </td>
                    <td className="py-1.5 font-mono text-[var(--color-muted)]">{r.provider ?? '—'}</td>
                    <td className="py-1.5 font-mono" title="upstream that refused">
                      {r.upstream ?? <span className="text-[var(--color-muted)] italic opacity-60">not reported</span>}
                    </td>
                    <td className="py-1.5 text-[var(--color-muted)]">{r.operation || '—'}</td>
                    <td className="py-1.5 text-right text-[var(--color-muted)] whitespace-nowrap">
                      {r.retry_after_s != null ? `${r.retry_after_s}s` : '—'}
                    </td>
                    <td className="py-1.5 text-[var(--color-muted)] font-mono text-xs">{r.model ?? '—'}</td>
                    <td className="py-1.5 font-mono text-xs opacity-70 break-words min-w-[16rem]">
                      {r.detail}
                      {r.project && <span className="block opacity-70">{r.project}</span>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
      </>)}
    </div>
  );
}
