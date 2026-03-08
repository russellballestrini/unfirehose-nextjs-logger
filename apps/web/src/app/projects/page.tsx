'use client';

import { useMemo } from 'react';
import useSWR from 'swr';
import Link from 'next/link';
import type { ProjectInfo } from '@unturf/unfirehose/types';
import { PageContext } from '@unturf/unfirehose-ui/PageContext';
import { TimeRangeSelect, useTimeRange, getTimeRangeMinutes } from '@unturf/unfirehose-ui/TimeRangeSelect';
import { formatRelativeTime, formatTokens } from '@unturf/unfirehose/format';

/* eslint-disable @typescript-eslint/no-explicit-any */

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

export default function ProjectsPage() {
  const [range, setRange] = useTimeRange('projects_range', '28d');
  const rangeDays = Math.max(1, Math.ceil((getTimeRangeMinutes(range) || 60 * 24 * 365) / 60 / 24));

  const { data: projects, error } = useSWR<ProjectInfo[]>(
    '/api/projects',
    fetcher
  );
  const { data: activity } = useSWR<ProjectActivity[]>(
    `/api/projects/activity?days=${rangeDays}`,
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

  const sortedProjects = [...projects].sort((a, b) => {
    const aTime = activityMap.get(a.name)?.last_activity || a.latestActivity || '';
    const bTime = activityMap.get(b.name)?.last_activity || b.latestActivity || '';
    return bTime.localeCompare(aTime);
  });

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
      <div className="flex items-center gap-4">
        <h2 className="text-lg font-bold">
          Projects{' '}
          <span className="text-[var(--color-muted)] font-normal">
            ({projects.length})
          </span>
        </h2>
        <div className="flex gap-3 text-sm text-[var(--color-muted)]">
          <span>{totalSessions} sessions</span>
          <span>{totalMessages.toLocaleString()} messages</span>
          {totalCost > 0 && <span className="text-[var(--color-accent)]">${totalCost.toFixed(0)} / {rangeDays}d</span>}
        </div>
        <div className="ml-auto">
          <TimeRangeSelect value={range} onChange={setRange} />
        </div>
      </div>
      <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-4 gap-3">
        {sortedProjects.map((project) => (
          <ProjectCard
            key={project.name}
            project={project}
            activity={activityMap.get(project.name)}
            rangeDays={rangeDays}
          />
        ))}
      </div>
    </div>
  );
}

function ProjectCard({
  project,
  activity,
  rangeDays,
}: {
  project: ProjectInfo;
  activity?: ProjectActivity;
  rangeDays: number;
}) {
  const isActive = useMemo(() => project.latestActivity
    ? Date.now() - new Date(project.latestActivity).getTime() < 1000 * 60 * 60
    : false, [project.latestActivity]);

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
