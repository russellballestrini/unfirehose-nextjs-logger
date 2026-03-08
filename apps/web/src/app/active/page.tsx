'use client';

import Link from 'next/link';
import useSWR from 'swr';
import { formatRelativeTime, formatTokens } from '@unturf/unfirehose/format';
import { PageContext } from '@unturf/unfirehose-ui/PageContext';
import { TimeRangeSelect, useTimeRange, getTimeRangeMinutes } from '@unturf/unfirehose-ui/TimeRangeSelect';

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

const fetcher = (url: string) => fetch(url).then(r => r.json());

function findMatchingTmux(projectName: string, tmuxSessions: string[]): string | undefined {
  const suffix = projectName.split('-').pop() || '';
  return tmuxSessions.find(t => projectName.includes(t) || (suffix.length > 3 && t.includes(suffix)));
}

export default function ActivePage() {
  const [timeRange, setTimeRange] = useTimeRange('active_time_range', '1h');
  const minutes = getTimeRangeMinutes(timeRange) || 60 * 24 * 365 * 10; // 'all' = 10 years

  const { data, isLoading: loading } = useSWR<{ sessions: ActiveSession[] }>(
    `/api/active-sessions?minutes=${minutes}`,
    fetcher,
    { refreshInterval: 5000 },
  );
  const sessions = data?.sessions ?? [];

  const { data: tmuxData } = useSWR<{ sessions: string[] }>(
    '/api/tmux/stream',
    fetcher,
    { refreshInterval: 10000 },
  );
  const tmuxSessions = tmuxData?.sessions ?? [];

  return (
    <div className="p-6 max-w-6xl">
      <PageContext pageType="active-sessions" summary={`Active Sessions. ${sessions.length} active.`} metrics={{ active: sessions.length }} />
      <div className="flex items-center gap-3 mb-6">
        <h1 className="text-xl font-bold">Active Sessions</h1>
        <span className="text-[var(--color-muted)] text-base">
          {sessions.length} active
        </span>
        <span className="w-2 h-2 rounded-full bg-green-500 animate-pulse" />
        <div className="ml-auto">
          <TimeRangeSelect value={timeRange} onChange={setTimeRange} />
        </div>
      </div>

      {loading ? (
        <p className="text-[var(--color-muted)]">Loading...</p>
      ) : sessions.length === 0 ? (
        <div className="border border-[var(--color-border)] rounded p-8 text-center">
          <p className="text-[var(--color-muted)] text-lg mb-2">No active sessions</p>
          <p className="text-[var(--color-muted)] text-base">
            No sessions found in the last {timeRange === 'all' ? 'lifetime' : timeRange}.
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

              <div className="mt-3 flex items-center gap-2 text-xs text-[var(--color-muted)]">
                <span>Last activity {formatRelativeTime(session.updatedAt)}</span>
                {(() => {
                  const tmux = findMatchingTmux(session.projectName, tmuxSessions);
                  return tmux ? (
                    <a
                      href={`/tmux/${encodeURIComponent(tmux)}`}
                      onClick={(e) => e.stopPropagation()}
                      className="px-1.5 py-0.5 font-bold bg-blue-500 text-white rounded hover:opacity-90 ml-auto"
                    >
                      Watch
                    </a>
                  ) : null;
                })()}
              </div>
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}
