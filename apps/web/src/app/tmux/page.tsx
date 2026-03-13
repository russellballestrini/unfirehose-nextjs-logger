'use client';

import { useState } from 'react';
import useSWR from 'swr';
import Link from 'next/link';
import { useRouter } from 'next/navigation';

/* eslint-disable @typescript-eslint/no-explicit-any */

const fetcher = (url: string) => fetch(url).then(r => r.json());

type Tab = 'sessions' | 'new';

const KNOWN_HOSTS = [
  'localhost',
  'neoblanka',
  'cammy.foxhop.net',
  'ai.foxhop.net',
  'guile.foxhop.net',
  '3090-ai.foxhop.net',
];

export default function TmuxListPage() {
  const router = useRouter();
  const [tab, setTab] = useState<Tab>('sessions');

  // Sessions list
  const { data, isLoading, mutate } = useSWR('/api/tmux/stream', fetcher, { refreshInterval: 5000 });
  const sessions: string[] = data?.sessions ?? [];

  // Projects for cwd picker
  const { data: projectsData } = useSWR('/api/projects', fetcher);
  const projects: any[] = (projectsData ?? []).filter((p: any) => p.path);

  // New session form
  const [name, setName] = useState('');
  const [host, setHost] = useState('localhost');
  const [customHost, setCustomHost] = useState('');
  const [command, setCommand] = useState('');
  const [cwd, setCwd] = useState('');           // '' = no project / custom
  const [cwdMode, setCwdMode] = useState<'none' | 'project' | 'custom'>('none');
  const [newProjectPath, setNewProjectPath] = useState('');
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState('');

  const effectiveHost = host === '__custom__' ? customHost : host;
  const effectiveCwd = cwdMode === 'project' ? cwd
    : cwdMode === 'custom' ? newProjectPath
    : '';

  const create = async () => {
    if (!name.trim()) { setError('Session name required'); return; }
    setCreating(true);
    setError('');
    try {
      const res = await fetch('/api/tmux/new', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: name.trim(),
          host: effectiveHost,
          command: command.trim() || undefined,
          cwd: effectiveCwd || undefined,
        }),
      });
      const data = await res.json();
      if (!res.ok) { setError(data.error ?? 'Failed'); return; }
      await mutate();
      const dest = effectiveHost && effectiveHost !== 'localhost'
        ? `/tmux/${encodeURIComponent(name.trim())}?host=${encodeURIComponent(effectiveHost)}`
        : `/tmux/${encodeURIComponent(name.trim())}`;
      router.push(dest);
    } finally {
      setCreating(false);
    }
  };

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-lg font-bold">tmux Sessions</h2>
          <p className="text-sm text-[var(--color-muted)]">Live terminal streams from running agents.</p>
        </div>
      </div>

      {/* Tabs */}
      <div className="flex items-center gap-0.5 border-b border-[var(--color-border)]">
        {([
          { id: 'sessions' as const, label: 'Sessions', icon: '▹' },
          { id: 'new'      as const, label: 'New',      icon: '+' },
        ]).map(t => (
          <button
            key={t.id}
            onClick={() => setTab(t.id)}
            className={`px-4 py-2 text-base rounded-t border-b-2 transition-colors cursor-pointer ${
              tab === t.id
                ? 'border-[var(--color-accent)] text-[var(--color-foreground)] font-bold'
                : 'border-transparent text-[var(--color-muted)] hover:text-[var(--color-foreground)]'
            }`}
          >
            <span className={tab === t.id ? 'text-[var(--color-accent)]' : ''}>{t.icon}</span>
            <span className="ml-1.5">{t.label}</span>
          </button>
        ))}
      </div>

      {/* ── Sessions tab ── */}
      {tab === 'sessions' && (
        <>
          {isLoading && <p className="text-sm text-[var(--color-muted)]">Loading...</p>}

          {!isLoading && sessions.length === 0 && (
            <div className="text-sm text-[var(--color-muted)] text-center py-8 bg-[var(--color-surface)] rounded border border-[var(--color-border)]">
              No tmux sessions running.{' '}
              <button onClick={() => setTab('new')} className="text-[var(--color-accent)] hover:underline">
                Create one →
              </button>
            </div>
          )}

          <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-3">
            {sessions.map(s => (
              <Link
                key={s}
                href={`/tmux/${encodeURIComponent(s)}`}
                className="bg-[var(--color-surface)] rounded border border-[var(--color-border)] p-4 hover:border-[var(--color-accent)]/50 transition-colors block"
              >
                <div className="flex items-center gap-2">
                  <span className="w-2 h-2 rounded-full bg-green-400 animate-pulse" />
                  <span className="text-base font-bold font-mono">{s}</span>
                </div>
                <p className="text-xs text-[var(--color-muted)] mt-1">Click to view live terminal</p>
              </Link>
            ))}
          </div>
        </>
      )}

      {/* ── New session tab ── */}
      {tab === 'new' && (
        <div className="max-w-md space-y-4">

          {/* Name */}
          <div className="bg-[var(--color-surface)] rounded border border-[var(--color-border)] p-4 space-y-2">
            <label className="text-sm font-bold text-[var(--color-muted)] block">Session name</label>
            <input
              type="text"
              value={name}
              onChange={e => setName(e.target.value)}
              onKeyDown={e => e.key === 'Enter' && create()}
              placeholder="my-session"
              className="w-full bg-[var(--color-background)] border border-[var(--color-border)] rounded px-3 py-2 text-base font-mono outline-none focus:border-[var(--color-accent)] transition-colors"
            />
          </div>

          {/* Host */}
          <div className="bg-[var(--color-surface)] rounded border border-[var(--color-border)] p-4 space-y-2">
            <label className="text-sm font-bold text-[var(--color-muted)] block">Where to spawn</label>
            <div className="grid grid-cols-2 gap-2">
              {KNOWN_HOSTS.map(h => (
                <button
                  key={h}
                  onClick={() => setHost(h)}
                  className={`px-3 py-2 text-sm font-mono rounded border transition-colors cursor-pointer text-left ${
                    host === h && host !== '__custom__'
                      ? 'border-[var(--color-accent)] text-[var(--color-foreground)] bg-[var(--color-accent)]/10 font-bold'
                      : 'border-[var(--color-border)] text-[var(--color-muted)] hover:text-[var(--color-foreground)] hover:border-[var(--color-accent)]/50'
                  }`}
                >
                  {h === 'localhost' ? '⌂ localhost' : `⬡ ${h}`}
                </button>
              ))}
              <button
                onClick={() => setHost('__custom__')}
                className={`px-3 py-2 text-sm font-mono rounded border transition-colors cursor-pointer text-left ${
                  host === '__custom__'
                    ? 'border-[var(--color-accent)] text-[var(--color-foreground)] bg-[var(--color-accent)]/10 font-bold'
                    : 'border-[var(--color-border)] text-[var(--color-muted)] hover:text-[var(--color-foreground)] hover:border-[var(--color-accent)]/50'
                }`}
              >
                + other host
              </button>
            </div>
            {host === '__custom__' && (
              <input
                type="text"
                value={customHost}
                onChange={e => setCustomHost(e.target.value)}
                placeholder="hostname or IP"
                className="w-full bg-[var(--color-background)] border border-[var(--color-border)] rounded px-3 py-2 text-base font-mono outline-none focus:border-[var(--color-accent)] transition-colors mt-2"
              />
            )}
          </div>

          {/* Project / cwd */}
          <div className="bg-[var(--color-surface)] rounded border border-[var(--color-border)] p-4 space-y-3">
            <label className="text-sm font-bold text-[var(--color-muted)] block">Project / working directory</label>
            <div className="flex gap-2">
              {(['none', 'project', 'custom'] as const).map(m => (
                <button
                  key={m}
                  onClick={() => setCwdMode(m)}
                  className={`px-3 py-1 text-xs rounded border transition-colors cursor-pointer ${
                    cwdMode === m
                      ? 'border-[var(--color-accent)] text-[var(--color-foreground)] bg-[var(--color-accent)]/10 font-bold'
                      : 'border-[var(--color-border)] text-[var(--color-muted)] hover:text-[var(--color-foreground)]'
                  }`}
                >
                  {m === 'none' ? 'none' : m === 'project' ? 'existing project' : 'new path'}
                </button>
              ))}
            </div>

            {cwdMode === 'project' && (
              <div className="space-y-1 max-h-48 overflow-y-auto pr-1">
                {projects.length === 0 && (
                  <p className="text-xs text-[var(--color-muted)]">No projects with paths found.</p>
                )}
                {projects.map((p: any) => (
                  <button
                    key={p.name}
                    onClick={() => setCwd(p.path)}
                    className={`w-full text-left px-3 py-2 rounded border text-xs font-mono transition-colors cursor-pointer ${
                      cwd === p.path
                        ? 'border-[var(--color-accent)] bg-[var(--color-accent)]/10 text-[var(--color-foreground)]'
                        : 'border-[var(--color-border)] text-[var(--color-muted)] hover:text-[var(--color-foreground)] hover:border-[var(--color-accent)]/40'
                    }`}
                  >
                    <span className="font-bold">{p.name.replace(/^-home-fox-/, '~/')}</span>
                    <span className="block text-[10px] opacity-60 mt-0.5">{p.path}</span>
                  </button>
                ))}
              </div>
            )}

            {cwdMode === 'custom' && (
              <input
                type="text"
                value={newProjectPath}
                onChange={e => setNewProjectPath(e.target.value)}
                placeholder="/home/fox/git/my-new-project"
                className="w-full bg-[var(--color-background)] border border-[var(--color-border)] rounded px-3 py-2 text-base font-mono outline-none focus:border-[var(--color-accent)] transition-colors"
              />
            )}

            {effectiveCwd && (
              <div className="text-xs font-mono text-[var(--color-accent)] truncate">→ {effectiveCwd}</div>
            )}
          </div>

          {/* Command (optional) */}
          <div className="bg-[var(--color-surface)] rounded border border-[var(--color-border)] p-4 space-y-2">
            <label className="text-sm font-bold text-[var(--color-muted)] block">
              Command <span className="font-normal text-[var(--color-muted)]">(optional — defaults to zsh/bash)</span>
            </label>
            <input
              type="text"
              value={command}
              onChange={e => setCommand(e.target.value)}
              onKeyDown={e => e.key === 'Enter' && create()}
              placeholder="claude  /  python3 train.py  /  bash"
              className="w-full bg-[var(--color-background)] border border-[var(--color-border)] rounded px-3 py-2 text-base font-mono outline-none focus:border-[var(--color-accent)] transition-colors"
            />
          </div>

          {error && (
            <div className="text-sm text-red-400 font-mono px-1">{error}</div>
          )}

          <button
            onClick={create}
            disabled={creating || !name.trim()}
            className="w-full py-3 rounded border font-bold text-base transition-colors cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed bg-[var(--color-accent)]/10 border-[var(--color-accent)] text-[var(--color-accent)] hover:bg-[var(--color-accent)]/20"
          >
            {creating ? 'Spawning…' : `▶ Spawn on ${effectiveHost || '…'}`}
          </button>
        </div>
      )}
    </div>
  );
}
