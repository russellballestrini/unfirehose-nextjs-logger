'use client';

import { useState } from 'react';
import useSWR from 'swr';
import Link from 'next/link';
import type { ProjectInfo, ProjectMetadata } from '@/lib/types';
import { PageContext } from '@/components/PageContext';
import { formatRelativeTime, formatTokens, gitRemoteToWebUrl, commitUrl } from '@/lib/format';

/* eslint-disable @typescript-eslint/no-explicit-any */

const fetcher = (url: string) => fetch(url).then((r) => r.json());

interface ProjectActivity {
  name: string;
  display_name: string;
  user_messages: number;
  assistant_messages: number;
  session_count: number;
  active_days: number;
  last_activity: string;
  total_input: number;
  total_output: number;
  total_cache_read: number;
  total_cache_write: number;
  cost_estimate: number;
}

function ProgressBar({ value, max, label, detail }: { value: number; max: number; label: string; detail: string }) {
  const pct = max > 0 ? (value / max) * 100 : 0;
  return (
    <div className="flex items-center gap-3 text-base">
      <span className="w-14 text-[var(--color-muted)] shrink-0">{label}</span>
      <div className="flex-1 h-3 bg-[var(--color-surface-hover)] rounded overflow-hidden">
        <div
          className="h-full bg-[var(--color-accent)] rounded transition-all"
          style={{ width: `${Math.min(pct, 100)}%` }}
        />
      </div>
      <span className="w-40 text-right text-[var(--color-muted)] shrink-0">
        {pct.toFixed(1)}% &nbsp; ({detail})
      </span>
    </div>
  );
}

function DetailPanel({
  project,
  activity,
  totals,
  onClose,
}: {
  project: ProjectInfo;
  activity?: ProjectActivity;
  totals: { input: number; output: number; cost: number };
  onClose: () => void;
}) {
  const { data: meta } = useSWR<ProjectMetadata>(
    `/api/projects/metadata?project=${encodeURIComponent(project.name)}`,
    fetcher
  );
  const { data: activityDetail } = useSWR<{ recentPrompts: { prompt: string; timestamp: string; sessionId: string; response: string | null }[] }>(
    `/api/projects/activity?project=${encodeURIComponent(project.name)}`,
    fetcher
  );

  const a = activity;

  return (
    <div className="col-span-full bg-[var(--color-surface)] border border-[var(--color-accent)] rounded p-5 space-y-5">
      {/* A. Header */}
      <div className="flex items-start justify-between">
        <div>
          <h3 className="text-base font-bold">{project.displayName}</h3>
          {meta?.repoPath && (
            <div className="text-base text-[var(--color-muted)] mt-0.5 font-mono">{meta.repoPath}</div>
          )}
        </div>
        <div className="flex items-center gap-3">
          <Link
            href={`/projects/${encodeURIComponent(project.name)}`}
            className="text-base text-[var(--color-accent)] hover:underline"
          >
            View sessions &rarr;
          </Link>
          <button
            onClick={onClose}
            className="text-[var(--color-muted)] hover:text-[var(--color-foreground)] text-lg leading-none px-1"
          >
            &times;
          </button>
        </div>
      </div>

      {/* B. Usage Progress Bars */}
      {a && (
        <div className="space-y-2">
          <div className="text-base font-bold text-[var(--color-muted)] uppercase tracking-wide">Usage (30d share)</div>
          <ProgressBar
            label="Input"
            value={a.total_input}
            max={totals.input}
            detail={`${formatTokens(a.total_input)} / ${formatTokens(totals.input)}`}
          />
          <ProgressBar
            label="Output"
            value={a.total_output}
            max={totals.output}
            detail={`${formatTokens(a.total_output)} / ${formatTokens(totals.output)}`}
          />
          <ProgressBar
            label="Cost"
            value={a.cost_estimate}
            max={totals.cost}
            detail={`$${a.cost_estimate.toFixed(0)} / $${totals.cost.toFixed(0)}`}
          />
        </div>
      )}

      {/* C. Git Info */}
      {meta && (meta.branch || meta.remotes.length > 0 || meta.recentCommits.length > 0) && (
        <div className="space-y-2">
          <div className="text-base font-bold text-[var(--color-muted)] uppercase tracking-wide">Git</div>
          {meta.branch && (
            <span className="inline-block text-base bg-[var(--color-surface-hover)] text-[var(--color-accent)] px-2 py-0.5 rounded font-mono">
              {meta.branch}
            </span>
          )}
          {meta.remotes.filter((r) => r.type === 'fetch').length > 0 && (
            <div className="text-base text-[var(--color-muted)] space-y-0.5">
              {meta.remotes.filter((r) => r.type === 'fetch').map((r) => {
                const webUrl = gitRemoteToWebUrl(r.url);
                return (
                  <div key={`${r.name}-${r.url}`}>
                    <span className="text-[var(--color-foreground)]">{r.name}</span>{' '}
                    {webUrl ? (
                      <a href={webUrl} target="_blank" rel="noopener noreferrer" className="text-[var(--color-accent)] hover:underline">
                        {r.url}
                      </a>
                    ) : (
                      <span className="font-mono">{r.url}</span>
                    )}
                  </div>
                );
              })}
            </div>
          )}
          {meta.recentCommits.length > 0 && (() => {
            const fetchRemotes = meta.remotes.filter((r: any) => r.type === 'fetch');
            return (
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
                      <span className="text-[var(--color-muted)] shrink-0">
                        {c.author}, {formatRelativeTime(c.date)}
                      </span>
                    </div>
                  );
                })}
              </div>
            );
          })()}
        </div>
      )}

      {/* D. CLAUDE.md */}
      <div className="space-y-1">
        <div className="text-base font-bold text-[var(--color-muted)] uppercase tracking-wide">CLAUDE.md</div>
        {meta?.claudeMdExists ? (
          <pre className="text-base bg-[var(--color-background)] border border-[var(--color-border)] rounded p-3 whitespace-pre-wrap max-h-40 overflow-auto">
            {meta.claudeMd}
            {meta.claudeMd && meta.claudeMd.length >= 500 && <span className="text-[var(--color-muted)]">&hellip;</span>}
          </pre>
        ) : (
          <div className="text-base text-[var(--color-muted)] italic">No CLAUDE.md</div>
        )}
      </div>

      {/* E. Recent Prompts */}
      {activityDetail?.recentPrompts && activityDetail.recentPrompts.length > 0 && (
        <div className="space-y-1">
          <div className="text-base font-bold text-[var(--color-muted)] uppercase tracking-wide">Recent Prompts</div>
          <div className="space-y-1 text-base">
            {activityDetail.recentPrompts.map((p, i) => (
              <div key={i} className="group">
                <div className="flex gap-2">
                  <span className="text-[var(--color-muted)] shrink-0">{formatRelativeTime(p.timestamp)}</span>
                  <Link
                    href={`/projects/${encodeURIComponent(project.name)}/${p.sessionId}`}
                    className="break-words hover:text-[var(--color-accent)] transition-colors"
                  >
                    {p.prompt}
                  </Link>
                </div>
                {p.response && (
                  <details className="mt-0.5">
                    <summary className="text-[var(--color-muted)] cursor-pointer hover:text-[var(--color-foreground)] text-base select-none">
                      response
                    </summary>
                    <pre className="mt-1 text-base bg-[var(--color-background)] border border-[var(--color-border)] rounded p-2 whitespace-pre-wrap max-h-48 overflow-auto text-[var(--color-foreground)]">
                      {p.response}
                    </pre>
                  </details>
                )}
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

export default function ProjectsPage() {
  const [expandedProject, setExpandedProject] = useState<string | null>(null);

  const { data: projects, error } = useSWR<ProjectInfo[]>(
    '/api/projects',
    fetcher
  );
  const { data: activity } = useSWR<ProjectActivity[]>(
    '/api/projects/activity?days=30',
    fetcher
  );

  if (error) {
    return (
      <div className="text-[var(--color-error)]">
        Failed to load projects: {String(error)}
      </div>
    );
  }
  if (!projects) {
    return <div className="text-[var(--color-muted)]">Loading projects...</div>;
  }

  const activityMap = new Map(
    (activity ?? []).map((a) => [a.name, a])
  );

  // Sort by most recent activity: prefer DB last_activity, fall back to session index
  const sortedProjects = [...projects].sort((a, b) => {
    const aTime = activityMap.get(a.name)?.last_activity || a.latestActivity || '';
    const bTime = activityMap.get(b.name)?.last_activity || b.latestActivity || '';
    return bTime.localeCompare(aTime);
  });

  const totalSessions = projects.reduce((s, p) => s + p.sessionCount, 0);
  const totalMessages = projects.reduce((s, p) => s + p.totalMessages, 0);

  // Totals for progress bars
  const totals = (activity ?? []).reduce(
    (acc, a) => ({
      input: acc.input + (a.total_input ?? 0),
      output: acc.output + (a.total_output ?? 0),
      cost: acc.cost + (a.cost_estimate ?? 0),
    }),
    { input: 0, output: 0, cost: 0 }
  );

  return (
    <div className="space-y-4">
      <PageContext
        pageType="projects"
        summary={`${projects.length} projects, ${totalSessions} total sessions, ${totalMessages.toLocaleString()} total messages.`}
        metrics={{
          total_projects: projects.length,
          total_sessions: totalSessions,
          total_messages: totalMessages,
          projects_with_memory: projects.filter((p) => p.hasMemory).length,
        }}
        details={sortedProjects.map((p) => `${p.displayName}: ${p.sessionCount} sessions, ${p.totalMessages} messages${p.hasMemory ? ' [has memory]' : ''}`).join('\n')}
      />
      <h2 className="text-lg font-bold">
        Projects{' '}
        <span className="text-[var(--color-muted)] font-normal">
          ({projects.length})
        </span>
      </h2>
      <ProjectGrid
        projects={sortedProjects}
        activityMap={activityMap}
        totals={totals}
        expandedProject={expandedProject}
        setExpandedProject={setExpandedProject}
      />
    </div>
  );
}

function ProjectGrid({
  projects,
  activityMap,
  totals,
  expandedProject,
  setExpandedProject,
}: {
  projects: ProjectInfo[];
  activityMap: Map<string, ProjectActivity>;
  totals: { input: number; output: number; cost: number };
  expandedProject: string | null;
  setExpandedProject: (name: string | null) => void;
}) {
  // Find which index the expanded project is at
  const expandedIdx = expandedProject
    ? projects.findIndex((p) => p.name === expandedProject)
    : -1;

  // Build elements: cards + detail panel inserted after the row of the selected card
  // Grid is 3 cols on lg, 2 on md, 1 on sm. We insert after each "row end".
  // CSS grid with col-span-full handles this naturally if we insert the panel
  // right after the selected card's position (grid auto-flow places it correctly).
  const elements: React.ReactNode[] = [];

  for (let i = 0; i < projects.length; i++) {
    const project = projects[i];
    const isExpanded = expandedProject === project.name;

    elements.push(
      <ProjectCard
        key={project.name}
        project={project}
        activity={activityMap.get(project.name)}
        isExpanded={isExpanded}
        onClick={() => setExpandedProject(isExpanded ? null : project.name)}
      />
    );

    // Insert detail panel after the last card in the selected card's row
    // Row ends at indices: 2, 5, 8, ... (for 3-col). But CSS grid col-span-full
    // naturally breaks to a new row, so we just need to insert it right after
    // the expanded card — the col-span-full forces it onto its own row.
    if (i === expandedIdx) {
      elements.push(
        <DetailPanel
          key={`detail-${expandedProject}`}
          project={project}
          activity={activityMap.get(project.name)}
          totals={totals}
          onClose={() => setExpandedProject(null)}
        />
      );
    }
  }

  return (
    <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3">
      {elements}
    </div>
  );
}

function ProjectCard({
  project,
  activity,
  isExpanded,
  onClick,
}: {
  project: ProjectInfo;
  activity?: ProjectActivity;
  isExpanded: boolean;
  onClick: () => void;
}) {
  return (
    <div
      onClick={onClick}
      className={`cursor-pointer bg-[var(--color-surface)] rounded border p-4 transition-colors ${
        isExpanded
          ? 'border-[var(--color-accent)]'
          : 'border-[var(--color-border)] hover:border-[var(--color-accent)]'
      }`}
    >
      <div className="flex items-start justify-between">
        <div className="font-bold text-base break-words">
          {project.displayName}
        </div>
        {project.hasMemory && (
          <span
            className="w-2 h-2 rounded-full bg-[var(--color-accent)] shrink-0 mt-1"
            title="Has MEMORY.md"
          />
        )}
      </div>
      {project.path && (
        <div className="text-base text-[var(--color-muted)] mt-1 break-all">
          {project.path}
        </div>
      )}
      <div className="flex gap-4 mt-3 text-base text-[var(--color-muted)]">
        <span>{project.sessionCount} sessions</span>
        <span>{formatTokens(project.totalMessages)} msgs</span>
        {project.latestActivity && (
          <span>{formatRelativeTime(project.latestActivity)}</span>
        )}
      </div>
      {activity && (
        <div className="mt-2 text-base text-[var(--color-accent)]">
          ${activity.cost_estimate.toFixed(0)} / 30d
        </div>
      )}
    </div>
  );
}
