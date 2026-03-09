'use client';

import { useState } from 'react';
import useSWR from 'swr';
import Link from 'next/link';
import type { ProjectInfo } from '@unturf/unfirehose/types';
import { PageContext } from '@unturf/unfirehose-ui/PageContext';
import { TimeRangeSelect, useTimeRange, getTimeRangeMinutes } from '@unturf/unfirehose-ui/TimeRangeSelect';
import { formatRelativeTime, formatTokens } from '@unturf/unfirehose/format';


const fetcher = (url: string) => fetch(url).then((r) => r.json());

interface ProjectActivity {
  name: string;
  display_name: string;
  session_count: number;
  active_days: number;
  last_activity: string;
  total_input: number;
  total_output: number;
  cost_estimate: number;
}

interface GitStatus {
  dirty: number;
  unpushed: number;
  branch: string;
}

export default function ProjectsPage() {
  const [range, setRange] = useTimeRange('projects_range', '28d');
  const rangeDays = Math.max(1, Math.ceil((getTimeRangeMinutes(range) || 60 * 24 * 365) / 60 / 24));
  const [search, setSearch] = useState('');

  const { data: projects, error } = useSWR<ProjectInfo[]>(
    '/api/projects',
    fetcher
  );
  const { data: activity } = useSWR<ProjectActivity[]>(
    `/api/projects/activity?days=${rangeDays}`,
    fetcher
  );
  const { data: gitStatuses } = useSWR<Record<string, GitStatus>>(
    '/api/projects/git-status',
    fetcher,
    { revalidateOnFocus: false, refreshInterval: 30000 }
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

  const sortedProjects = [...projects].sort((a, b) => {
    const aTime = activityMap.get(a.name)?.last_activity || a.latestActivity || '';
    const bTime = activityMap.get(b.name)?.last_activity || b.latestActivity || '';
    return bTime.localeCompare(aTime);
  });

  const q = search.trim().toLowerCase();
  const filteredProjects = q
    ? sortedProjects.filter((p) =>
        p.displayName.toLowerCase().includes(q) || p.name.toLowerCase().includes(q)
      )
    : sortedProjects;

  const totalSessions = projects.reduce((s, p) => s + p.sessionCount, 0);
  const totalMessages = projects.reduce((s, p) => s + p.totalMessages, 0);
  const totalCost = (activity ?? []).reduce((s, a) => s + (a.cost_estimate ?? 0), 0);

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
      <div className="flex items-center gap-4 flex-wrap">
        <h2 className="text-lg font-bold">
          Projects{' '}
          <span className="text-[var(--color-muted)] font-normal">
            ({filteredProjects.length}{q ? ` / ${projects.length}` : ''})
          </span>
        </h2>
        <div className="flex gap-3 text-sm text-[var(--color-muted)]">
          <span>{totalSessions} sessions</span>
          <span>{totalMessages.toLocaleString()} messages</span>
          {totalCost > 0 && <span className="text-[var(--color-accent)]">${totalCost.toFixed(0)} / {rangeDays}d</span>}
        </div>
        <div className="ml-auto flex items-center gap-3">
          <div className="relative">
            <input
              type="text"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search projects..."
              autoComplete="off"
              className="pl-8 pr-8 py-1.5 text-sm rounded border border-[var(--color-border)] bg-[var(--color-surface)] text-[var(--color-foreground)] focus:outline-none focus:border-[var(--color-accent)] w-56"
            />
            <svg className="absolute left-2.5 top-2 w-3.5 h-3.5 text-[var(--color-muted)] pointer-events-none" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
            </svg>
            {search && (
              <button onClick={() => setSearch('')} className="absolute right-2 top-1.5 text-[var(--color-muted)] hover:text-[var(--color-foreground)] text-sm px-1">✕</button>
            )}
          </div>
          <TimeRangeSelect value={range} onChange={setRange} />
        </div>
      </div>
      <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-4 gap-3">
        {filteredProjects.map((project) => (
          <ProjectCard
            key={project.name}
            project={project}
            activity={activityMap.get(project.name)}
            rangeDays={rangeDays}
            gitStatus={gitStatuses?.[project.name]}
          />
        ))}
      </div>
      {filteredProjects.length === 0 && q && (
        <div className="text-center py-12 text-[var(--color-muted)]">
          No projects matching &ldquo;{search}&rdquo;
        </div>
      )}
    </div>
  );
}

function ProjectCard({
  project,
  activity,
  rangeDays,
  gitStatus,
}: {
  project: ProjectInfo;
  activity?: ProjectActivity;
  rangeDays: number;
  gitStatus?: GitStatus;
}) {
  const isActive = project.latestActivity
    ? (Date.now() - new Date(project.latestActivity).getTime() < 1000 * 60 * 60) // eslint-disable-line react-hooks/purity
    : false;

  return (
    <Link
      href={`/projects/${encodeURIComponent(project.name)}`}
      className="block rounded border p-4 transition-colors hover:border-[var(--color-accent)]"
      style={{
        background: isActive
          ? 'color-mix(in srgb, var(--color-accent) 8%, var(--color-surface))'
          : 'var(--color-surface)',
        borderColor: isActive ? 'var(--color-accent)' : 'var(--color-border)',
      }}
    >
      <div className="flex items-start justify-between gap-2">
        <div className="font-bold text-base break-words min-w-0">
          {project.displayName}
        </div>
        <div className="flex items-center gap-1.5 shrink-0">
          {gitStatus && gitStatus.dirty > 0 && (
            <span
              className="text-xs px-1.5 py-0.5 rounded font-bold"
              style={{ backgroundColor: 'rgba(251,191,36,0.15)', color: '#fbbf24' }}
              title={`${gitStatus.dirty} uncommitted changes`}
            >
              {gitStatus.dirty} dirty
            </span>
          )}
          {gitStatus && gitStatus.unpushed > 0 && (
            <span
              className="text-xs px-1.5 py-0.5 rounded font-bold"
              style={{ backgroundColor: 'rgba(96,165,250,0.15)', color: '#60a5fa' }}
              title={`${gitStatus.unpushed} unpushed commits`}
            >
              {gitStatus.unpushed} unpushed
            </span>
          )}
          {gitStatus && gitStatus.dirty === 0 && gitStatus.unpushed === 0 && (
            <span
              className="text-xs px-1.5 py-0.5 rounded"
              style={{ backgroundColor: 'rgba(34,197,94,0.15)', color: '#22c55e' }}
              title="Working tree clean, up to date with remote"
            >
              clean
            </span>
          )}
          {project.hasMemory && (
            <span
              className="w-2 h-2 rounded-full bg-[var(--color-accent)]"
              title="Has MEMORY.md"
            />
          )}
          {isActive && (
            <span
              className="w-2 h-2 rounded-full bg-green-400 animate-pulse"
              title="Active in last hour"
            />
          )}
        </div>
      </div>
      <div className="flex flex-wrap gap-x-4 gap-y-1 mt-3 text-base text-[var(--color-muted)]">
        <span>{project.sessionCount} sessions</span>
        <span>{formatTokens(project.totalMessages)} msgs</span>
        {activity && activity.active_days > 0 && (
          <span>{activity.active_days}d active / {rangeDays}d</span>
        )}
      </div>
      <div className="flex items-center justify-between mt-2">
        {activity && activity.cost_estimate > 0 ? (
          <span className="text-base text-[var(--color-accent)] font-bold">
            ${activity.cost_estimate.toFixed(0)}
          </span>
        ) : (
          <span />
        )}
        {project.latestActivity && (
          <span className="text-base text-[var(--color-muted)]">
            {formatRelativeTime(project.latestActivity)}
          </span>
        )}
      </div>
    </Link>
  );
}
