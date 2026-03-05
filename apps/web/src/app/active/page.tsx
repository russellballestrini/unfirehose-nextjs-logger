'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { formatRelativeTime, formatTokens } from '@sexy-logger/core/format';
import { PageContext } from '@/components/PageContext';

/* eslint-disable @typescript-eslint/no-explicit-any */

interface ActiveSession {
  id: number;
  sessionUuid: string;
  displayName: string;
  gitBranch: string | null;
  updatedAt: string;
  createdAt: string;
  projectName: string;
  projectDisplay: string;
  projectPath: string;
  messageCount: number;
  recentTokens: number;
  lastModel: string | null;
}

const SESSION_COLORS = [
  '#10b981', '#a78bfa', '#60a5fa', '#f472b6', '#fbbf24',
  '#34d399', '#818cf8', '#38bdf8', '#fb923c', '#a3e635',
  '#e879f9', '#2dd4bf', '#f87171', '#facc15', '#4ade80',
];

export default function ActivePage() {
  const [sessions, setSessions] = useState<ActiveSession[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let interval: ReturnType<typeof setInterval>;

    const fetchActive = async () => {
      try {
        const res = await fetch('/api/active-sessions');
        const data = await res.json();
        setSessions(data.sessions ?? []);
      } catch {
        // silent
      } finally {
        setLoading(false);
      }
    };

    fetchActive();
    interval = setInterval(fetchActive, 5000);
    return () => clearInterval(interval);
  }, []);

  return (
    <div className="p-6 max-w-6xl">
      <PageContext pageType="active-sessions" summary={`Active Sessions. ${sessions.length} active.`} metrics={{ active: sessions.length }} />
      <div className="flex items-center gap-3 mb-6">
        <h1 className="text-xl font-bold">Active Sessions</h1>
        <span className="text-[var(--color-muted)] text-base">
          {sessions.length} active
        </span>
        <span className="w-2 h-2 rounded-full bg-green-500 animate-pulse" />
      </div>

      {loading ? (
        <p className="text-[var(--color-muted)]">Loading...</p>
      ) : sessions.length === 0 ? (
        <div className="border border-[var(--color-border)] rounded p-8 text-center">
          <p className="text-[var(--color-muted)] text-lg mb-2">No active sessions</p>
          <p className="text-[var(--color-muted)] text-base">
            Sessions appear here when agents have been active in the last 10 minutes.
          </p>
        </div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
          {sessions.map((session, idx) => (
            <Link
              key={session.sessionUuid}
              href={`/projects/${encodeURIComponent(session.projectName)}/${session.sessionUuid}`}
              className="block border border-[var(--color-border)] rounded p-4 hover:border-[var(--color-accent)] transition-colors"
            >
              <div className="flex items-start gap-3 mb-3">
                <span
                  className="w-3 h-3 rounded-full mt-1 shrink-0 animate-pulse"
                  style={{ backgroundColor: SESSION_COLORS[idx % SESSION_COLORS.length] }}
                />
                <div className="min-w-0 flex-1">
                  <h3 className="font-medium text-base truncate" title={session.displayName}>
                    {session.displayName}
                  </h3>
                  <p className="text-[var(--color-muted)] text-sm truncate">
                    {session.projectDisplay}
                  </p>
                </div>
              </div>

              <div className="grid grid-cols-2 gap-2 text-sm text-[var(--color-muted)]">
                {session.gitBranch && (
                  <div className="truncate" title={session.gitBranch}>
                    <span className="text-[var(--color-accent)]">@</span> {session.gitBranch}
                  </div>
                )}
                {session.lastModel && (
                  <div className="truncate">
                    {session.lastModel.replace('claude-', '').replace(/-\d+$/, '')}
                  </div>
                )}
                <div>
                  {session.messageCount} msgs
                </div>
                <div>
                  {formatTokens(session.recentTokens)} recent
                </div>
              </div>

              <div className="mt-3 text-xs text-[var(--color-muted)]">
                Last activity {formatRelativeTime(session.updatedAt)}
              </div>
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}
