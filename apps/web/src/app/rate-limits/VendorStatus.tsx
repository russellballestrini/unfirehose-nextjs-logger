'use client';

import useSWR from 'swr';
import { formatRelativeTime } from '@unturf/unfirehose/format';

/* eslint-disable @typescript-eslint/no-explicit-any */

const fetcher = (url: string) => fetch(url).then((r) => r.json());

export const INDICATOR_COLOR: Record<string, string> = {
  none: '#22c55e', minor: '#f59e0b', major: '#ef4444',
  unreachable: '#a855f7', unknown: '#71717a', blocked_by_robots: '#71717a',
};
export const INDICATOR_LABEL: Record<string, string> = {
  none: 'operational', minor: 'degraded', major: 'outage',
  unreachable: 'page unreachable', unknown: 'unparseable', blocked_by_robots: 'robots.txt forbids',
};

function Light({ indicator, size = 10 }: { indicator: string | undefined; size?: number }) {
  return (
    <span
      className="inline-block rounded-full shrink-0"
      style={{ width: size, height: size, background: INDICATOR_COLOR[indicator ?? 'unknown'] ?? '#71717a' }}
      title={INDICATOR_LABEL[indicator ?? 'unknown']}
    />
  );
}

const HARD_KINDS = new Set(['server_error', 'overloaded', 'timeout', 'model_gone']);

export interface NowRow {
  provider: string; upstream: string | null; kind: string; http_status: number | null;
  m60: number; m15: number; last_seen: string; first_seen: string; sample: string;
}

/**
 * The first thing on "What we hit": what is being refused right now. The
 * tables below answer "how much, over the range"; this answers "is it
 * happening", in the last quarter-hour and hour, with the vendor's own
 * light beside each line so "us or them" is one glance. Hard refusals
 * (5xx, overloaded, timeout, model gone) paint it red — the provider did
 * not serve. Throttles alone paint it amber — it served and said slow down.
 */
export function NowBanner({ rows, at }: { rows: NowRow[]; at?: string }) {
  const { data } = useSWR<any>('/api/rate-limits/status', fetcher, { refreshInterval: 60_000 });
  const vendors: any[] = data?.current ?? [];
  const vendorFor = (r: NowRow) => vendors.find((v) => v.id === r.upstream || v.id === r.provider);

  const live = rows.filter((r) => r.m15 > 0);
  const hardLive = live.some((r) => HARD_KINDS.has(r.kind));
  const level: 'outage' | 'throttled' | 'recent' | 'quiet' =
    live.length === 0 ? (rows.length === 0 ? 'quiet' : 'recent') : hardLive ? 'outage' : 'throttled';
  const total15 = rows.reduce((s, r) => s + r.m15, 0);
  const total60 = rows.reduce((s, r) => s + r.m60, 0);

  const frame = {
    outage:    'bg-red-950/60 border-red-800',
    throttled: 'bg-amber-950/50 border-amber-800',
    recent:    'bg-[var(--color-surface)] border-[var(--color-border)]',
    quiet:     'bg-[var(--color-surface)] border-[var(--color-border)]',
  }[level];
  const headline = {
    outage:    `REFUSED NOW — ${total15} hard refusal${total15 === 1 ? '' : 's'} in the last 15 min`,
    throttled: `THROTTLED NOW — ${total15} refusal${total15 === 1 ? '' : 's'} in the last 15 min`,
    recent:    `Quiet for 15 min — ${total60} refusal${total60 === 1 ? '' : 's'} earlier this hour`,
    quiet:     'No refusals in the last hour',
  }[level];
  const headColor = level === 'outage' ? 'text-red-300' : level === 'throttled' ? 'text-amber-300' : level === 'recent' ? 'text-[var(--color-foreground)]' : 'text-green-400';

  const degradedVendors = vendors.filter((v) => v.poll && v.poll.indicator !== 'none' && v.poll.indicator !== 'unknown' && v.poll.indicator !== 'blocked_by_robots');

  return (
    <div className={`border rounded p-4 space-y-3 ${frame}`}>
      <div className="flex items-center gap-3 flex-wrap">
        <Light indicator={level === 'outage' ? 'major' : level === 'throttled' ? 'minor' : level === 'recent' ? 'unknown' : 'none'} size={12} />
        <span className={`font-bold tracking-wide ${headColor}`}>{headline}</span>
        {at && <span className="ml-auto text-xs text-[var(--color-muted)]">as of {formatRelativeTime(at)}</span>}
      </div>

      {rows.length > 0 && (
        <table className="w-full text-sm [&_th]:px-2 [&_td]:px-2 [&_th]:whitespace-nowrap">
          <thead>
            <tr className="text-[var(--color-muted)] text-left">
              <th className="pb-1">Harness → upstream</th>
              <th className="pb-1">Kind</th>
              <th className="pb-1 text-right">Status</th>
              <th className="pb-1 text-right">15 min</th>
              <th className="pb-1 text-right">60 min</th>
              <th className="pb-1">Last</th>
              <th className="pb-1">Vendor says</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r, i) => {
              const v = vendorFor(r);
              const hard = HARD_KINDS.has(r.kind);
              const dim = r.m15 === 0;
              return (
                <tr key={i} className={`border-t border-[var(--color-border)]/60 ${dim ? 'text-[var(--color-muted)]' : ''}`} title={r.sample}>
                  <td className="py-1 font-mono whitespace-nowrap">
                    {r.provider}
                    {r.upstream ? <span className="text-[var(--color-muted)]"> → </span> : null}
                    {r.upstream ?? <span className="text-[var(--color-muted)] italic"> (upstream not reported)</span>}
                  </td>
                  <td className="py-1 font-bold whitespace-nowrap" style={{ color: dim ? undefined : hard ? '#ef4444' : '#f59e0b' }}>{r.kind}</td>
                  <td className="py-1 text-right font-mono">{r.http_status ?? '—'}</td>
                  <td className={`py-1 text-right font-mono ${r.m15 > 0 ? 'font-bold' : ''}`}>{r.m15 || '—'}</td>
                  <td className="py-1 text-right font-mono">{r.m60}</td>
                  <td className="py-1 whitespace-nowrap">{formatRelativeTime(r.last_seen)}</td>
                  <td className="py-1">
                    {v?.poll ? (
                      <a href={v.url} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1.5 hover:underline" title={v.poll.description}>
                        <Light indicator={v.poll.indicator} />
                        <span>{INDICATOR_LABEL[v.poll.indicator]}</span>
                      </a>
                    ) : <span className="text-[var(--color-muted)]">—</span>}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}

      {degradedVendors.length > 0 && (
        <div className="flex flex-wrap gap-x-5 gap-y-1 text-sm pt-1 border-t border-[var(--color-border)]/60">
          <span className="text-[var(--color-muted)]">Vendors reporting trouble:</span>
          {degradedVendors.map((v) => (
            <a key={v.id} href={v.url} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1.5 hover:underline" title={v.poll.description}>
              <Light indicator={v.poll.indicator} />
              <span className="font-mono">{v.id}</span>
              <span className="text-[var(--color-muted)]">{INDICATOR_LABEL[v.poll.indicator]}{v.since ? ` since ${formatRelativeTime(v.since)}` : ''}</span>
            </a>
          ))}
        </div>
      )}
    </div>
  );
}

function HistoryStrip({ targetId }: { targetId: string }) {
  const { data } = useSWR<any>(`/api/rate-limits/status?history=${encodeURIComponent(targetId)}&hours=24`, fetcher, { refreshInterval: 60_000 });
  const polls: any[] = data?.history ?? [];
  if (polls.length === 0) return null;
  // 96 slots of 15 minutes ending at the newest poll; each shows the worst
  // light in its window. Slots from before our first poll are left blank
  // rather than drawn as an empty track — no data is not the same as green.
  const now = new Date(polls[polls.length - 1].timestamp).getTime();
  const first = new Date(polls[0].timestamp).getTime();
  const firstSlot = Math.max(0, 95 - Math.floor((now - first) / 900_000));
  const slots: (string | null)[] = Array(96).fill(null);
  const rank: Record<string, number> = { none: 0, unknown: 1, blocked_by_robots: 1, unreachable: 2, minor: 2, major: 3 };
  for (const p of polls) {
    const i = 95 - Math.floor((now - new Date(p.timestamp).getTime()) / 900_000);
    if (i < 0 || i > 95) continue;
    if (slots[i] === null || rank[p.indicator] > rank[slots[i]!]) slots[i] = p.indicator;
  }
  const coveredH = Math.max(1, Math.round((96 - firstSlot) / 4));
  return (
    <div className="space-y-1">
      <div className="flex gap-px h-2">
        {slots.map((ind, i) => (
          <span
            key={i}
            className="flex-1 rounded-[1px]"
            style={{ background: ind ? INDICATOR_COLOR[ind] : i < firstSlot ? 'transparent' : 'var(--color-border)' }}
          />
        ))}
      </div>
      <div className="flex justify-between text-[10px] text-[var(--color-muted)]">
        <span>{firstSlot > 0 ? `history since ${new Date(first).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })} · ${coveredH}h of 24h` : 'last 24h'}</span>
        <span>15-min slots, worst light</span>
      </div>
    </div>
  );
}

export function VendorStatusTab() {
  const { data, error, isLoading } = useSWR<any>('/api/rate-limits/status', fetcher, { refreshInterval: 30_000 });
  const current: any[] = data?.current ?? [];

  return (
    <div className="space-y-4">
      <p className="text-sm text-[var(--color-muted)]">
        Each vendor&apos;s own incident feed, polled every minute. The light is what their open incidents say.
      </p>
      {error && <div className="text-[var(--color-error)]">Failed to load: {String(error)}</div>}
      {isLoading && !data && <div className="text-[var(--color-muted)]">Loading…</div>}
      <div className="grid gap-3 md:grid-cols-2">
        {current.map((c) => {
          const p = c.poll;
          const open: any[] = (p?.incidents ?? []).filter((i: any) => i.open);
          return (
            <div key={c.id} className="bg-[var(--color-surface)] border border-[var(--color-border)] rounded p-4 space-y-2">
              <div className="flex items-center gap-2">
                <Light indicator={p?.indicator} size={12} />
                <a href={c.url} target="_blank" rel="noopener noreferrer" className="font-bold hover:underline">{c.name}</a>
                <span className="font-mono text-xs text-[var(--color-muted)]">{c.id}</span>
                {c.kind === 'http-probe' && (
                  <span className="text-[10px] px-1.5 py-0.5 rounded border border-[var(--color-border)] text-[var(--color-muted)]" title={c.note}>
                    edge probe
                  </span>
                )}
                <span className="ml-auto text-sm" style={{ color: INDICATOR_COLOR[p?.indicator ?? 'unknown'] }}>
                  {p ? INDICATOR_LABEL[p.indicator] : 'not polled yet'}
                </span>
              </div>
              <div className="text-sm">{p?.description ?? c.note ?? '—'}</div>
              {c.kind === 'http-probe' && <div className="text-xs text-[var(--color-muted)]">{c.note}</div>}
              <HistoryStrip targetId={c.id} />
              <div className="flex justify-between text-xs text-[var(--color-muted)]">
                <span>{p?.indicator !== 'none' && c.since ? `${INDICATOR_LABEL[p.indicator]} since ${formatRelativeTime(c.since)}` : ''}</span>
                <span>{p ? [`polled ${formatRelativeTime(p.timestamp)}`, p.latencyMs != null ? `${p.latencyMs}ms` : null, p.httpStatus != null ? `HTTP ${p.httpStatus}` : null].filter(Boolean).join(' · ') : ''}</span>
              </div>
              {c.note && p?.indicator !== 'none' && <div className="text-xs text-[var(--color-muted)] italic">{c.note}</div>}
              {open.length > 0 && (
                <ul className="text-sm space-y-1 pt-1 border-t border-[var(--color-border)]">
                  {open.map((i: any, n: number) => (
                    <li key={n} className="flex gap-2">
                      <span className="text-[var(--color-muted)] shrink-0">{i.status}</span>
                      {i.link ? <a href={i.link} target="_blank" rel="noopener noreferrer" className="hover:underline">{i.title}</a> : <span>{i.title}</span>}
                      <span className="ml-auto text-xs text-[var(--color-muted)] shrink-0">{formatRelativeTime(i.updatedAt)}</span>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          );
        })}
      </div>
      <p className="text-xs text-[var(--color-muted)]">
        Add or remove vendors with <code>POST /api/rate-limits/status</code> — see <code>/llms.txt</code>.
      </p>
    </div>
  );
}
