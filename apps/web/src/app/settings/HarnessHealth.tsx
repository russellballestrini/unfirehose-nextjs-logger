'use client';

import Link from 'next/link';
import useSWR from 'swr';
import { fetcher } from '@unturf/unfirehose-ui/fetcher';
import { human as humanAgo } from '@unturf/unfirehose/ago';

const human = (t: string | number) => humanAgo(t, { smallest: 'second' });

/* eslint-disable @typescript-eslint/no-explicit-any */

/**
 * One card per harness: where it writes, whether this machine has it, how
 * much of it our database holds, and when its last message arrived. When a
 * harness is missing, the adapter doc that explains how to feed it. Reads
 * /api/onboarding, so it agrees with the first-run wizard and with
 * `make doctor` — one detector, in core.
 */
export function HarnessHealth() {
  const { data, error } = useSWR('/api/onboarding', fetcher, { refreshInterval: 30_000 });
  if (error) return <p className="text-[var(--color-error)]">Could not read harness health: {String(error.message ?? error)}</p>;
  if (!data) return <p className="text-[var(--color-muted)]">Looking for harnesses…</p>;
  const harnesses: any[] = data.harnesses ?? [];

  return (
    <div className="space-y-4">
      <p className="text-base text-[var(--color-muted)]">
        Every harness our ingest reads, checked against this machine&apos;s disk and our database.
        Our worker {data.workerAlive ? <>is running{data.lastIngestAt ? <>; last pass {human(data.lastIngestAt)}</> : null}</> : <>has not reported recently; <code className="text-[var(--color-accent)]">make doctor</code> says why</>}.
      </p>
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        {harnesses.map((h) => {
          const status = !h.found ? 'missing' : !h.readable ? 'unreadable' : h.sessions > 0 ? 'ingesting' : 'found';
          const tone = status === 'unreadable' ? 'var(--color-error)' : status === 'missing' ? 'var(--color-muted)' : 'var(--color-accent)';
          return (
            <div key={h.id} data-harness={h.id} data-status={status}
                 className="bg-[var(--color-surface)] rounded border border-[var(--color-border)] p-4 space-y-2">
              <div className="flex items-baseline justify-between gap-2">
                <h3 className="text-base font-bold">{h.label}</h3>
                <span className="text-sm font-bold" style={{ color: tone }}>{status}</span>
              </div>
              <div className="text-sm font-mono text-[var(--color-muted)] [overflow-wrap:anywhere]">{h.root}</div>
              <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5 text-sm">
                <dt className="text-[var(--color-muted)]">On disk</dt>
                <dd>{h.found ? (h.readable ? `${h.files}${h.truncated ? '+' : ''} session files${h.newestMs ? `, newest ${human(h.newestMs)}` : ''}` : 'present, not readable by this process') : 'not found'}</dd>
                <dt className="text-[var(--color-muted)]">In our database</dt>
                <dd>{h.sessions.toLocaleString()} session{h.sessions === 1 ? '' : 's'}</dd>
                <dt className="text-[var(--color-muted)]">Last message</dt>
                <dd>{h.lastMessageAt ? human(h.lastMessageAt) : '—'}</dd>
              </dl>
              {status === 'unreadable' && (
                <p className="text-sm">Give our user read access: <code className="text-[var(--color-accent)]">chmod -R u+rX {h.root}</code></p>
              )}
              {status === 'missing' && (
                <p className="text-sm text-[var(--color-muted)]">
                  {h.start ? <>Start it with <code className="text-[var(--color-accent)]">{h.start}</code>, or read </> : <>Read </>}
                  <Link className="text-[var(--color-accent)] hover:underline" href={`/schema?doc=${encodeURIComponent(h.doc)}`}>its adapter doc</Link> for how to feed it.
                </p>
              )}
              {status === 'found' && (
                <p className="text-sm text-[var(--color-muted)]">On disk, not yet in our database: our worker picks it up on its next pass.</p>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
