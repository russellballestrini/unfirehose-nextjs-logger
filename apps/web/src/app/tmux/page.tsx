'use client';

import { useState } from 'react';
import useSWR from 'swr';
import Link from 'next/link';
import { useRouter } from 'next/navigation';

/* eslint-disable @typescript-eslint/no-explicit-any */

const fetcher = (url: string) => fetch(url).then(r => r.json());

type Tab = 'sessions' | 'new';
type NewTarget = 'tmux' | 'unsandbox';

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
  const [newTarget, setNewTarget] = useState<NewTarget>('tmux');

  // Sessions list (localhost tmux)
  const { data, isLoading, mutate } = useSWR('/api/tmux/stream', fetcher, { refreshInterval: 5000 });
  const sessions: string[] = data?.sessions ?? [];

  // Unsandbox sessions
  const { data: unsbData, isLoading: unsbLoading, mutate: mutateUnsb } = useSWR(
    '/api/unsandbox?action=sessions', fetcher, { refreshInterval: 10000 }
  );
  const unsbSessions: any[] = unsbData?.sessions ?? [];

  // Projects for cwd picker
  const { data: projectsData } = useSWR('/api/projects', fetcher);
  const projects: any[] = (projectsData ?? []).filter((p: any) => p.path);

  // New tmux session form
  const [name, setName] = useState('');
  const [host, setHost] = useState('localhost');
  const [customHost, setCustomHost] = useState('');
  const [command, setCommand] = useState('');
  const [cwd, setCwd] = useState('');
  const [cwdMode, setCwdMode] = useState<'none' | 'project' | 'custom'>('none');
  const [newProjectPath, setNewProjectPath] = useState('');
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState('');

  // New unsandbox session form
  const [unsbShell, setUnsbShell] = useState('bash');
  const [unsbNetwork, setUnsbNetwork] = useState<'semitrusted' | 'zerotrust'>('semitrusted');
  const [unsbCreating, setUnsbCreating] = useState(false);
  const [unsbError, setUnsbError] = useState('');

  const effectiveHost = host === '__custom__' ? customHost : host;
  const effectiveCwd = cwdMode === 'project' ? cwd : cwdMode === 'custom' ? newProjectPath : '';

  const createTmux = async () => {
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
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-lg font-bold">Terminals</h2>
          <p className="text-sm text-[var(--color-muted)]">tmux sessions and unsandbox containers.</p>
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
          {/* tmux sessions */}
          <div>
            <h3 className="text-sm font-bold text-[var(--color-muted)] mb-2 uppercase tracking-wide">tmux</h3>
            {isLoading && <p className="text-sm text-[var(--color-muted)]">Loading...</p>}
            {!isLoading && sessions.length === 0 && (
              <div className="text-sm text-[var(--color-muted)] text-center py-6 bg-[var(--color-surface)] rounded border border-[var(--color-border)]">
                No tmux sessions.{' '}
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
          </div>

          {/* unsandbox sessions */}
          <div className="mt-4">
            <h3 className="text-sm font-bold text-violet-400 mb-2 uppercase tracking-wide">unsandbox</h3>
            {unsbLoading && <p className="text-sm text-[var(--color-muted)]">Loading...</p>}
            {!unsbLoading && unsbSessions.length === 0 && (
              <div className="text-sm text-[var(--color-muted)] text-center py-6 bg-[var(--color-surface)] rounded border border-[var(--color-border)]">
                No unsandbox sessions.{' '}
                <button onClick={() => { setTab('new'); setNewTarget('unsandbox'); }} className="text-violet-400 hover:underline">
                  Launch one →
                </button>
              </div>
            )}
            <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-3">
              {unsbSessions.map((s: any) => (
                <Link
                  key={s.session_id ?? s.id}
                  href={`/tmux/${encodeURIComponent(s.session_id ?? s.id)}?host=unsandbox`}
                  className="bg-[var(--color-surface)] rounded border border-violet-900/40 p-4 hover:border-violet-500/50 transition-colors block"
                >
                  <div className="flex items-center gap-2">
                    <span className="w-2 h-2 rounded-full bg-violet-400 animate-pulse" />
                    <span className="text-base font-bold font-mono text-violet-300">{s.session_id ?? s.id}</span>
                  </div>
                  {s.container_name && <p className="text-xs text-[var(--color-muted)] font-mono mt-0.5">{s.container_name}</p>}
                  <p className="text-xs text-[var(--color-muted)] mt-1">Click to open unsandbox shell</p>
                </Link>
              ))}
            </div>
          </div>
        </>
      )}

      {/* ── New session tab ── */}
      {tab === 'new' && (
        <div className="space-y-4">
          {/* Target picker */}
          <div className="flex gap-2">
            {([
              { id: 'tmux' as const, label: '⬡ tmux', sub: 'local or SSH host' },
              { id: 'unsandbox' as const, label: '◈ unsandbox', sub: 'cloud container' },
            ]).map(t => (
              <button
                key={t.id}
                onClick={() => setNewTarget(t.id)}
                className={`px-4 py-3 rounded border text-sm font-bold transition-colors cursor-pointer text-left ${
                  newTarget === t.id
                    ? t.id === 'unsandbox'
                      ? 'border-violet-500 bg-violet-500/10 text-violet-300'
                      : 'border-[var(--color-accent)] bg-[var(--color-accent)]/10 text-[var(--color-accent)]'
                    : 'border-[var(--color-border)] text-[var(--color-muted)] hover:text-[var(--color-foreground)]'
                }`}
              >
                {t.label}
                <span className="block text-[10px] font-normal opacity-70 mt-0.5">{t.sub}</span>
              </button>
            ))}
          </div>

          {/* ── tmux form ── */}
          {newTarget === 'tmux' && (
            <div className="max-w-md space-y-4">
              {/* Name */}
              <div className="bg-[var(--color-surface)] rounded border border-[var(--color-border)] p-4 space-y-2">
                <label className="text-sm font-bold text-[var(--color-muted)] block">Session name</label>
                <input
                  type="text"
                  value={name}
                  onChange={e => setName(e.target.value)}
                  onKeyDown={e => e.key === 'Enter' && createTmux()}
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
                  onKeyDown={e => e.key === 'Enter' && createTmux()}
                  placeholder="claude  /  python3 train.py  /  bash"
                  className="w-full bg-[var(--color-background)] border border-[var(--color-border)] rounded px-3 py-2 text-base font-mono outline-none focus:border-[var(--color-accent)] transition-colors"
                />
              </div>

              {error && <div className="text-sm text-red-400 font-mono px-1">{error}</div>}

              <button
                onClick={createTmux}
                disabled={creating || !name.trim()}
                className="w-full py-3 rounded border font-bold text-base transition-colors cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed bg-[var(--color-accent)]/10 border-[var(--color-accent)] text-[var(--color-accent)] hover:bg-[var(--color-accent)]/20"
              >
                {creating ? 'Spawning…' : `▶ Spawn on ${effectiveHost || '…'}`}
              </button>
            </div>
          )}

          {/* ── unsandbox form ── */}
          {newTarget === 'unsandbox' && (
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
          )}
        </div>
      )}
    </div>
  );
}
