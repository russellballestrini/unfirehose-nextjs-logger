'use client';

import { useEffect, useRef } from 'react';
import Link from 'next/link';
import useSWR from 'swr';
import { fetcher } from '@unturf/unfirehose-ui/fetcher';
import { human as humanAgo } from '@unturf/unfirehose/ago';
import { formatBytes } from '@unturf/unfirehose/format';

// Seconds are the finest grain a person watching this cares about.
const human = (t: string | number) => humanAgo(t, { smallest: 'second' });

/* eslint-disable @typescript-eslint/no-explicit-any */

/**
 * Our first run, in place of a welcome card.
 *
 * A person who installs this and sees nothing leaves; one who watches their
 * own sessions arrive stays. So this shows, from our local machine only:
 * which harnesses are on disk (core's detector — the same one Settings and
 * `make doctor` read), whether our worker is running and how much it has
 * read, and the moment the first session lands it hands over to the
 * dashboard. It polls at the live cadence, so the numbers move while
 * someone watches.
 */

/** How often the wizard asks; the node page's live cadence. */
export const WIZARD_POLL_MS = 6000;

export type WizardStage = 'loading' | 'no-harness' | 'waiting-worker' | 'ingesting' | 'done';

export function wizardStage(s: any | undefined): WizardStage {
  if (!s) return 'loading';
  if (s.sessions > 0) return 'done';
  const found = (s.harnesses ?? []).some((h: any) => h.found);
  if (!found) return 'no-harness';
  return s.workerAlive ? 'ingesting' : 'waiting-worker';
}

const docHref = (doc: string) => `/schema?doc=${encodeURIComponent(doc)}`;

function Step({ n, title, state, children }: {
  n: number; title: string; state: 'done' | 'active' | 'pending'; children: React.ReactNode;
}) {
  const mark = state === 'done' ? '✓' : String(n);
  const ring = state === 'done'
    ? 'bg-[var(--color-accent)] text-black border-[var(--color-accent)]'
    : state === 'active'
      ? 'border-[var(--color-accent)] text-[var(--color-accent)]'
      : 'border-[var(--color-border)] text-[var(--color-muted)]';
  return (
    <li className="flex gap-3" data-step={n} data-state={state}>
      <span className={`shrink-0 w-7 h-7 rounded-full border flex items-center justify-center text-sm font-bold ${ring}`}>{mark}</span>
      <div className="min-w-0 flex-1 space-y-2">
        <h4 className={`text-base font-bold ${state === 'pending' ? 'text-[var(--color-muted)]' : ''}`}>{title}</h4>
        {children}
      </div>
    </li>
  );
}

export function FirstRunWizard({ onDone }: { onDone?: () => void }) {
  const { data: s, error } = useSWR('/api/onboarding', fetcher, { refreshInterval: WIZARD_POLL_MS });
  const stage = wizardStage(s);
  const handedOff = useRef(false);
  useEffect(() => {
    if (stage === 'done' && !handedOff.current) {
      handedOff.current = true;
      onDone?.();
    }
  }, [stage, onDone]);

  const harnesses: any[] = s?.harnesses ?? [];
  const found = harnesses.filter((h) => h.found);
  const claude = harnesses.find((h) => h.id === 'claude-code');

  return (
    <div className="border border-[var(--color-border)] rounded-xl p-6 sm:p-8 bg-[var(--color-surface)] space-y-6 max-w-3xl" data-stage={stage}>
      <div>
        <h3 className="text-2xl font-bold mb-2">Welcome to unfirehose</h3>
        <p className="text-base text-[var(--color-muted)]">
          Our local dashboard for machine learning coding agents: sessions, tokens, reasoning and cost across
          every harness you run. Everything below is read from this machine; nothing leaves it.
        </p>
      </div>

      {error && (
        <p className="text-[var(--color-error)]">Could not reach our web server&apos;s onboarding check: {String(error.message ?? error)}</p>
      )}

      {(s?.disk?.level === 'low' || s?.disk?.level === 'critical') && (
        <div role="alert" data-disk={s.disk.level}
             className="border rounded px-4 py-3 text-sm space-y-1"
             style={{ borderColor: s.disk.level === 'critical' ? 'var(--color-error)' : 'var(--color-tool)' }}>
          <p className="font-bold" style={{ color: s.disk.level === 'critical' ? 'var(--color-error)' : 'var(--color-tool)' }}>
            {formatBytes(s.disk.freeBytes)} free under our database{s.disk.path ? <> at <code>{s.disk.path}</code></> : null}
          </p>
          <p className="text-[var(--color-muted)]">
            {s.disk.level === 'critical'
              ? 'SQLite fails writes on a full disk. Free space, or point UNFIREHOSE_DIR at a bigger disk, before our worker reads your history.'
              : `Under ${formatBytes(s.disk.lowBytes)}. Our database grows with every session (a year of heavy use is several GB). Free space, or set a retention window later in Settings → Database.`}
          </p>
        </div>
      )}

      <ol className="space-y-6">
        <Step n={1} title="Harnesses on this machine" state={stage === 'loading' ? 'active' : found.length ? 'done' : 'active'}>
          {stage === 'loading' ? (
            <p className="text-sm text-[var(--color-muted)]">Looking…</p>
          ) : (
            <>
              <ul className="text-sm space-y-1" aria-label="harnesses">
                {harnesses.map((h) => (
                  <li key={h.id} className="flex flex-wrap items-baseline gap-x-2" data-harness={h.id} data-found={h.found ? 'yes' : 'no'}>
                    <span className={h.found ? 'text-[var(--color-accent)]' : 'text-[var(--color-muted)]'}>{h.found ? '●' : '○'}</span>
                    <span className="font-bold">{h.label}</span>
                    {h.found && h.readable && (
                      <span className="text-[var(--color-muted)]">
                        {h.files}{h.truncated ? '+' : ''} session file{h.files === 1 ? '' : 's'}
                        {h.newestMs ? `, newest ${human(h.newestMs)}` : ''}
                      </span>
                    )}
                    {h.found && !h.readable && <span className="text-[var(--color-error)]">found, but this process cannot read it</span>}
                    {!h.found && <span className="text-[var(--color-muted)]">not found</span>}
                    <code className="text-xs text-[var(--color-muted)] [overflow-wrap:anywhere]">{h.root}</code>
                  </li>
                ))}
              </ul>
              {found.length === 0 && (
                <div className="text-sm space-y-2 pt-1">
                  <p>No harness has written anything here yet. Start one — Claude Code is the quickest:</p>
                  <pre className="bg-[var(--color-background)] border border-[var(--color-border)] rounded px-3 py-2 overflow-x-auto"><code>{claude?.start ?? 'cd ~/your/repo && claude'}</code></pre>
                  <p className="text-[var(--color-muted)]">
                    Running something else? Every harness we read has an adapter doc:{' '}
                    <Link className="text-[var(--color-accent)] hover:underline" href={docHref('README.md')}>harness adapters</Link>.
                  </p>
                </div>
              )}
            </>
          )}
        </Step>

        <Step n={2} title="Reading your sessions" state={stage === 'ingesting' ? 'active' : stage === 'done' ? 'done' : 'pending'}>
          {s && (
            <div className="text-sm space-y-1">
              <p data-worker={s.workerAlive ? 'alive' : 'down'}>
                {s.workerAlive
                  ? <>Our worker is running{s.lastIngestAt ? <>, last pass {human(s.lastIngestAt)}</> : null}.</>
                  : <>Our worker has not reported in{s.lastIngestAt ? <> since {human(s.lastIngestAt)}</> : null}. Start it with <code className="text-[var(--color-accent)]">make dev</code> (or <code className="text-[var(--color-accent)]">make service-start</code>), and <code className="text-[var(--color-accent)]">make doctor</code> if it will not.</>}
              </p>
              <p className="font-mono" aria-label="ingest counts">
                <span data-count="messages">{Number(s.messages).toLocaleString()}</span> messages ·{' '}
                <span data-count="sessions">{Number(s.sessions).toLocaleString()}</span> sessions ·{' '}
                <span data-count="projects">{Number(s.projects).toLocaleString()}</span> projects
              </p>
            </div>
          )}
        </Step>

        <Step n={3} title="Your dashboard" state={stage === 'done' ? 'active' : 'pending'}>
          <p className="text-sm text-[var(--color-muted)]">
            {stage === 'done'
              ? 'Your first session is in. Opening our dashboard…'
              : 'Opens on its own the moment our first session lands.'}
          </p>
        </Step>
      </ol>

      <div className="flex flex-wrap gap-3 pt-2 border-t border-[var(--color-border)] text-sm">
        <Link href="/settings#Harnesses" className="px-3 py-1.5 rounded border border-[var(--color-border)] text-[var(--color-muted)] hover:text-[var(--color-foreground)]">Harness health</Link>
        <Link href="/schema" className="px-3 py-1.5 rounded border border-[var(--color-border)] text-[var(--color-muted)] hover:text-[var(--color-foreground)]">Schema docs</Link>
        <Link href="/live" className="px-3 py-1.5 rounded border border-[var(--color-border)] text-[var(--color-muted)] hover:text-[var(--color-foreground)]">Live stream</Link>
      </div>
    </div>
  );
}
