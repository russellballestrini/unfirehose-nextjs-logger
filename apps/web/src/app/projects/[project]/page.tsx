'use client';

import { use, useState, useEffect, useCallback } from 'react';
import useSWR from 'swr';
import Link from 'next/link';
import type { SessionIndexEntry, ProjectMetadata } from '@unturf/unfirehose/types';
import { formatRelativeTime, formatTokens, gitRemoteToWebUrl, commitUrl } from '@unturf/unfirehose/format';
import { PageContext } from '@unturf/unfirehose-ui/PageContext';
import { SessionPopover } from '@unturf/unfirehose-ui/SessionPopover';

/* eslint-disable @typescript-eslint/no-explicit-any */

const fetcher = (url: string) => fetch(url).then((r) => r.json());

const HARNESSES = [
  { value: 'claude', label: 'Claude Code', cmd: 'claude' },
  { value: 'gemini', label: 'Gemini CLI', cmd: 'gemini' },
  { value: 'codex', label: 'Codex CLI', cmd: 'codex' },
  { value: 'open-code', label: 'Open Code', cmd: 'opencode' },
  { value: 'aider', label: 'Aider', cmd: 'aider' },
  { value: 'agnt', label: 'agnt', cmd: 'agnt' },
  { value: 'cursor', label: 'Cursor', cmd: 'cursor' },
  { value: 'continue', label: 'Continue', cmd: 'continue' },
  { value: 'qwen3-coder', label: 'Qwen 3 Coder', cmd: 'ollama run qwen3-coder:8b' },
  { value: 'ollama', label: 'Ollama', cmd: 'ollama' },
  { value: 'fetch', label: 'Fetch', cmd: 'fetch' },
  { value: 'uncloseai', label: 'uncloseai-cli', cmd: 'uncloseai' },
  { value: 'custom', label: 'Custom...', cmd: '' },
] as const;

const TABS = [
  { key: 'overview', label: 'Overview' },
  { key: 'sessions', label: 'Sessions' },
  { key: 'commits', label: 'Commits' },
  { key: 'todos', label: 'Todos' },
  { key: 'activity', label: 'Activity' },
  { key: 'tokens', label: 'Tokens' },
  { key: 'code', label: 'Code' },
] as const;

type TabKey = (typeof TABS)[number]['key'];

function StatCard({ label, value, sub }: { label: string; value: string | number; sub?: string }) {
  return (
    <div className="border border-[var(--color-border)] rounded p-3">
      <div className="text-lg font-bold">{value}</div>
      <div className="text-xs text-[var(--color-muted)]">{label}</div>
      {sub && <div className="text-xs text-[var(--color-muted)] mt-0.5">{sub}</div>}
    </div>
  );
}

function ProgressBar({ value, max, label, detail }: { value: number; max: number; label: string; detail: string }) {
  const pct = max > 0 ? (value / max) * 100 : 0;
  return (
    <div className="flex items-center gap-3 text-sm">
      <span className="w-14 text-[var(--color-muted)] shrink-0">{label}</span>
      <div className="flex-1 h-2.5 bg-[var(--color-surface-hover)] rounded overflow-hidden">
        <div className="h-full bg-[var(--color-accent)] rounded transition-all" style={{ width: `${Math.min(pct, 100)}%` }} />
      </div>
      <span className="w-36 text-right text-[var(--color-muted)] shrink-0">{pct.toFixed(1)}% ({detail})</span>
    </div>
  );
}

export default function ProjectPage({
  params,
}: {
  params: Promise<{ project: string }>;
}) {
  const { project } = use(params);
  const decodedProject = decodeURIComponent(project);
  const [tab, setTab] = useState<TabKey>('overview');
  const [yolo, setYolo] = useState(true);
  const [booting, setBooting] = useState(false);
  const [bootResult, setBootResult] = useState<string | null>(null);
  const [bootTmux, setBootTmux] = useState<{ session: string; host: string } | null>(null);
  const [newTask, setNewTask] = useState('');
  const [taskSubmitting, setTaskSubmitting] = useState(false);
  const [harness, setHarness] = useState('claude');
  const [customCmd, setCustomCmd] = useState('');
  const [target, setTarget] = useState('localhost');

  // Mesh nodes for target dropdown
  const { data: mesh } = useSWR('/api/mesh', fetcher, { revalidateOnFocus: false });
  const { data: unsandboxStatus } = useSWR('/api/unsandbox', fetcher, { revalidateOnFocus: false });
  const meshNodes: { hostname: string; reachable: boolean }[] = mesh?.nodes ?? [];
  const targets = [
    { value: 'localhost', label: 'localhost' },
    ...meshNodes.filter(n => n.reachable && n.hostname !== mesh?.localHostname).map(n => ({ value: n.hostname, label: n.hostname })),
    ...(unsandboxStatus?.connected ? [{ value: 'unsandbox', label: 'unsandbox.com' }] : []),
  ];

  // Core data
  const { data, error } = useSWR<{
    project: string;
    originalPath: string;
    sessions: SessionIndexEntry[];
  }>(`/api/projects/${project}/sessions`, fetcher);

  const { data: meta } = useSWR<ProjectMetadata>(
    `/api/projects/metadata?project=${encodeURIComponent(decodedProject)}`,
    fetcher
  );

  const { data: full, mutate: mutateFull } = useSWR<any>(
    `/api/projects/${project}/full`,
    fetcher
  );

  const { data: globalActivity } = useSWR<any[]>(
    '/api/projects/activity?days=30',
    fetcher
  );

  // Activity data (prompt-commit correlation)
  const { data: activityData } = useSWR<any>(
    `/api/projects/activity?project=${encodeURIComponent(decodedProject)}`,
    fetcher
  );

  // Git data (for code tab) — only fetch when on code tab
  const { data: gitData, mutate: mutateGit } = useSWR<any>(
    tab === 'code' ? `/api/projects/${project}/git` : null,
    fetcher
  );

  function resolveHarness(): string {
    if (harness === 'custom') return customCmd.trim() || 'claude';
    return HARNESSES.find(h => h.value === harness)?.cmd ?? 'claude';
  }

  // Get git remote URL from metadata for unsandbox (no local path needed)
  const gitRemoteUrl = meta?.remotes?.find((r: any) => r.type === 'fetch' && r.name === 'origin')?.url
    ?? meta?.remotes?.find((r: any) => r.type === 'fetch')?.url;

  async function bootSession(sessionId?: string) {
    if (!data?.originalPath && target !== 'unsandbox') {
      setBootResult('Error: No project path — cannot boot session.');
      return;
    }
    if (target === 'unsandbox' && !data?.originalPath && !gitRemoteUrl) {
      setBootResult('Error: No project path or git remote — cannot boot on unsandbox.');
      return;
    }
    setBooting(true);
    setBootResult(null);
    setBootTmux(null);
    try {
      const res = await fetch('/api/boot', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          projectPath: data?.originalPath || decodedProject.replace(/-/g, '/'),
          projectName: decodedProject,
          sessionId,
          yolo,
          harness: resolveHarness(),
          host: target !== 'localhost' ? target : undefined,
          repoUrl: target === 'unsandbox' ? gitRemoteUrl : undefined,
        }),
      });
      const result = await res.json();
      if (result.success) {
        const hostLabel = result.host && result.host !== 'localhost' ? ` [${result.host}]` : '';
        setBootResult(`${result.command}${hostLabel}`);
        if (result.tmuxSession) setBootTmux({ session: result.tmuxSession, host: result.host ?? 'localhost' });
      } else {
        setBootResult(`Error: ${result.error}${result.detail ? ' — ' + result.detail : ''}`);
      }
    } catch (err) {
      setBootResult(`Error: ${String(err)}`);
    }
    setBooting(false);
  }

  async function addTask(startNow: boolean) {
    if (!newTask.trim() || taskSubmitting) return;
    setTaskSubmitting(true);
    try {
      const todoRes = await fetch('/api/todos', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          content: newTask.trim(),
          projectName: decodedProject,
          source: 'manual',
          status: startNow ? 'in_progress' : 'pending',
        }),
      });
      const todoResult = await todoRes.json();
      const canBoot = data?.originalPath || (target === 'unsandbox' && gitRemoteUrl);
      if (startNow && !canBoot) {
        setBootResult('Error: No project path — cannot spawn agent.');
      } else if (startNow && canBoot) {
        const res = await fetch('/api/boot', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            projectPath: data?.originalPath || decodedProject.replace(/-/g, '/'),
            projectName: decodedProject,
            yolo: true,
            prompt: newTask.trim(),
            todoIds: todoResult.id ? [todoResult.id] : undefined,
            harness: resolveHarness(),
            host: target !== 'localhost' ? target : undefined,
            repoUrl: target === 'unsandbox' ? gitRemoteUrl : undefined,
          }),
        });
        const result = await res.json();
        if (result.success) {
          const hostLabel = result.host && result.host !== 'localhost' ? ` [${result.host}]` : '';
          setBootResult(`${result.command}${hostLabel}`);
          if (result.tmuxSession) setBootTmux({ session: result.tmuxSession, host: result.host ?? 'localhost' });
        } else {
          setBootResult(`Error: ${result.error}${result.detail ? ' — ' + result.detail : ''}`);
        }
      }
      setNewTask('');
      mutateFull();
    } catch {}
    setTaskSubmitting(false);
  }

  if (error) return <div className="text-[var(--color-error)]">Failed to load: {String(error)}</div>;
  if (!data) return <div className="text-[var(--color-muted)]">Loading...</div>;

  const thisActivity = (globalActivity ?? []).find((a: any) => a.name === decodedProject);
  const globalTotals = (globalActivity ?? []).reduce(
    (acc: any, a: any) => ({
      input: acc.input + (a.total_input ?? 0),
      output: acc.output + (a.total_output ?? 0),
      cost: acc.cost + (a.cost_estimate ?? 0),
    }),
    { input: 0, output: 0, cost: 0 }
  );

  const fetchRemotes = meta?.remotes?.filter((r: any) => r.type === 'fetch') ?? [];
  const todoCount = full?.todos?.length ?? 0;
  const commitCount = meta?.recentCommits?.length ?? 0;

  return (
    <div className="space-y-4">
      <PageContext
        pageType="project-detail"
        summary={`Project: ${decodedProject}. ${data.sessions.length} sessions.`}
        metrics={{ project: decodedProject, sessions: data.sessions.length, path: data.originalPath || '' }}
      />

      {/* Header */}
      <div>
        <div className="flex items-center gap-3 text-sm">
          <Link href="/projects" className="text-[var(--color-muted)] hover:text-[var(--color-foreground)]">
            &larr; Projects
          </Link>
        </div>
        <div className="flex items-center gap-3 mt-1">
          <h1 className="text-xl font-bold">{full?.project?.displayName ?? decodedProject}</h1>
          {full?.visibility && (
            <span className={`text-xs px-1.5 py-0.5 rounded ${
              full.visibility === 'public' ? 'text-green-400 bg-green-400/10' :
              full.visibility === 'unlisted' ? 'text-yellow-400 bg-yellow-400/10' :
              'text-[var(--color-muted)] bg-[var(--color-surface-hover)]'
            }`}>
              {full.visibility}
            </span>
          )}
          {meta && (fetchRemotes.length > 0 || meta.branch) && (
            <>
              {meta.branch && (
                <span className="text-sm bg-[var(--color-surface-hover)] text-[var(--color-accent)] px-2 py-0.5 rounded font-mono">
                  {meta.branch}
                </span>
              )}
              {fetchRemotes.map((r: any) => {
                const webUrl = gitRemoteToWebUrl(r.url);
                return webUrl ? (
                  <a key={`${r.name}-${r.url}`} href={webUrl} target="_blank" rel="noopener noreferrer" className="text-sm text-[var(--color-accent)] hover:underline">
                    {webUrl.replace(/^https?:\/\//, '')}
                  </a>
                ) : (
                  <span key={`${r.name}-${r.url}`} className="text-sm font-mono text-[var(--color-muted)]">{r.url}</span>
                );
              })}
            </>
          )}
          {data.originalPath && (
            <div className="ml-auto flex items-center gap-2">
              <label className="flex items-center gap-1.5 text-sm text-[var(--color-muted)] cursor-pointer">
                <input type="checkbox" checked={yolo} onChange={(e) => setYolo(e.target.checked)} className="accent-[var(--color-error)]" />
                Yolo
              </label>
              <button
                onClick={() => bootSession()}
                disabled={booting}
                className="px-3 py-1 text-sm font-bold bg-[var(--color-accent)] text-[var(--color-background)] rounded hover:opacity-90 transition-opacity disabled:opacity-50"
              >
                {booting ? 'Booting...' : 'Boot Session'}
              </button>
            </div>
          )}
        </div>
        {data.originalPath && (
          <p className="text-sm text-[var(--color-muted)] font-mono mt-1">{data.originalPath}</p>
        )}
        {bootResult && (
          <div className={`text-sm font-mono mt-1 flex items-center gap-3 ${bootResult.startsWith('Error') ? 'text-[var(--color-error)]' : 'text-[var(--color-accent)]'}`}>
            <span>{bootResult}</span>
            {bootTmux && (
              <Link
                href={`/tmux/${encodeURIComponent(bootTmux.session)}${bootTmux.host !== 'localhost' ? `?host=${encodeURIComponent(bootTmux.host)}` : ''}`}
                className="inline-flex items-center gap-1 px-2 py-0.5 rounded bg-[var(--color-accent)]/15 text-[var(--color-accent)] hover:bg-[var(--color-accent)]/25 transition-colors text-xs font-bold"
              >
                ▸ Watch Terminal
              </Link>
            )}
          </div>
        )}
      </div>

      {/* Tab bar */}
      <div className="flex items-center gap-1 border-b border-[var(--color-border)] overflow-x-auto">
        {TABS.map((t) => {
          const badge =
            t.key === 'sessions' ? data.sessions.length :
            t.key === 'todos' ? todoCount :
            t.key === 'commits' ? commitCount :
            null;
          return (
            <button
              key={t.key}
              onClick={() => setTab(t.key)}
              className={`px-4 py-2 text-sm font-medium border-b-2 transition-colors whitespace-nowrap ${
                tab === t.key
                  ? 'border-[var(--color-accent)] text-[var(--color-accent)]'
                  : 'border-transparent text-[var(--color-muted)] hover:text-[var(--color-foreground)] hover:border-[var(--color-border)]'
              }`}
            >
              {t.label}
              {badge != null && badge > 0 && (
                <span className="ml-1.5 text-xs px-1.5 py-0.5 rounded-full bg-[var(--color-surface-hover)]">{badge}</span>
              )}
            </button>
          );
        })}
        <Link
          href={`/projects/${project}/kanban`}
          className="px-4 py-2 text-sm font-medium border-b-2 border-transparent text-[var(--color-muted)] hover:text-[var(--color-foreground)] hover:border-[var(--color-border)] transition-colors whitespace-nowrap"
        >
          Kanban
        </Link>
      </div>

      {/* Tab content */}
      {tab === 'overview' && (
        <OverviewTab
          full={full}
          data={data}
          meta={meta}
          project={project}
          decodedProject={decodedProject}
          thisActivity={thisActivity}
          globalTotals={globalTotals}
          fetchRemotes={fetchRemotes}
          newTask={newTask}
          setNewTask={setNewTask}
          addTask={addTask}
          taskSubmitting={taskSubmitting}
          harness={harness}
          setHarness={setHarness}
          customCmd={customCmd}
          setCustomCmd={setCustomCmd}
          target={target}
          setTarget={setTarget}
          targets={targets}
        />
      )}
      {tab === 'sessions' && (
        <SessionsTab data={data} project={project} />
      )}
      {tab === 'commits' && (
        <CommitsTab meta={meta} fetchRemotes={fetchRemotes} activityData={activityData} project={project} />
      )}
      {tab === 'todos' && (
        <TodosTab full={full} project={project} decodedProject={decodedProject} />
      )}
      {tab === 'activity' && (
        <ActivityTab activityData={activityData} project={project} decodedProject={decodedProject} />
      )}
      {tab === 'tokens' && (
        <TokensTab full={full} thisActivity={thisActivity} globalTotals={globalTotals} />
      )}
      {tab === 'code' && (
        <CodeTab gitData={gitData} mutateGit={mutateGit} project={project} />
      )}
    </div>
  );
}

/* ─── OVERVIEW TAB ─── */
function OverviewTab({ full, data, meta, project, decodedProject, thisActivity, globalTotals, fetchRemotes, newTask, setNewTask, addTask, taskSubmitting, harness, setHarness, customCmd, setCustomCmd, target, setTarget, targets }: any) {
  const gitRemoteUrl = meta?.remotes?.find((r: any) => r.type === 'fetch' && r.name === 'origin')?.url
    ?? meta?.remotes?.find((r: any) => r.type === 'fetch')?.url;
  return (
    <div className="space-y-6">
      {/* Stats bar */}
      {full?.stats && (
        <div className="grid grid-cols-3 md:grid-cols-6 gap-3">
          <StatCard label="Sessions" value={full.stats.sessionCount} />
          <StatCard label="Messages" value={full.stats.messageCount.toLocaleString()} />
          <StatCard label="Input" value={formatTokens(full.stats.totalInput)} />
          <StatCard label="Output" value={formatTokens(full.stats.totalOutput)} />
          <StatCard label="Active Days" value={full.stats.activeDays} sub={full.stats.firstActivity ? `since ${formatRelativeTime(full.stats.firstActivity)}` : undefined} />
          <StatCard label="Equiv Cost" value={`$${full.stats.totalCost.toFixed(2)}`} />
        </div>
      )}

      <div className="grid grid-cols-1 lg:grid-cols-[1fr_340px] gap-6">
        {/* Left */}
        <div className="space-y-6 min-w-0">
          {/* Task input */}
          <div className="border-2 border-[var(--color-accent)] rounded-lg p-4 bg-[var(--color-surface)]">
            <textarea
              value={newTask}
              onChange={(e: any) => setNewTask(e.target.value)}
              onKeyDown={(e: any) => {
                if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); addTask(true); }
                if (e.key === 'Enter' && e.shiftKey) { e.preventDefault(); addTask(false); }
              }}
              placeholder="What should the agent work on? (Ctrl+Enter to start now, Shift+Enter to queue)"
              rows={3}
              className="w-full px-3 py-2 text-base bg-[var(--color-background)] border border-[var(--color-border)] rounded-lg focus:border-[var(--color-accent)] focus:outline-none focus:ring-1 focus:ring-[var(--color-accent)] resize-y"
              disabled={taskSubmitting}
            />
            {/* Harness + Target selectors */}
            <div className="flex items-center gap-3 mt-2 flex-wrap">
              <div className="flex items-center gap-1.5">
                <span className="text-xs text-[var(--color-muted)]">Harness</span>
                <select
                  value={harness}
                  onChange={(e: any) => setHarness(e.target.value)}
                  className="text-sm bg-[var(--color-background)] border border-[var(--color-border)] rounded px-2 py-1 focus:outline-none focus:border-[var(--color-accent)]"
                >
                  {HARNESSES.map(h => (
                    <option key={h.value} value={h.value}>{h.label}</option>
                  ))}
                </select>
              </div>
              {harness === 'custom' && (
                <input
                  type="text"
                  value={customCmd}
                  onChange={(e: any) => setCustomCmd(e.target.value)}
                  placeholder="command to run..."
                  className="text-sm bg-[var(--color-background)] border border-[var(--color-border)] rounded px-2 py-1 font-mono w-48 focus:outline-none focus:border-[var(--color-accent)]"
                />
              )}
              <div className="flex items-center gap-1.5">
                <span className="text-xs text-[var(--color-muted)]">Target</span>
                <select
                  value={target}
                  onChange={(e: any) => setTarget(e.target.value)}
                  className="text-sm bg-[var(--color-background)] border border-[var(--color-border)] rounded px-2 py-1 focus:outline-none focus:border-[var(--color-accent)]"
                >
                  {targets.map((t: any) => (
                    <option key={t.value} value={t.value}>{t.label}</option>
                  ))}
                </select>
              </div>
              <span className="text-xs text-[var(--color-muted)] ml-auto">
                {data?.originalPath ? 'Ctrl+Enter starts now, Shift+Enter queues' : (target === 'unsandbox' && gitRemoteUrl) ? `Will clone from git remote` : 'No project path — queue only'}
              </span>
            </div>
            <div className="flex items-center justify-end mt-2 gap-2">
              <button onClick={() => addTask(false)} disabled={!newTask.trim() || taskSubmitting}
                className="px-3 py-1.5 text-sm bg-[var(--color-surface-hover)] text-[var(--color-foreground)] rounded-lg hover:bg-[var(--color-border)] transition-colors disabled:opacity-40">
                Queue
              </button>
              <button onClick={() => addTask(true)} disabled={!newTask.trim() || taskSubmitting}
                className="px-4 py-1.5 text-sm font-bold bg-[var(--color-accent)] text-[var(--color-background)] rounded-lg hover:opacity-90 transition-opacity disabled:opacity-40">
                {taskSubmitting ? 'Starting...' : 'Start Now'}
              </button>
            </div>
          </div>

          {/* Open Todos (compact) */}
          <div className="border border-[var(--color-border)] rounded p-4">
            <div className="flex items-center gap-2 mb-3">
              <h3 className="text-sm font-bold text-[var(--color-muted)]">Open Todos</h3>
              {full?.todos?.length > 0 && <span className="text-xs text-[var(--color-muted)]">{full.todos.length}</span>}
              <Link href={`/projects/${project}/kanban`} className="text-xs text-[var(--color-accent)] hover:underline ml-auto">Kanban</Link>
            </div>
            {full?.todos?.length > 0 ? (
              <div className="space-y-1">
                {full.todos.slice(0, 8).map((t: any) => (
                  <div key={t.id} className="flex items-center gap-2 text-sm">
                    <span
                      className={`w-2 h-2 rounded-full shrink-0${t.status === 'in_progress' ? ' animate-pulse' : ''}`}
                      style={{ backgroundColor: t.status === 'pending' ? '#fbbf24' : t.status === 'in_progress' ? '#60a5fa' : '#22c55e' }}
                    />
                    <span className="flex-1 truncate">{t.content}</span>
                    <span className="text-xs text-[var(--color-muted)] shrink-0">{formatRelativeTime(t.updatedAt)}</span>
                  </div>
                ))}
                {full.todos.length > 8 && (
                  <button onClick={() => {}} className="text-xs text-[var(--color-accent)]">+{full.todos.length - 8} more</button>
                )}
              </div>
            ) : (
              <p className="text-sm text-[var(--color-muted)]">No open todos</p>
            )}
          </div>

          {/* Recent Prompts */}
          {full?.prompts?.length > 0 && (
            <div className="border border-[var(--color-border)] rounded p-4">
              <h3 className="text-sm font-bold mb-3 text-[var(--color-muted)]">Recent Prompts</h3>
              <div className="space-y-2">
                {full.prompts.slice(0, 5).map((p: any, i: number) => (
                  <div key={i} className="text-sm border-l-2 border-[var(--color-border)] pl-3">
                    <Link href={`/projects/${project}/${p.sessionUuid}`} className="text-[var(--color-foreground)] hover:text-[var(--color-accent)] transition-colors">
                      {p.text}
                    </Link>
                    <div className="flex gap-2 text-xs text-[var(--color-muted)] mt-1">
                      <span>{formatRelativeTime(p.timestamp)}</span>
                      {p.model && <span className="font-mono">{p.model.replace('claude-', '')}</span>}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Recent Sessions (compact — 5 rows) */}
          <div>
            <div className="flex items-center gap-2 mb-2">
              <h3 className="text-sm font-bold text-[var(--color-muted)]">Recent Sessions</h3>
              <button onClick={() => {}} className="text-xs text-[var(--color-accent)] hover:underline ml-auto">View all</button>
            </div>
            <table className="w-full text-sm">
              <tbody>
                {data.sessions.slice(0, 5).map((session: SessionIndexEntry) => (
                  <tr key={session.sessionId} className="border-b border-[var(--color-border)] hover:bg-[var(--color-surface-hover)]">
                    <td className="py-2 pr-4">
                      <Link href={`/projects/${project}/${session.sessionId}`} className="hover:text-[var(--color-accent)] transition-colors">
                        {session.displayName ?? session.firstPrompt ?? session.sessionId.slice(0, 8)}
                      </Link>
                    </td>
                    <td className="py-2 pr-4 text-[var(--color-muted)] w-20">{session.messageCount ?? '?'} msgs</td>
                    <td className="py-2 text-[var(--color-muted)] w-28">{session.modified ? formatRelativeTime(session.modified) : '-'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>

        {/* Right sidebar */}
        <div className="space-y-4">
          {/* Usage share */}
          {thisActivity && globalTotals.cost > 0 && (
            <div className="border border-[var(--color-border)] rounded p-4 space-y-2">
              <h3 className="text-sm font-bold text-[var(--color-muted)]">30-Day Usage Share</h3>
              <ProgressBar label="Input" value={thisActivity.total_input} max={globalTotals.input}
                detail={`${formatTokens(thisActivity.total_input)} / ${formatTokens(globalTotals.input)}`} />
              <ProgressBar label="Output" value={thisActivity.total_output} max={globalTotals.output}
                detail={`${formatTokens(thisActivity.total_output)} / ${formatTokens(globalTotals.output)}`} />
              <ProgressBar label="Cost" value={thisActivity.cost_estimate} max={globalTotals.cost}
                detail={`$${thisActivity.cost_estimate.toFixed(0)} / $${globalTotals.cost.toFixed(0)}`} />
            </div>
          )}

          {/* Models */}
          {full?.models?.length > 0 && (
            <div className="border border-[var(--color-border)] rounded p-4">
              <h3 className="text-sm font-bold mb-2 text-[var(--color-muted)]">Models</h3>
              <div className="space-y-1">
                {full.models.map((m: any) => (
                  <div key={m.model} className="flex justify-between text-sm">
                    <span className="font-mono truncate">{m.model.replace('claude-', '')}</span>
                    <span className="text-[var(--color-muted)] shrink-0 ml-2">{m.messages} msgs / ${m.cost.toFixed(2)}</span>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Top Tools */}
          {full?.toolUsage?.length > 0 && (
            <div className="border border-[var(--color-border)] rounded p-4">
              <h3 className="text-sm font-bold mb-2 text-[var(--color-muted)]">Top Tools</h3>
              <div className="space-y-1">
                {full.toolUsage.map((t: any) => {
                  const maxCount = full.toolUsage[0]?.count ?? 1;
                  return (
                    <div key={t.tool_name} className="flex items-center gap-2 text-sm">
                      <span className="font-mono w-24 shrink-0 truncate text-xs">{t.tool_name}</span>
                      <div className="flex-1 h-1.5 bg-[var(--color-surface-hover)] rounded overflow-hidden">
                        <div className="h-full bg-[var(--color-accent)] rounded" style={{ width: `${(t.count / maxCount) * 100}%` }} />
                      </div>
                      <span className="text-[var(--color-muted)] w-10 text-right shrink-0 text-xs">{t.count}</span>
                    </div>
                  );
                })}
              </div>
            </div>
          )}

          {/* Recent Commits */}
          {meta?.recentCommits && meta.recentCommits.length > 0 && (
            <div className="border border-[var(--color-border)] rounded p-4">
              <h3 className="text-sm font-bold mb-2 text-[var(--color-muted)]">Recent Commits</h3>
              <div className="space-y-1.5 font-mono text-xs">
                {meta.recentCommits.slice(0, 5).map((c: any) => {
                  const commitLinks = fetchRemotes
                    .map((r: any) => ({ name: r.name, url: commitUrl(r.url, c.hash) }))
                    .filter((l: any) => l.url);
                  return (
                    <div key={c.hash} className="flex gap-2">
                      {commitLinks.length > 0 ? (
                        <a href={commitLinks[0].url!} target="_blank" rel="noopener noreferrer" className="text-[var(--color-accent)] hover:underline shrink-0">
                          {c.hash}
                        </a>
                      ) : (
                        <span className="text-[var(--color-accent)] shrink-0">{c.hash}</span>
                      )}
                      <span className="truncate flex-1">{c.subject}</span>
                    </div>
                  );
                })}
              </div>
            </div>
          )}

          {/* CLAUDE.md */}
          {meta?.claudeMdExists && (
            <div className="border border-[var(--color-border)] rounded p-4">
              <h3 className="text-sm font-bold mb-2 text-[var(--color-muted)]">CLAUDE.md</h3>
              <pre className="text-xs bg-[var(--color-background)] border border-[var(--color-border)] rounded p-3 whitespace-pre-wrap max-h-48 overflow-auto">
                {meta.claudeMd}
                {meta.claudeMd && meta.claudeMd.length >= 500 && <span className="text-[var(--color-muted)]">&hellip;</span>}
              </pre>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

/* ─── SESSIONS TAB ─── */
function SessionsTab({ data, project }: { data: any; project: string }) {
  const [search, setSearch] = useState('');
  const [showAll, setShowAll] = useState(false);

  const filtered = data.sessions.filter((s: SessionIndexEntry) => {
    if (!search) return true;
    const q = search.toLowerCase();
    return (
      (s.displayName ?? '').toLowerCase().includes(q) ||
      (s.firstPrompt ?? '').toLowerCase().includes(q) ||
      (s.gitBranch ?? '').toLowerCase().includes(q) ||
      s.sessionId.toLowerCase().includes(q)
    );
  });

  const visible = showAll ? filtered : filtered.slice(0, 50);

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-3">
        <input
          type="text"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search sessions..."
          className="flex-1 max-w-sm px-3 py-1.5 text-sm rounded border border-[var(--color-border)] bg-[var(--color-surface)] focus:outline-none focus:border-[var(--color-accent)]"
        />
        <span className="text-sm text-[var(--color-muted)]">{filtered.length} sessions</span>
      </div>

      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="text-left text-[var(--color-muted)] border-b border-[var(--color-border)]">
              <th className="pb-2 pr-4">Session</th>
              <th className="pb-2 pr-4 w-20">Msgs</th>
              <th className="pb-2 pr-4 w-28">Branch</th>
              <th className="pb-2 pr-4 w-36">Modified</th>
              <th className="pb-2 w-10"></th>
            </tr>
          </thead>
          <tbody>
            {visible.map((session: SessionIndexEntry) => (
              <tr key={session.sessionId} className="border-b border-[var(--color-border)] hover:bg-[var(--color-surface-hover)]">
                <td className="py-2 pr-4">
                  <Link href={`/projects/${project}/${session.sessionId}`} className="hover:text-[var(--color-accent)] transition-colors">
                    {session.displayName ?? session.firstPrompt ?? session.sessionId.slice(0, 8)}
                  </Link>
                  {session.isSidechain && (
                    <span className="ml-2 text-xs px-1.5 py-0.5 rounded bg-[var(--color-surface-hover)] text-[var(--color-muted)]">sidechain</span>
                  )}
                </td>
                <td className="py-2 pr-4 text-[var(--color-muted)]">{session.messageCount ?? '?'}</td>
                <td className="py-2 pr-4 text-[var(--color-muted)] truncate max-w-28">{session.gitBranch ?? '-'}</td>
                <td className="py-2 pr-4 text-[var(--color-muted)]">
                  {session.modified ? formatRelativeTime(session.modified) : '-'}
                </td>
                <td className="py-2">
                  <SessionPopover
                    sessionId={session.sessionId}
                    project={project}
                    projectPath={data.originalPath}
                    firstPrompt={session.firstPrompt ?? undefined}
                    messageCount={session.messageCount ?? undefined}
                    gitBranch={session.gitBranch ?? undefined}
                  />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {filtered.length > 50 && !showAll && (
        <button onClick={() => setShowAll(true)} className="text-sm text-[var(--color-accent)] hover:underline">
          Show all {filtered.length} sessions
        </button>
      )}
    </div>
  );
}

/* ─── COMMITS TAB ─── */
function CommitsTab({ meta, fetchRemotes, activityData, project }: any) {
  const commits = meta?.recentCommits ?? [];
  const prompts = activityData?.recentPrompts ?? [];

  return (
    <div className="space-y-6">
      {/* Git status badges */}
      {activityData?.git && (
        <div className="flex gap-3 text-sm">
          {activityData.git.isDirty && (
            <span className="px-2 py-1 rounded bg-yellow-400/10 text-yellow-400 font-mono text-xs">uncommitted changes</span>
          )}
          {activityData.git.unpushedCount > 0 && (
            <span className="px-2 py-1 rounded bg-orange-400/10 text-orange-400 font-mono text-xs">{activityData.git.unpushedCount} unpushed</span>
          )}
          {!activityData.git.isDirty && activityData.git.unpushedCount === 0 && (
            <span className="px-2 py-1 rounded bg-green-400/10 text-green-400 font-mono text-xs">clean</span>
          )}
        </div>
      )}

      {/* Commit list */}
      <div className="border border-[var(--color-border)] rounded">
        <div className="px-4 py-2 border-b border-[var(--color-border)] bg-[var(--color-surface)]">
          <h3 className="text-sm font-bold text-[var(--color-muted)]">Commits ({commits.length})</h3>
        </div>
        {commits.length > 0 ? (
          <div className="divide-y divide-[var(--color-border)]">
            {commits.map((c: any) => {
              const commitLinks = fetchRemotes
                .map((r: any) => ({ name: r.name, url: commitUrl(r.url, c.hash) }))
                .filter((l: any) => l.url);
              // Find matching prompt
              const matchedPrompt = prompts.find((p: any) => p.commitHash === c.hash);
              return (
                <div key={c.hash} className="px-4 py-3 hover:bg-[var(--color-surface-hover)]">
                  <div className="flex items-start gap-3">
                    <div className="flex-1 min-w-0">
                      <p className="text-sm font-medium">{c.subject}</p>
                      {matchedPrompt && (
                        <div className="mt-1 text-xs text-[var(--color-muted)] border-l-2 border-[var(--color-accent)] pl-2">
                          <Link href={`/projects/${project}/${matchedPrompt.sessionId}`} className="hover:text-[var(--color-accent)]">
                            Prompt: {matchedPrompt.prompt}
                          </Link>
                        </div>
                      )}
                    </div>
                    <div className="flex items-center gap-2 shrink-0">
                      {commitLinks.length > 0 ? (
                        <a href={commitLinks[0].url!} target="_blank" rel="noopener noreferrer" className="font-mono text-xs text-[var(--color-accent)] hover:underline">
                          {c.hash}
                        </a>
                      ) : (
                        <span className="font-mono text-xs text-[var(--color-accent)]">{c.hash}</span>
                      )}
                      {c.date && <span className="text-xs text-[var(--color-muted)]">{formatRelativeTime(c.date)}</span>}
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        ) : (
          <p className="px-4 py-8 text-center text-[var(--color-muted)]">No commits found</p>
        )}
      </div>
    </div>
  );
}

/* ─── TODOS TAB ─── */
function TodosTab({ full, project, decodedProject }: any) {
  const todos = full?.todos ?? [];
  const pending = todos.filter((t: any) => t.status === 'pending');
  const inProgress = todos.filter((t: any) => t.status === 'in_progress');
  const completed = todos.filter((t: any) => t.status === 'completed');

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-3">
        <div className="flex gap-2 text-sm">
          <span className="px-2 py-0.5 rounded bg-[var(--color-surface-hover)]">{pending.length} pending</span>
          <span className="px-2 py-0.5 rounded bg-blue-400/10 text-blue-400">{inProgress.length} active</span>
          <span className="px-2 py-0.5 rounded bg-green-400/10 text-green-400">{completed.length} done</span>
        </div>
        <Link href={`/projects/${project}/kanban`} className="text-sm text-[var(--color-accent)] hover:underline ml-auto">
          Open Kanban Board
        </Link>
      </div>

      {/* In Progress */}
      {inProgress.length > 0 && (
        <div className="space-y-2">
          <h3 className="text-sm font-bold text-blue-400">In Progress</h3>
          {inProgress.map((t: any) => (
            <TodoRow key={t.id} todo={t} project={project} />
          ))}
        </div>
      )}

      {/* Pending */}
      {pending.length > 0 && (
        <div className="space-y-2">
          <h3 className="text-sm font-bold text-yellow-400">Pending</h3>
          {pending.map((t: any) => (
            <TodoRow key={t.id} todo={t} project={project} />
          ))}
        </div>
      )}

      {/* Completed */}
      {completed.length > 0 && (
        <div className="space-y-2">
          <h3 className="text-sm font-bold text-green-400">Recently Completed</h3>
          {completed.map((t: any) => (
            <TodoRow key={t.id} todo={t} project={project} completed />
          ))}
        </div>
      )}

      {todos.length === 0 && (
        <p className="text-center text-[var(--color-muted)] py-8">No todos for this project</p>
      )}
    </div>
  );
}

function TodoRow({ todo, project, completed }: { todo: any; project: string; completed?: boolean }) {
  return (
    <div className={`flex items-center gap-3 px-3 py-2 rounded border border-[var(--color-border)] text-sm ${completed ? 'opacity-60' : ''}`}>
      <span
        className={`w-2.5 h-2.5 rounded-full shrink-0 ${todo.status === 'in_progress' ? 'animate-pulse' : ''}`}
        style={{
          backgroundColor: todo.status === 'pending' ? '#fbbf24' : todo.status === 'in_progress' ? '#60a5fa' : '#22c55e',
        }}
      />
      <span className={`flex-1 ${completed ? 'line-through text-[var(--color-muted)]' : ''}`}>{todo.content}</span>
      <span className="text-xs text-[var(--color-muted)] shrink-0">
        {todo.source !== 'claude' && <span className="mr-1.5 px-1 py-0.5 rounded bg-[var(--color-surface-hover)]">{todo.source}</span>}
        {formatRelativeTime(todo.updatedAt)}
      </span>
      {todo.sessionUuid && (
        <Link href={`/projects/${project}/${todo.sessionUuid}`} className="text-xs text-[var(--color-accent)] hover:underline shrink-0">
          session
        </Link>
      )}
    </div>
  );
}

/* ─── ACTIVITY TAB ─── */
function ActivityTab({ activityData, project, decodedProject }: any) {
  const prompts = activityData?.recentPrompts ?? [];

  return (
    <div className="space-y-6">
      <h3 className="text-sm font-bold text-[var(--color-muted)]">Recent Prompt-Commit Activity</h3>

      {prompts.length > 0 ? (
        <div className="space-y-3">
          {prompts.map((p: any, i: number) => (
            <div key={i} className="border border-[var(--color-border)] rounded p-4 hover:bg-[var(--color-surface-hover)]">
              <div className="flex items-start gap-3">
                <div className="flex-1 min-w-0">
                  <Link href={`/projects/${project}/${p.sessionId}`} className="text-sm font-medium hover:text-[var(--color-accent)] transition-colors">
                    {p.prompt}
                  </Link>
                  {p.response && (
                    <p className="text-xs text-[var(--color-muted)] mt-1 line-clamp-2">{p.response.slice(0, 300)}</p>
                  )}
                </div>
                <div className="flex flex-col items-end gap-1 shrink-0">
                  <span className="text-xs text-[var(--color-muted)]">{formatRelativeTime(p.timestamp)}</span>
                  {p.gitStatus && (
                    <span className={`text-xs px-1.5 py-0.5 rounded font-mono ${
                      p.gitStatus === 'committed' ? 'bg-green-400/10 text-green-400' :
                      p.gitStatus === 'uncommitted' ? 'bg-yellow-400/10 text-yellow-400' :
                      p.gitStatus === 'unpushed' ? 'bg-orange-400/10 text-orange-400' :
                      'bg-[var(--color-surface-hover)] text-[var(--color-muted)]'
                    }`}>
                      {p.gitStatus}
                    </span>
                  )}
                </div>
              </div>
              {p.commitHash && (
                <div className="mt-2 flex items-center gap-2 text-xs text-[var(--color-muted)]">
                  <span className="font-mono text-[var(--color-accent)]">{p.commitHash}</span>
                  <span>{p.commitSubject}</span>
                </div>
              )}
            </div>
          ))}
        </div>
      ) : (
        <p className="text-center text-[var(--color-muted)] py-8">No recent activity</p>
      )}
    </div>
  );
}

/* ─── TOKENS TAB ─── */
function TokensTab({ full, thisActivity, globalTotals }: any) {
  const stats = full?.stats;
  const models = full?.models ?? [];

  return (
    <div className="space-y-6">
      {/* Token summary */}
      {stats && (
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
          <StatCard label="Input Tokens" value={formatTokens(stats.totalInput)} />
          <StatCard label="Output Tokens" value={formatTokens(stats.totalOutput)} />
          <StatCard label="Cache Read" value={formatTokens(stats.totalCacheRead)} />
          <StatCard label="Cache Write" value={formatTokens(stats.totalCacheWrite)} />
        </div>
      )}

      {/* Usage share */}
      {thisActivity && globalTotals.cost > 0 && (
        <div className="border border-[var(--color-border)] rounded p-4 space-y-3">
          <h3 className="text-sm font-bold text-[var(--color-muted)]">30-Day Global Share</h3>
          <ProgressBar label="Input" value={thisActivity.total_input} max={globalTotals.input}
            detail={`${formatTokens(thisActivity.total_input)} / ${formatTokens(globalTotals.input)}`} />
          <ProgressBar label="Output" value={thisActivity.total_output} max={globalTotals.output}
            detail={`${formatTokens(thisActivity.total_output)} / ${formatTokens(globalTotals.output)}`} />
          <ProgressBar label="Cost" value={thisActivity.cost_estimate} max={globalTotals.cost}
            detail={`$${thisActivity.cost_estimate.toFixed(2)} / $${globalTotals.cost.toFixed(2)}`} />
        </div>
      )}

      {/* Model breakdown table */}
      {models.length > 0 && (
        <div className="border border-[var(--color-border)] rounded">
          <div className="px-4 py-2 border-b border-[var(--color-border)] bg-[var(--color-surface)]">
            <h3 className="text-sm font-bold text-[var(--color-muted)]">Model Breakdown</h3>
          </div>
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-[var(--color-muted)] border-b border-[var(--color-border)]">
                <th className="px-4 py-2">Model</th>
                <th className="px-4 py-2 text-right">Messages</th>
                <th className="px-4 py-2 text-right">Cost</th>
              </tr>
            </thead>
            <tbody>
              {models.map((m: any) => (
                <tr key={m.model} className="border-b border-[var(--color-border)] hover:bg-[var(--color-surface-hover)]">
                  <td className="px-4 py-2 font-mono text-xs">{m.model}</td>
                  <td className="px-4 py-2 text-right text-[var(--color-muted)]">{m.messages.toLocaleString()}</td>
                  <td className="px-4 py-2 text-right">${m.cost.toFixed(2)}</td>
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr className="font-bold">
                <td className="px-4 py-2">Total</td>
                <td className="px-4 py-2 text-right">{models.reduce((s: number, m: any) => s + m.messages, 0).toLocaleString()}</td>
                <td className="px-4 py-2 text-right">${stats?.totalCost?.toFixed(2) ?? '0.00'}</td>
              </tr>
            </tfoot>
          </table>
        </div>
      )}

      {/* Tool usage */}
      {full?.toolUsage?.length > 0 && (
        <div className="border border-[var(--color-border)] rounded p-4">
          <h3 className="text-sm font-bold mb-3 text-[var(--color-muted)]">Tool Usage</h3>
          <div className="space-y-2">
            {full.toolUsage.map((t: any) => {
              const maxCount = full.toolUsage[0]?.count ?? 1;
              return (
                <div key={t.tool_name} className="flex items-center gap-3 text-sm">
                  <span className="font-mono w-32 shrink-0 truncate">{t.tool_name}</span>
                  <div className="flex-1 h-2 bg-[var(--color-surface-hover)] rounded overflow-hidden">
                    <div className="h-full bg-[var(--color-accent)] rounded" style={{ width: `${(t.count / maxCount) * 100}%` }} />
                  </div>
                  <span className="text-[var(--color-muted)] w-14 text-right shrink-0">{t.count}</span>
                </div>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}

/* ─── CODE TAB ─── */
function CodeTab({ gitData, mutateGit, project }: any) {
  const [commitMsg, setCommitMsg] = useState('');
  const [committing, setCommitting] = useState(false);
  const [commitResult, setCommitResult] = useState<string | null>(null);
  const [showDiff, setShowDiff] = useState(false);

  async function handleCommit(addAll: boolean) {
    if (!commitMsg.trim() || committing) return;
    setCommitting(true);
    setCommitResult(null);
    try {
      const res = await fetch(`/api/projects/${project}/git`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: commitMsg.trim(), addAll }),
      });
      const result = await res.json();
      if (result.success) {
        setCommitResult(`Committed: ${result.commit}${result.pushed ? ' (pushed)' : ''}${result.pushError ? ` — push failed: ${result.pushError}` : ''}`);
        setCommitMsg('');
        mutateGit();
      } else {
        setCommitResult(`Error: ${result.error}`);
      }
    } catch (err) {
      setCommitResult(`Error: ${String(err)}`);
    }
    setCommitting(false);
  }

  async function handlePush() {
    setCommitting(true);
    setCommitResult(null);
    try {
      const res = await fetch(`/api/projects/${project}/git`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'push' }),
      });
      const result = await res.json();
      setCommitResult(result.success ? 'Pushed successfully' : `Error: ${result.error}`);
      mutateGit();
    } catch (err) {
      setCommitResult(`Error: ${String(err)}`);
    }
    setCommitting(false);
  }

  if (!gitData) return <p className="text-[var(--color-muted)]">Loading git status...</p>;
  if (gitData.error) return <p className="text-[var(--color-error)]">{gitData.error}</p>;

  const STATUS_LABELS: Record<string, { label: string; color: string }> = {
    'M': { label: 'Modified', color: '#fbbf24' },
    'A': { label: 'Added', color: '#22c55e' },
    'D': { label: 'Deleted', color: '#ef4444' },
    '??': { label: 'Untracked', color: '#8b5cf6' },
    'R': { label: 'Renamed', color: '#60a5fa' },
    'MM': { label: 'Modified', color: '#fbbf24' },
    'AM': { label: 'Added+Modified', color: '#22c55e' },
  };

  return (
    <div className="space-y-6">
      {/* Branch + status */}
      <div className="flex items-center gap-3 flex-wrap">
        <span className="font-mono text-sm bg-[var(--color-surface-hover)] text-[var(--color-accent)] px-2 py-1 rounded">
          {gitData.branch}
        </span>
        {gitData.isDirty ? (
          <span className="text-xs px-2 py-1 rounded bg-yellow-400/10 text-yellow-400">{gitData.files.length} changed files</span>
        ) : (
          <span className="text-xs px-2 py-1 rounded bg-green-400/10 text-green-400">working tree clean</span>
        )}
        <span className="text-xs text-[var(--color-muted)] font-mono">{gitData.repoPath}</span>
      </div>

      {/* Changed files */}
      {gitData.files.length > 0 && (
        <div className="border border-[var(--color-border)] rounded">
          <div className="px-4 py-2 border-b border-[var(--color-border)] bg-[var(--color-surface)] flex items-center justify-between">
            <h3 className="text-sm font-bold text-[var(--color-muted)]">Changed Files</h3>
            <button onClick={() => setShowDiff(!showDiff)} className="text-xs text-[var(--color-accent)] hover:underline">
              {showDiff ? 'Hide diff' : 'Show diff'}
            </button>
          </div>
          <div className="divide-y divide-[var(--color-border)]">
            {gitData.files.map((f: any, i: number) => {
              const s = STATUS_LABELS[f.status] ?? { label: f.status, color: 'var(--color-muted)' };
              return (
                <div key={i} className="px-4 py-2 flex items-center gap-3 text-sm font-mono hover:bg-[var(--color-surface-hover)]">
                  <span className="text-xs px-1.5 py-0.5 rounded shrink-0" style={{ backgroundColor: `${s.color}22`, color: s.color }}>
                    {s.label}
                  </span>
                  <span className="truncate">{f.file}</span>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* Diff */}
      {showDiff && gitData.diff && (
        <div className="border border-[var(--color-border)] rounded">
          <div className="px-4 py-2 border-b border-[var(--color-border)] bg-[var(--color-surface)]">
            <h3 className="text-sm font-bold text-[var(--color-muted)]">Diff</h3>
          </div>
          <pre className="text-xs p-4 overflow-auto max-h-[500px] font-mono leading-relaxed">
            {gitData.diff.split('\n').map((line: string, i: number) => {
              let color = 'inherit';
              if (line.startsWith('+') && !line.startsWith('+++')) color = '#22c55e';
              else if (line.startsWith('-') && !line.startsWith('---')) color = '#ef4444';
              else if (line.startsWith('@@')) color = '#60a5fa';
              else if (line.startsWith('diff ') || line.startsWith('index ')) color = 'var(--color-muted)';
              return <div key={i} style={{ color }}>{line || ' '}</div>;
            })}
          </pre>
        </div>
      )}

      {/* Diff stat */}
      {gitData.diffStat && (
        <div className="text-xs font-mono text-[var(--color-muted)] whitespace-pre">{gitData.diffStat}</div>
      )}

      {/* Commit form */}
      {gitData.isDirty && (
        <div className="border border-[var(--color-border)] rounded p-4 bg-[var(--color-surface)] space-y-3">
          <h3 className="text-sm font-bold text-[var(--color-muted)]">Commit</h3>
          <input
            type="text"
            value={commitMsg}
            onChange={(e) => setCommitMsg(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); handleCommit(true); } }}
            placeholder="Commit message..."
            className="w-full px-3 py-2 text-sm rounded border border-[var(--color-border)] bg-[var(--color-background)] focus:outline-none focus:border-[var(--color-accent)]"
          />
          <div className="flex gap-2">
            <button onClick={() => handleCommit(false)} disabled={!commitMsg.trim() || committing}
              className="px-3 py-1.5 text-sm bg-[var(--color-surface-hover)] rounded hover:bg-[var(--color-border)] transition-colors disabled:opacity-40">
              Commit tracked
            </button>
            <button onClick={() => handleCommit(true)} disabled={!commitMsg.trim() || committing}
              className="px-3 py-1.5 text-sm font-bold bg-[var(--color-accent)] text-[var(--color-background)] rounded hover:opacity-90 transition-opacity disabled:opacity-40">
              Commit all
            </button>
          </div>
        </div>
      )}

      {/* Push button */}
      {!gitData.isDirty && gitData.recentCommits && (
        <button onClick={handlePush} disabled={committing}
          className="px-4 py-2 text-sm bg-[var(--color-surface-hover)] rounded hover:bg-[var(--color-border)] transition-colors disabled:opacity-40">
          Push
        </button>
      )}

      {/* Commit result */}
      {commitResult && (
        <p className={`text-sm font-mono ${commitResult.startsWith('Error') ? 'text-[var(--color-error)]' : 'text-[var(--color-accent)]'}`}>
          {commitResult}
        </p>
      )}

      {/* Recent commits (from git log) */}
      {gitData.recentCommits && (
        <div className="border border-[var(--color-border)] rounded p-4">
          <h3 className="text-sm font-bold mb-2 text-[var(--color-muted)]">Recent Commits</h3>
          <pre className="text-xs font-mono text-[var(--color-muted)] whitespace-pre-wrap">{gitData.recentCommits}</pre>
        </div>
      )}
    </div>
  );
}
