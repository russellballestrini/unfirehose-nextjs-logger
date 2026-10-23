'use client';

import { fetcher } from '@unturf/unfirehose-ui/fetcher';
import { useState } from 'react';
import useSWR from 'swr';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import type { TerminalSectionProps } from '../index';

/* eslint-disable @typescript-eslint/no-explicit-any */

const SESSIONS_KEY = '/api/unsandbox?action=sessions';

/** Our unsandbox containers, on the Sessions tab of /tmux. */
export function UnsandboxSessions({ nicknames, mutateNicknames, onLaunch }: TerminalSectionProps) {
  const { data: unsbData, isLoading: unsbLoading } = useSWR(SESSIONS_KEY, fetcher, { refreshInterval: 10000 });
  const unsbSessions: any[] = unsbData?.sessions ?? [];
  const [editingNick, setEditingNick] = useState<{ sessionId: string; value: string } | null>(null);

  const saveNickname = async (sessionId: string, nickname: string, serviceName = '') => {
    await fetch('/api/sessions/nickname', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ session_id: sessionId, nickname, host: 'unsandbox', service_name: serviceName }),
    });
    setEditingNick(null);
    mutateNicknames();
  };

  return (
    <div className="mt-4">
      <h3 className="text-sm font-bold text-violet-400 mb-2 uppercase tracking-wide">unsandbox</h3>
      {unsbLoading && <p className="text-sm text-[var(--color-muted)]">Loading...</p>}
      {!unsbLoading && unsbSessions.length === 0 && (
        <div className="text-sm text-[var(--color-muted)] text-center py-6 bg-[var(--color-surface)] rounded border border-[var(--color-border)]">
          No unsandbox sessions.{' '}
          <button onClick={onLaunch} className="text-violet-400 hover:underline">
            Launch one →
          </button>
        </div>
      )}
      <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-3">
        {unsbSessions.map((s: any) => {
          const sid = s.session_id ?? s.id;
          const nick = nicknames[sid];
          const isEditing = editingNick?.sessionId === sid;
          return (
            <div key={sid} className="bg-[var(--color-surface)] rounded border border-violet-900/40 hover:border-violet-500/50 transition-colors">
              {/* Nickname + service name row — always visible */}
              <div className="px-4 pt-3 pb-1 space-y-1" onClick={e => e.stopPropagation()}>
                {isEditing ? (
                  <div className="space-y-1">
                    <input
                      autoFocus
                      value={editingNick?.value ?? ''}
                      onChange={e => setEditingNick({ sessionId: sid, value: e.target.value })}
                      onKeyDown={e => {
                        const v = editingNick?.value ?? '';
                        if (e.key === 'Enter') saveNickname(sid, v, nick?.service_name ?? '');
                        if (e.key === 'Escape') setEditingNick(null);
                      }}
                      onBlur={() => saveNickname(sid, editingNick?.value ?? '', nick?.service_name ?? '')}
                      placeholder="nickname…"
                      className="w-full text-sm px-2 py-1 rounded border border-violet-500/50 bg-[var(--color-background)] font-bold outline-none"
                    />
                    <input
                      defaultValue={nick?.service_name ?? ''}
                      onBlur={async e => {
                        await fetch('/api/sessions/nickname', {
                          method: 'POST',
                          headers: { 'Content-Type': 'application/json' },
                          body: JSON.stringify({ session_id: sid, service_name: e.target.value, host: 'unsandbox' }),
                        });
                        mutateNicknames();
                      }}
                      placeholder="service name…"
                      className="w-full text-xs px-2 py-1 rounded border border-violet-500/30 bg-[var(--color-background)] font-mono outline-none text-violet-300"
                    />
                  </div>
                ) : (
                  <button
                    onClick={() => setEditingNick({ sessionId: sid, value: nick?.nickname ?? '' })}
                    className="w-full text-left text-sm font-bold hover:text-violet-300 transition-colors truncate"
                  >
                    {nick?.nickname || <span className="text-violet-400/50 font-normal text-xs">✎ add nickname</span>}
                  </button>
                )}
                {nick?.service_name && !isEditing && (
                  <p className="text-xs text-violet-400/70 font-mono truncate">⬡ {nick.service_name}</p>
                )}
              </div>
              <Link href={`/tmux/${encodeURIComponent(sid)}?host=unsandbox`} className="block px-4 pb-3">
                <div className="flex items-center gap-2 mt-1">
                  <span className="w-2 h-2 rounded-full bg-violet-400 animate-pulse flex-shrink-0" />
                  <span className="text-xs font-mono text-violet-300 truncate" title={sid}>{sid}</span>
                </div>
                {!nick?.service_name && s.container_name && (
                  <p className="text-xs text-[var(--color-muted)] font-mono mt-0.5 truncate">{s.container_name}</p>
                )}
                <p className="text-[10px] text-[var(--color-muted)]/60 mt-1">unsandbox · click to open</p>
              </Link>
            </div>
          );
        })}
      </div>
    </div>
  );
}

/** Launching a container, on the New tab of /tmux. */
export function UnsandboxNewSession() {
  const router = useRouter();
  const { mutate: mutateUnsb } = useSWR(SESSIONS_KEY, fetcher, { refreshInterval: 10000 });
  const [unsbShell, setUnsbShell] = useState('bash');
  const [unsbNetwork, setUnsbNetwork] = useState<'semitrusted' | 'zerotrust'>('semitrusted');
  const [unsbCreating, setUnsbCreating] = useState(false);
  const [unsbError, setUnsbError] = useState('');

  const createUnsandbox = async () => {
    setUnsbCreating(true);
    setUnsbError('');
    try {
      const res = await fetch('/api/unsandbox', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'session', shell: unsbShell, network: unsbNetwork }),
      });
      const data = await res.json();
      if (!res.ok || !data.session_id) { setUnsbError(data.error ?? 'Failed'); return; }
      await mutateUnsb();
      router.push(`/tmux/${encodeURIComponent(data.session_id)}?host=unsandbox`);
    } finally {
      setUnsbCreating(false);
    }
  };

  return (
    <div className="max-w-md space-y-4">
      <div className="bg-[var(--color-surface)] rounded border border-violet-900/40 p-4 space-y-3">
        <label className="text-sm font-bold text-violet-400 block">Shell</label>
        <div className="flex gap-2">
          {(['bash', 'zsh', 'sh', 'python3', 'node'].map(sh => (
            <button
              key={sh}
              onClick={() => setUnsbShell(sh)}
              className={`px-3 py-1.5 text-sm font-mono rounded border transition-colors cursor-pointer ${
                unsbShell === sh
                  ? 'border-violet-500 bg-violet-500/10 text-violet-200 font-bold'
                  : 'border-[var(--color-border)] text-[var(--color-muted)] hover:text-[var(--color-foreground)]'
              }`}
            >
              {sh}
            </button>
          )))}
        </div>
      </div>

      <div className="bg-[var(--color-surface)] rounded border border-violet-900/40 p-4 space-y-3">
        <label className="text-sm font-bold text-violet-400 block">Network</label>
        <div className="flex gap-2">
          {([
            { id: 'semitrusted' as const, label: 'semitrusted', sub: 'egress via proxy' },
            { id: 'zerotrust'   as const, label: 'zerotrust',   sub: 'no network' },
          ]).map(n => (
            <button
              key={n.id}
              onClick={() => setUnsbNetwork(n.id)}
              className={`px-3 py-2 text-sm font-mono rounded border transition-colors cursor-pointer text-left ${
                unsbNetwork === n.id
                  ? 'border-violet-500 bg-violet-500/10 text-violet-200 font-bold'
                  : 'border-[var(--color-border)] text-[var(--color-muted)] hover:text-[var(--color-foreground)]'
              }`}
            >
              {n.label}
              <span className="block text-[10px] font-normal opacity-70 mt-0.5">{n.sub}</span>
            </button>
          ))}
        </div>
      </div>

      {unsbError && <div className="text-sm text-red-400 font-mono px-1">{unsbError}</div>}

      <button
        onClick={createUnsandbox}
        disabled={unsbCreating}
        className="w-full py-3 rounded border font-bold text-base transition-colors cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed bg-violet-500/10 border-violet-500 text-violet-300 hover:bg-violet-500/20"
      >
        {unsbCreating ? 'Launching…' : '◈ Launch unsandbox container'}
      </button>
    </div>
  );
}
