'use client';

import useSWR from 'swr';
import Link from 'next/link';
import type { ProjectInfo } from '@unfirehose/core/types';
import { PageContext } from '@unfirehose/ui/PageContext';
import { formatRelativeTime, formatTokens } from '@unfirehose/core/format';

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
          {totalCost > 0 && <span className="text-[var(--color-accent)]">${totalCost.toFixed(0)} / 30d</span>}
        </div>
      </div>
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3">
        {sortedProjects.map((project) => (
          <ProjectCard
            key={project.name}
            project={project}
            activity={activityMap.get(project.name)}
          />
        ))}
      </div>
    </div>
  );
}

function ProjectCard({
  project,
  activity,
}: {
  project: ProjectInfo;
  activity?: ProjectActivity;
}) {
  return (
    <Link
      href={`/projects/${encodeURIComponent(project.name)}`}
      className="block bg-[var(--color-surface)] rounded border border-[var(--color-border)] p-4 transition-colors hover:border-[var(--color-accent)]"
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
    </Link>
  );
}
