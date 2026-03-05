'use client';

import { use, useState } from 'react';
import useSWR from 'swr';
import Link from 'next/link';
import type { SessionIndexEntry, ProjectMetadata } from '@/lib/types';
import { formatRelativeTime, formatTokens, gitRemoteToWebUrl, commitUrl } from '@/lib/format';
import { PageContext } from '@/components/PageContext';
import { SessionPopover } from '@/components/SessionPopover';

const fetcher = (url: string) => fetch(url).then((r) => r.json());

export default function ProjectSessionsPage({
  params,
}: {
  params: Promise<{ project: string }>;
}) {
  const { project } = use(params);
  const decodedProject = decodeURIComponent(project);
  const [yolo, setYolo] = useState(false);
  const [booting, setBooting] = useState(false);
  const [bootResult, setBootResult] = useState<string | null>(null);

  const { data, error } = useSWR<{
    project: string;
    originalPath: string;
    sessions: SessionIndexEntry[];
  }>(`/api/projects/${project}/sessions`, fetcher);

  const { data: meta } = useSWR<ProjectMetadata>(
    `/api/projects/metadata?project=${encodeURIComponent(decodedProject)}`,
    fetcher
  );

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data: full } = useSWR<any>(
    `/api/projects/${project}/full`,
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
        setBootResult(`tmux attach -t ${result.tmuxSession}`);
      } else {
        setBootResult(`Error: ${result.error}${result.detail ? ' — ' + result.detail : ''}`);
      }
    } catch (err) {
      setBootResult(`Error: ${String(err)}`);
    }
    setBooting(false);
  }

  if (error) {
    return (
      <div className="text-[var(--color-error)]">
        Failed to load sessions: {String(error)}
      </div>
    );
  }
  if (!data) {
    return <div className="text-[var(--color-muted)]">Loading sessions...</div>;
  }

  return (
    <div className="space-y-4">
      <PageContext
        pageType="project-sessions"
        summary={`Project: ${decodedProject}. ${data.sessions.length} sessions.${data.originalPath ? ` Path: ${data.originalPath}` : ''}`}
        metrics={{
          project: decodedProject,
          sessions: data.sessions.length,
          path: data.originalPath || '',
        }}
        details={data.sessions.slice(0, 20).map((s: any) => `${s.displayName ?? s.firstPrompt ?? s.sessionId.slice(0, 8)} (${s.messageCount ?? '?'} msgs)`).join('\n')}
      />
      <div>
        <Link
          href="/projects"
          className="text-base text-[var(--color-muted)] hover:text-[var(--color-foreground)]"
        >
          &larr; Projects
        </Link>
        <h2 className="text-lg font-bold mt-1">{decodedProject}</h2>
        {data.originalPath && (
          <p className="text-base text-[var(--color-muted)]">
            {data.originalPath}
          </p>
        )}
      </div>

      {/* Git info */}
      {meta && (meta.remotes.length > 0 || meta.recentCommits.length > 0) && (() => {
        const fetchRemotes = meta.remotes.filter((r: any) => r.type === 'fetch');
        return (
          <div className="space-y-2">
            <div className="flex items-center gap-3 flex-wrap">
              {meta.branch && (
                <span className="inline-block text-base bg-[var(--color-surface-hover)] text-[var(--color-accent)] px-2 py-0.5 rounded font-mono">
                  {meta.branch}
                </span>
              )}
              {fetchRemotes.map((r: any) => {
                const webUrl = gitRemoteToWebUrl(r.url);
                return webUrl ? (
                  <a key={`${r.name}-${r.url}`} href={webUrl} target="_blank" rel="noopener noreferrer" className="text-base text-[var(--color-accent)] hover:underline">
                    {r.name}: {webUrl.replace(/^https?:\/\//, '')}
                  </a>
                ) : (
                  <span key={`${r.name}-${r.url}`} className="text-base font-mono text-[var(--color-muted)]">{r.name}: {r.url}</span>
                );
              })}
            </div>
            {meta.recentCommits.length > 0 && (
              <div className="text-base space-y-1 font-mono">
                {meta.recentCommits.slice(0, 5).map((c) => {
                  const commitLinks = fetchRemotes
                    .map((r: any) => ({ name: r.name, url: commitUrl(r.url, c.hash) }))
                    .filter((l: any) => l.url);
                  return (
                    <div key={c.hash} className="flex gap-2">
                      {commitLinks.length > 0 ? (
                        <span className="shrink-0 flex gap-1">
                          {commitLinks.map((l: any, i: number) => (
                            <a key={l.name} href={l.url} target="_blank" rel="noopener noreferrer" className="text-[var(--color-accent)] hover:underline" title={l.name}>
                              {i === 0 ? c.hash : l.name}
                            </a>
                          ))}
                        </span>
                      ) : (
                        <span className="text-[var(--color-accent)] shrink-0">{c.hash}</span>
                      )}
                      <span className="break-words">{c.subject}</span>
                      <span className="text-[var(--color-muted)] shrink-0">{formatRelativeTime(c.date)}</span>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        );
      })()}

      {/* Boot controls */}
      {data.originalPath && (
        <div className="grid grid-flow-col auto-cols-max gap-4 items-center">
          <button
            onClick={() => bootSession()}
            disabled={booting}
            className="px-3 py-1.5 text-base font-bold bg-[var(--color-accent)] text-[var(--color-background)] rounded hover:opacity-90 transition-opacity disabled:opacity-50"
          >
            {booting ? 'Booting...' : 'Boot New Session'}
          </button>
          <label className="grid grid-flow-col auto-cols-max items-center gap-1.5 text-base text-[var(--color-muted)] cursor-pointer">
            <input
              type="checkbox"
              checked={yolo}
              onChange={(e) => setYolo(e.target.checked)}
              className="accent-[var(--color-error)]"
            />
            Yolo
          </label>
          {bootResult && (
            <span className={`text-base font-mono ${bootResult.startsWith('Error') ? 'text-[var(--color-error)]' : 'text-[var(--color-accent)]'}`}>
              {bootResult}
            </span>
          )}
        </div>
      )}

      {/* Project Stats */}
      {full?.stats && (
        <div className="grid grid-cols-2 md:grid-cols-4 lg:grid-cols-6 gap-3">
          {[
            { label: 'Sessions', value: full.stats.sessionCount },
            { label: 'Messages', value: full.stats.messageCount.toLocaleString() },
            { label: 'Input', value: formatTokens(full.stats.totalInput) },
            { label: 'Output', value: formatTokens(full.stats.totalOutput) },
            { label: 'Active Days', value: full.stats.activeDays },
            { label: 'Equiv Cost', value: `$${full.stats.totalCost.toFixed(2)}` },
          ].map(({ label, value }) => (
            <div key={label} className="border border-[var(--color-border)] rounded p-3 text-center">
              <div className="text-lg font-bold">{value}</div>
              <div className="text-xs text-[var(--color-muted)]">{label}</div>
            </div>
          ))}
        </div>
      )}

      {/* Models + Tools row */}
      {full && (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          {full.models?.length > 0 && (
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
          {full.toolUsage?.length > 0 && (
            <div className="border border-[var(--color-border)] rounded p-4">
              <h3 className="text-sm font-bold mb-2 text-[var(--color-muted)]">Top Tools</h3>
              <div className="space-y-1">
                {full.toolUsage.map((t: any) => (
                  <div key={t.tool_name} className="flex justify-between text-sm">
                    <span className="font-mono">{t.tool_name}</span>
                    <span className="text-[var(--color-muted)]">{t.count}</span>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      )}

      {/* Open Todos */}
      {full?.todos?.length > 0 && (
        <div className="border border-[var(--color-border)] rounded p-4">
          <div className="flex items-center gap-2 mb-3">
            <h3 className="text-sm font-bold text-[var(--color-muted)]">Open Todos</h3>
            <Link href="/todos" className="text-xs text-[var(--color-accent)] hover:underline ml-auto">
              View all
            </Link>
          </div>
          <div className="space-y-1">
            {full.todos.map((t: any) => (
              <div key={t.id} className="flex items-center gap-2 text-sm">
                <span
                  className="w-2 h-2 rounded-full shrink-0"
                  style={{ backgroundColor: t.status === 'in_progress' ? '#fbbf24' : 'var(--color-muted)' }}
                />
                <span className="flex-1 truncate">{t.content}</span>
                <span className="text-xs text-[var(--color-muted)] shrink-0">
                  {t.source !== 'claude' && <span className="mr-1">[{t.source}]</span>}
                  {formatRelativeTime(t.updatedAt)}
                </span>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Recent Prompts */}
      {full?.prompts?.length > 0 && (
        <div className="border border-[var(--color-border)] rounded p-4">
          <h3 className="text-sm font-bold mb-3 text-[var(--color-muted)]">Recent Prompts</h3>
          <div className="space-y-2">
            {full.prompts.map((p: any, i: number) => (
              <div key={i} className="text-sm border-l-2 border-[var(--color-border)] pl-3">
                <p className="text-[var(--color-foreground)]">{p.text}</p>
                <div className="flex gap-2 text-xs text-[var(--color-muted)] mt-1">
                  <span>{formatRelativeTime(p.timestamp)}</span>
                  {p.sessionDisplay && <span>{p.sessionDisplay}</span>}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      <div className="text-base text-[var(--color-muted)]">
        {data.sessions.length} sessions
      </div>

      <div className="overflow-x-auto">
        <table className="w-full text-base">
          <thead>
            <tr className="text-left text-[var(--color-muted)] border-b border-[var(--color-border)]">
              <th className="pb-2 pr-4">First Prompt</th>
              <th className="pb-2 pr-4 w-20">Messages</th>
              <th className="pb-2 pr-4 w-28">Branch</th>
              <th className="pb-2 pr-4 w-36">Modified</th>
              <th className="pb-2 w-20"></th>
            </tr>
          </thead>
          <tbody>
            {data.sessions.map((session) => (
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
                    <span className="ml-2 text-base px-1.5 py-0.5 rounded bg-[var(--color-surface-hover)] text-[var(--color-muted)]">
                      sidechain
                    </span>
                  )}
                </td>
                <td className="py-2 pr-4 text-[var(--color-muted)]">
                  {session.messageCount ?? '?'}
                </td>
                <td className="py-2 pr-4 text-[var(--color-muted)] break-words">
                  {session.gitBranch ?? '-'}
                </td>
                <td className="py-2 pr-4 text-[var(--color-muted)]">
                  {session.modified
                    ? formatRelativeTime(session.modified)
                    : '-'}
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
    </div>
  );
}
