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

/**
 * One line per vendor whose name appears in the refusals view — the vendor's
 * own word beside our count. Nothing shown for vendors we do not poll.
 */
export function VendorStatusStrip({ providers }: { providers: string[] }) {
  const { data } = useSWR<any>('/api/rate-limits/status', fetcher, { refreshInterval: 60_000 });
  const rows: any[] = (data?.current ?? []).filter((c: any) => providers.includes(c.id) && c.poll);
  if (rows.length === 0) return null;
  return (
    <div className="bg-[var(--color-surface)] border border-[var(--color-border)] rounded px-4 py-2 text-sm flex flex-wrap gap-x-6 gap-y-1">
      {rows.map((c) => (
        <a key={c.id} href={c.url} target="_blank" rel="noopener noreferrer" className="flex items-center gap-2 hover:underline" title={c.poll.description}>
          <Light indicator={c.poll.indicator} />
          <span className="font-mono">{c.id}</span>
          <span className="text-[var(--color-muted)]">
            {INDICATOR_LABEL[c.poll.indicator]}
            {c.poll.indicator !== 'none' && c.since ? ` since ${formatRelativeTime(c.since)}` : ''}
          </span>
        </a>
      ))}
    </div>
  );
}

function HistoryStrip({ targetId }: { targetId: string }) {
  const { data } = useSWR<any>(`/api/rate-limits/status?history=${encodeURIComponent(targetId)}&hours=24`, fetcher, { refreshInterval: 60_000 });
  const polls: any[] = data?.history ?? [];
  if (polls.length === 0) return <div className="h-2 rounded bg-[var(--color-border)]" title="no polls yet" />;
  // 96 slots of 15 minutes; each shows the worst light in its window. The
  // newest poll anchors the axis so render stays pure.
  const now = new Date(polls[polls.length - 1].timestamp).getTime();
  const slots: (string | null)[] = Array(96).fill(null);
  const rank: Record<string, number> = { none: 0, unknown: 1, blocked_by_robots: 1, unreachable: 2, minor: 2, major: 3 };
  for (const p of polls) {
    const age = now - new Date(p.timestamp).getTime();
    const i = 95 - Math.floor(age / 900_000);
    if (i < 0 || i > 95) continue;
    if (slots[i] === null || rank[p.indicator] > rank[slots[i]!]) slots[i] = p.indicator;
  }
  return (
    <div className="flex gap-px h-2" title="last 24h, 15-minute slots, worst light per slot">
      {slots.map((ind, i) => (
        <span key={i} className="flex-1 rounded-[1px]" style={{ background: ind ? INDICATOR_COLOR[ind] : 'var(--color-border)' }} />
      ))}
    </div>
  );
}

export function VendorStatusTab() {
  const { data, error, isLoading } = useSWR<any>('/api/rate-limits/status', fetcher, { refreshInterval: 30_000 });
  const current: any[] = data?.current ?? [];

  return (
    <div className="space-y-4">
      <p className="text-sm text-[var(--color-muted)] max-w-3xl">
        Each vendor&apos;s incident feed, polled once a minute by our worker. The light is inferred from open
        incidents — degraded for elevated errors, outage when the title says so — because the feed is the one
        path every host&apos;s robots.txt allows. Language-model vendors only.
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
                <span className="ml-auto text-sm" style={{ color: INDICATOR_COLOR[p?.indicator ?? 'unknown'] }}>
                  {p ? INDICATOR_LABEL[p.indicator] : 'not polled yet'}
                </span>
              </div>
              <div className="text-sm">{p?.description ?? c.note ?? '—'}</div>
              <HistoryStrip targetId={c.id} />
              <div className="flex gap-4 text-xs text-[var(--color-muted)]">
                {p && <span>polled {formatRelativeTime(p.timestamp)}</span>}
                {p?.indicator !== 'none' && c.since && <span>in this state since {formatRelativeTime(c.since)}</span>}
                {p?.latencyMs != null && <span>{p.latencyMs}ms</span>}
                {p?.httpStatus != null && <span>HTTP {p.httpStatus}</span>}
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
