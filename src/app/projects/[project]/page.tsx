'use client';

import { use } from 'react';
import useSWR from 'swr';
import Link from 'next/link';
import type { SessionIndexEntry } from '@/lib/types';
import { formatRelativeTime } from '@/lib/format';
import { PageContext } from '@/components/PageContext';

const fetcher = (url: string) => fetch(url).then((r) => r.json());

export default function ProjectSessionsPage({
  params,
}: {
  params: Promise<{ project: string }>;
}) {
  const { project } = use(params);
  const decodedProject = decodeURIComponent(project);

  const { data, error } = useSWR<{
    project: string;
    originalPath: string;
    sessions: SessionIndexEntry[];
  }>(`/api/projects/${project}/sessions`, fetcher);

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
        details={data.sessions.slice(0, 20).map((s) => `${s.sessionId.slice(0, 8)}: ${s.firstPrompt ?? 'no prompt'} (${s.messageCount ?? '?'} msgs)`).join('\n')}
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
                    {session.firstPrompt ?? session.sessionId}
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
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
