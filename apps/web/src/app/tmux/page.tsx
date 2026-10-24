'use client';

import { fetcher } from '@unturf/unfirehose-ui/fetcher';

import { useState, useRef } from 'react';
import useSWR from 'swr';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { EmptyState } from '@unturf/unfirehose-ui/EmptyState';
import { useTerminalIntegrations } from '@/integrations';

/* eslint-disable @typescript-eslint/no-explicit-any */

type Tab = 'sessions' | 'new';
/** 'tmux', or the id of an integration that launches its own sessions. */
type NewTarget = string;

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

  // Sessions list (localhost tmux) + deployment info
  const { data, isLoading, mutate } = useSWR('/api/tmux/stream', fetcher, { refreshInterval: 5000 });
  const sessions: string[] = data?.sessions ?? [];
  const deployments: Record<string, { todos: { id: number; uuid: string | null }[]; status: string; startedAt: string | null }> = data?.deployments ?? {};

  // Sessions an integration holds (cloud containers), when one is on
  const terminalIntegrations = useTerminalIntegrations();

  // Nicknames
  const { data: nicknamesData, mutate: mutateNicknames } = useSWR('/api/sessions/nickname', fetcher, { refreshInterval: 30000 });
  const nicknames: Record<string, { nickname: string; host: string; service_name: string }> = nicknamesData ?? {};

  // Nickname editing state
  const [editingNick, setEditingNick] = useState<{ sessionId: string; value: string } | null>(null);
  const nickInputRef = useRef<HTMLInputElement>(null);

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

  const saveNickname = async (sessionId: string, nickname: string, host: string, serviceName = '') => {
    await fetch('/api/sessions/nickname', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ session_id: sessionId, nickname, host, service_name: serviceName }),
    });
    setEditingNick(null);
    mutateNicknames();
  };

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-lg font-bold">Terminals</h2>
          <p className="text-sm text-[var(--color-muted)]">tmux sessions{terminalIntegrations.map(t => ` and ${t.blurb}`).join('')}.</p>
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
              <EmptyState
                what="No tmux sessions. Each one we can reach appears here, ready to watch or type into."
                action={<>
                  Start one from a shell, or{' '}
                  <button onClick={() => setTab('new')} className="text-[var(--color-accent)] hover:underline cursor-pointer">
                    create one here →
                  </button>
                </>}
                command="tmux new -s work"
              />
            )}
            <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-3">
              {sessions.map(s => {
                const nick = nicknames[s];
                const isEditing = editingNick?.sessionId === s;
                const dep = deployments[s];
                return (
                  <div key={s} className="bg-[var(--color-surface)] rounded border border-[var(--color-border)] hover:border-[var(--color-accent)]/50 transition-colors">
                    {/* Nickname row — always visible, stops link navigation */}
                    <div className="px-4 pt-3 pb-1" onClick={e => e.stopPropagation()}>
                      {isEditing ? (
                        <input
                          ref={nickInputRef}
                          autoFocus
                          value={editingNick?.value ?? ''}
                          onChange={e => setEditingNick({ sessionId: s, value: e.target.value })}
                          onKeyDown={e => {
                            const v = editingNick?.value ?? '';
                            if (e.key === 'Enter') saveNickname(s, v, 'localhost');
                            if (e.key === 'Escape') setEditingNick(null);
                          }}
                          onBlur={() => saveNickname(s, editingNick?.value ?? '', 'localhost')}
                          placeholder="nickname…"
                          className="w-full text-sm px-2 py-1 rounded border border-[var(--color-accent)]/50 bg-[var(--color-background)] font-bold outline-none"
                        />
                      ) : (
                        <button
                          onClick={() => setEditingNick({ sessionId: s, value: nick?.nickname ?? '' })}
                          className="w-full text-left text-sm font-bold hover:text-[var(--color-accent)] transition-colors truncate"
                        >
                          {nick?.nickname || <span className="text-[var(--color-muted)] font-normal text-xs">✎ add nickname</span>}
                        </button>
                      )}
                    </div>
                    <Link href={`/tmux/${encodeURIComponent(s)}`} className="block px-4 pb-3">
                      <div className="flex items-center gap-2 mt-1">
                        <span className="w-2 h-2 rounded-full bg-green-400 animate-pulse flex-shrink-0" />
                        <span className="text-xs font-mono text-[var(--color-muted)] truncate" title={s}>{s}</span>
                      </div>
                      {dep && dep.todos.length > 0 && (
                        <div className="flex items-center gap-1.5 mt-1.5 text-[10px] flex-wrap">
                          <span className={`font-bold ${dep.status === 'running' ? 'text-blue-400' : dep.status === 'completed' ? 'text-green-400' : 'text-[var(--color-muted)]'}`}>
                            {dep.status}
                          </span>
                          {dep.todos.map(t => (
                            <span key={t.id} className="text-[var(--color-muted)] font-mono">
                              #{t.id}{t.uuid && <span className="ml-0.5 opacity-50">{t.uuid.slice(-8)}</span>}
                            </span>
                          ))}
                        </div>
                      )}
                      <p className="text-[10px] text-[var(--color-muted)]/60 mt-1">localhost · click to view</p>
                    </Link>
                  </div>
                );
              })}
            </div>
          </div>

          {terminalIntegrations.map(({ id, Sessions }) => (
            <Sessions key={id} nicknames={nicknames} mutateNicknames={mutateNicknames}
              onLaunch={() => { setTab('new'); setNewTarget(id); }} />
          ))}
        </>
      )}

      {/* ── New session tab ── */}
      {tab === 'new' && (
        <div className="space-y-4">
          {/* Target picker */}
          <div className="flex gap-2">
            {([
              { id: 'tmux', label: '⬡ tmux', sub: 'local or SSH host' },
              ...terminalIntegrations.map(t => ({ id: t.id as string, label: t.label, sub: t.sub })),
            ]).map(t => (
              <button
                key={t.id}
                onClick={() => setNewTarget(t.id)}
                className={`px-4 py-3 rounded border text-sm font-bold transition-colors cursor-pointer text-left ${
                  newTarget === t.id
                    ? t.id !== 'tmux'
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
                      <EmptyState
                        compact
                        what="No projects with paths found. Projects whose directory we know are listed here to start in."
                        action="A project gets its path from the first session a harness logs there."
                        link={{ href: '/projects', label: 'Projects' }}
                      />
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

          {/* ── an integration's own launch form ── */}
          {terminalIntegrations.filter(t => t.id === newTarget).map(({ id, NewSession }) => <NewSession key={id} />)}
        </div>
      )}
    </div>
  );
}
