'use client';

import { use, useState } from 'react';
import useSWR from 'swr';
import Link from 'next/link';
import type { SessionIndexEntry, ProjectMetadata } from '@unfirehose/core/types';
import { formatRelativeTime, formatTokens, gitRemoteToWebUrl, commitUrl } from '@unfirehose/core/format';
import { PageContext } from '@unfirehose/ui/PageContext';
import { SessionPopover } from '@unfirehose/ui/SessionPopover';

/* eslint-disable @typescript-eslint/no-explicit-any */

const fetcher = (url: string) => fetch(url).then((r) => r.json());

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
  const [yolo, setYolo] = useState(true);
  const [booting, setBooting] = useState(false);
  const [bootResult, setBootResult] = useState<string | null>(null);
  const [showAllSessions, setShowAllSessions] = useState(false);
  const [newTask, setNewTask] = useState('');
  const [taskSubmitting, setTaskSubmitting] = useState(false);

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

  // Fetch global activity for progress bars
  const { data: globalActivity } = useSWR<any[]>(
    '/api/projects/activity?days=30',
    fetcher
  );

  async function bootSession(sessionId?: string) {
    if (!data?.originalPath) return;
    setBooting(true);
    setBootResult(null);
    try {
      const res = await fetch('/api/boot', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          projectPath: data.originalPath,
          projectName: decodedProject,
          sessionId,
          yolo,
        }),
      });
      const result = await res.json();
      if (result.success) {
        const hostLabel = result.host && result.host !== 'localhost' ? ` [${result.host}]` : '';
        setBootResult(`${result.command}${hostLabel}`);
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
      if (startNow && data?.originalPath) {
        const res = await fetch('/api/boot', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            projectPath: data.originalPath,
            projectName: decodedProject,
            yolo: true,
            prompt: newTask.trim(),
            todoIds: todoResult.id ? [todoResult.id] : undefined,
          }),
        });
        const result = await res.json();
        if (result.success) {
          const hostLabel = result.host && result.host !== 'localhost' ? ` [${result.host}]` : '';
          setBootResult(`${result.command}${hostLabel}`);
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

  const visibleSessions = showAllSessions ? data.sessions : data.sessions.slice(0, 25);
  const fetchRemotes = meta?.remotes?.filter((r: any) => r.type === 'fetch') ?? [];

  return (
    <div className="space-y-6">
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
          <span className="text-[var(--color-border)]">/</span>
          <span className="text-[var(--color-foreground)] font-bold">Overview</span>
          <Link href={`/projects/${project}/kanban`} className="text-[var(--color-muted)] hover:text-[var(--color-accent)] transition-colors">
            Kanban
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
          <p className={`text-sm font-mono mt-1 ${bootResult.startsWith('Error') ? 'text-[var(--color-error)]' : 'text-[var(--color-accent)]'}`}>
            {bootResult}
          </p>
        )}
      </div>

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

      {/* Main two-column layout */}
      <div className="grid grid-cols-1 lg:grid-cols-[1fr_340px] gap-6">
        {/* Left column — actions & activity */}
        <div className="space-y-6 min-w-0">
          {/* Task input */}
          <div className="border-2 border-[var(--color-accent)] rounded-lg p-4 bg-[var(--color-surface)]">
            <textarea
              value={newTask}
              onChange={(e) => setNewTask(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); addTask(true); }
                if (e.key === 'Enter' && e.shiftKey) { e.preventDefault(); addTask(false); }
              }}
              placeholder="What should Claude work on? (Ctrl+Enter to start now, Shift+Enter to queue)"
              rows={3}
              className="w-full px-3 py-2 text-base bg-[var(--color-background)] border border-[var(--color-border)] rounded-lg focus:border-[var(--color-accent)] focus:outline-none focus:ring-1 focus:ring-[var(--color-accent)] resize-y"
              disabled={taskSubmitting}
            />
            <div className="flex items-center justify-between mt-2">
              <span className="text-xs text-[var(--color-muted)]">
                {data?.originalPath ? 'Ctrl+Enter starts now, Shift+Enter queues' : 'No project path — queue only'}
              </span>
              <div className="flex gap-2">
                <button
                  onClick={() => addTask(false)}
                  disabled={!newTask.trim() || taskSubmitting}
                  className="px-3 py-1.5 text-sm bg-[var(--color-surface-hover)] text-[var(--color-foreground)] rounded-lg hover:bg-[var(--color-border)] transition-colors disabled:opacity-40"
                >
                  Queue
                </button>
                <button
                  onClick={() => addTask(true)}
                  disabled={!newTask.trim() || taskSubmitting}
                  className="px-4 py-1.5 text-sm font-bold bg-[var(--color-accent)] text-[var(--color-background)] rounded-lg hover:opacity-90 transition-opacity disabled:opacity-40"
                >
                  {taskSubmitting ? 'Starting...' : 'Start Now'}
                </button>
              </div>
            </div>
          </div>

          {/* Open Todos */}
          <div className="border border-[var(--color-border)] rounded p-4">
            <div className="flex items-center gap-2 mb-3">
              <h3 className="text-sm font-bold text-[var(--color-muted)]">Open Todos</h3>
              {full?.todos?.length > 0 && <span className="text-xs text-[var(--color-muted)]">{full.todos.length}</span>}
              <Link href={`/projects/${project}/kanban`} className="text-xs text-[var(--color-accent)] hover:underline ml-auto">Kanban</Link>
              <Link href="/todos" className="text-xs text-[var(--color-accent)] hover:underline">All todos</Link>
            </div>
            {full?.todos?.length > 0 && (
              <div className="space-y-1">
                {full.todos.map((t: any) => (
                  <div key={t.id} className="flex items-center gap-2 text-sm">
                    <span
                      className={`w-2 h-2 rounded-full shrink-0${t.status === 'in_progress' ? ' animate-pulse' : ''}`}
                      style={{ backgroundColor: t.status === 'pending' ? '#fbbf24' : t.status === 'in_progress' ? '#60a5fa' : '#22c55e' }}
                    />
                    <span className="flex-1 truncate">{t.content}</span>
                    <span className="text-xs text-[var(--color-muted)] shrink-0">
                      {t.source !== 'claude' && <span className="mr-1">[{t.source}]</span>}
                      {formatRelativeTime(t.updatedAt)}
                    </span>
                  </div>
                ))}
              </div>
            )}
          </div>

          {/* Recent Prompts */}
          {full?.prompts?.length > 0 && (
            <div className="border border-[var(--color-border)] rounded p-4">
              <h3 className="text-sm font-bold mb-3 text-[var(--color-muted)]">Recent Prompts</h3>
              <div className="space-y-2">
                {full.prompts.map((p: any, i: number) => (
                  <div key={i} className="text-sm border-l-2 border-[var(--color-border)] pl-3">
                    <Link
                      href={`/projects/${project}/${p.sessionUuid}`}
                      className="text-[var(--color-foreground)] hover:text-[var(--color-accent)] transition-colors"
                    >
                      {p.text}
                    </Link>
                    <div className="flex gap-2 text-xs text-[var(--color-muted)] mt-1">
                      <span>{formatRelativeTime(p.timestamp)}</span>
                      {p.sessionDisplay && <span>{p.sessionDisplay}</span>}
                      {p.model && <span className="font-mono">{p.model.replace('claude-', '')}</span>}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Sessions table */}
          <div>
            <h3 className="text-sm font-bold text-[var(--color-muted)] mb-3">
              Sessions ({data.sessions.length})
            </h3>
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
                  {visibleSessions.map((session) => (
                    <tr
                      key={session.sessionId}
                      className="border-b border-[var(--color-border)] hover:bg-[var(--color-surface-hover)]"
                    >
                      <td className="py-2 pr-4">
                        <Link
                          href={`/projects/${project}/${session.sessionId}`}
                          className="hover:text-[var(--color-accent)] transition-colors"
                        >
                          {session.displayName ?? session.firstPrompt ?? session.sessionId.slice(0, 8)}
                        </Link>
                        {session.isSidechain && (
                          <span className="ml-2 text-xs px-1.5 py-0.5 rounded bg-[var(--color-surface-hover)] text-[var(--color-muted)]">
                            sidechain
                          </span>
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
            {data.sessions.length > 25 && !showAllSessions && (
              <button
                onClick={() => setShowAllSessions(true)}
                className="mt-2 text-sm text-[var(--color-accent)] hover:underline"
              >
                Show all {data.sessions.length} sessions
              </button>
            )}
          </div>
        </div>

        {/* Right column — info sidebar */}
        <div className="space-y-4">
          {/* Usage share (30d) */}
          {thisActivity && globalTotals.cost > 0 && (
            <div className="border border-[var(--color-border)] rounded p-4 space-y-2">
              <h3 className="text-sm font-bold text-[var(--color-muted)]">30-Day Usage Share</h3>
              <ProgressBar
                label="Input"
                value={thisActivity.total_input}
                max={globalTotals.input}
                detail={`${formatTokens(thisActivity.total_input)} / ${formatTokens(globalTotals.input)}`}
              />
              <ProgressBar
                label="Output"
                value={thisActivity.total_output}
                max={globalTotals.output}
                detail={`${formatTokens(thisActivity.total_output)} / ${formatTokens(globalTotals.output)}`}
              />
              <ProgressBar
                label="Cost"
                value={thisActivity.cost_estimate}
                max={globalTotals.cost}
                detail={`$${thisActivity.cost_estimate.toFixed(0)} / $${globalTotals.cost.toFixed(0)}`}
              />
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
                {meta.recentCommits.slice(0, 10).map((c) => {
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
