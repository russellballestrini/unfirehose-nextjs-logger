'use client';

import { use, useState } from 'react';
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
  const [yolo, setYolo] = useState(false);
  const [booting, setBooting] = useState(false);
  const [bootResult, setBootResult] = useState<string | null>(null);

  const { data, error } = useSWR<{
    project: string;
    originalPath: string;
    sessions: SessionIndexEntry[];
  }>(`/api/projects/${project}/sessions`, fetcher);

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
                <td className="py-2">
                  {data.originalPath && (
                    <button
                      onClick={(e) => { e.preventDefault(); bootSession(session.sessionId); }}
                      disabled={booting}
                      className="text-base text-[var(--color-accent)] hover:underline disabled:opacity-50"
                    >
                      Resume
                    </button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
