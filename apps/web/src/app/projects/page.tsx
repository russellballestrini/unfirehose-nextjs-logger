'use client';

import { useState, useCallback, useEffect, useRef } from 'react';
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

interface GitStatus {
  dirty: number;
  unpushed: number;
  branch: string;
}

interface RepoGitDetail {
  files: { status: string; file: string }[];
  diff: string;
  branch: string;
  repoPath: string;
  recentCommits: string;
}

interface DirtyCache {
  details: Record<string, RepoGitDetail | null>;
  expanded: Record<string, boolean>;
  gitSnap: string; // JSON of gitStatuses — bust cache when this changes
}

export default function ProjectsPage() {
  const [range, setRange] = useTimeRange('projects_range', '28d');
  const rangeDays = Math.max(1, Math.ceil((getTimeRangeMinutes(range) || 60 * 24 * 365) / 60 / 24));
  const [search, setSearch] = useState('');
  const [tab, setTab] = useState<'projects' | 'dirty'>('projects');
  const dirtyCache = useRef<DirtyCache>({ details: {}, expanded: {}, gitSnap: '' });

  const { data: projects, error } = useSWR<ProjectInfo[]>(
    '/api/projects',
    fetcher,
    { keepPreviousData: true }
  );
  const { data: activity } = useSWR<ProjectActivity[]>(
    `/api/projects/activity?days=${rangeDays}`,
    fetcher,
    { keepPreviousData: true, refreshInterval: 10000 }
  );
  const { data: gitStatuses, mutate: mutateGit } = useSWR<Record<string, GitStatus>>(
    '/api/projects/git-status',
    fetcher,
    { revalidateOnFocus: false, refreshInterval: 30000, keepPreviousData: true }
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
    ? sortedProjects.filter((p) => p.displayName.toLowerCase().includes(q))
    : sortedProjects;

  const totalSessions = projects.reduce((s, p) => s + p.sessionCount, 0);
  const totalMessages = projects.reduce((s, p) => s + p.totalMessages, 0);
  const totalCost = (activity ?? []).reduce((s, a) => s + (a.cost_estimate ?? 0), 0);

  // Dirty + unpushed repos
  const dirtyProjects = sortedProjects.filter((p) => {
    const gs = gitStatuses?.[p.name];
    return gs && (gs.dirty > 0 || gs.unpushed > 0);
  });
  const dirtyCount = dirtyProjects.length;

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

      {/* Header */}
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

      {/* Tabs */}
      <div className="flex gap-1 border-b border-[var(--color-border)]">
        <button
          onClick={() => setTab('projects')}
          className={`px-4 py-2 text-sm font-medium border-b-2 transition-colors ${tab === 'projects' ? 'border-[var(--color-accent)] text-[var(--color-foreground)]' : 'border-transparent text-[var(--color-muted)] hover:text-[var(--color-foreground)]'}`}
        >
          All Projects
        </button>
        <button
          onClick={() => setTab('dirty')}
          className={`px-4 py-2 text-sm font-medium border-b-2 transition-colors flex items-center gap-2 ${tab === 'dirty' ? 'border-[var(--color-accent)] text-[var(--color-foreground)]' : 'border-transparent text-[var(--color-muted)] hover:text-[var(--color-foreground)]'}`}
        >
          Dynamic Commits
          {dirtyCount > 0 && (
            <span className="px-1.5 py-0.5 text-xs rounded-full font-bold" style={{ backgroundColor: 'rgba(251,191,36,0.2)', color: '#fbbf24' }}>
              {dirtyCount}
            </span>
          )}
        </button>
      </div>

      {/* Tab content */}
      {tab === 'projects' && (
        <>
          <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-4 gap-3">
            {filteredProjects.map((project, idx) => (
              <ProjectCard
                key={project.name}
                project={project}
                activity={activityMap.get(project.name)}
                rangeDays={rangeDays}
                gitStatus={gitStatuses?.[project.name]}
                heat={1 - idx / Math.max(filteredProjects.length, 1)}
              />
            ))}
          </div>
          {filteredProjects.length === 0 && q && (
            <div className="text-center py-12 text-[var(--color-muted)]">
              No projects matching &ldquo;{search}&rdquo;
            </div>
          )}
        </>
      )}

      {tab === 'dirty' && (
        <DirtyReposTab
          projects={dirtyProjects}
          gitStatuses={gitStatuses ?? {}}
          mutateGit={mutateGit}
          cache={dirtyCache}
        />
      )}
    </div>
  );
}

// ─── HEAT COLOR ───
function heatColor(heat: number): string {
  if (heat > 0.85) return '#ef4444';
  if (heat > 0.65) return '#f97316';
  if (heat > 0.45) return '#eab308';
  if (heat > 0.25) return '#22c55e';
  if (heat > 0.10) return '#3b82f6';
  return '#6b7280';
}

// ─── PROJECT CARD ───
function ProjectCard({
  project,
  activity,
  rangeDays,
  gitStatus,
  heat,
}: {
  project: ProjectInfo;
  activity?: ProjectActivity;
  rangeDays: number;
  gitStatus?: GitStatus;
  heat: number;
}) {
  const borderHeat = heatColor(heat);
  return (
    <Link
      href={`/projects/${encodeURIComponent(project.name)}`}
      className="block rounded p-4 transition-all hover:border-[var(--color-accent)]"
      style={{
        background: 'var(--color-surface)',
        border: `1px solid var(--color-border)`,
        borderLeft: `3px solid ${borderHeat}`,
      }}
    >
      <div className="flex items-start justify-between gap-2">
        <div className="font-bold text-base break-words min-w-0">
          {project.displayName}
        </div>
        <div className="flex items-center gap-1.5 shrink-0">
          {gitStatus && gitStatus.dirty > 0 && (
            <span className="text-xs px-1.5 py-0.5 rounded font-bold" style={{ backgroundColor: 'rgba(251,191,36,0.15)', color: '#fbbf24' }}>
              {gitStatus.dirty} dirty
            </span>
          )}
          {gitStatus && gitStatus.unpushed > 0 && (
            <span className="text-xs px-1.5 py-0.5 rounded font-bold" style={{ backgroundColor: 'rgba(96,165,250,0.15)', color: '#60a5fa' }}>
              {gitStatus.unpushed} unpushed
            </span>
          )}
          {gitStatus && gitStatus.dirty === 0 && gitStatus.unpushed === 0 && (
            <span className="text-xs px-1.5 py-0.5 rounded" style={{ backgroundColor: 'rgba(34,197,94,0.15)', color: '#22c55e' }}>
              clean
            </span>
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
        {(activity?.last_activity || project.latestActivity) && (
          <span className="text-base text-[var(--color-muted)]">
            {formatRelativeTime(activity?.last_activity || project.latestActivity)}
          </span>
        )}
      </div>
    </Link>
  );
}

// ─── DYNAMIC COMMITS TAB ───
interface RepoAction {
  status: 'idle' | 'suggesting' | 'committing' | 'pushing' | 'done' | 'error';
  message: string;
  commitMsg: string;
  result: string;
  provider: string;
}

const STATUS_COLORS: Record<string, { label: string; color: string }> = {
  'M': { label: 'M', color: '#fbbf24' },
  'A': { label: 'A', color: '#22c55e' },
  'D': { label: 'D', color: '#ef4444' },
  '??': { label: '?', color: '#8b5cf6' },
  'R': { label: 'R', color: '#60a5fa' },
  'MM': { label: 'M', color: '#fbbf24' },
  'AM': { label: 'A', color: '#22c55e' },
};

function DirtyReposTab({
  projects,
  gitStatuses,
  mutateGit,
  cache,
}: {
  projects: ProjectInfo[];
  gitStatuses: Record<string, GitStatus>;
  mutateGit: () => void;
  cache: React.MutableRefObject<DirtyCache>;
}) {
  // Build a fingerprint from gitStatuses to detect changes
  const gitSnap = JSON.stringify(
    Object.fromEntries(projects.map((p) => [p.name, gitStatuses[p.name]]))
  );
  const stale = gitSnap !== cache.current.gitSnap;

  const [actions, setActions] = useState<Record<string, RepoAction>>({});
  const [batchRunning, setBatchRunning] = useState(false);
  const [expanded, setExpanded] = useState<Record<string, boolean>>(
    stale ? {} : cache.current.expanded
  );
  const [details, setDetails] = useState<Record<string, RepoGitDetail | null>>(
    stale ? {} : cache.current.details
  );

  const [pendingFileAction, setPendingFileAction] = useState<string | null>(null);

  // Auto-clear pending after 3s
  useEffect(() => {
    if (!pendingFileAction) return;
    const t = setTimeout(() => setPendingFileAction(null), 3000);
    return () => clearTimeout(t);
  }, [pendingFileAction]);

  // Persist to cache ref on every change
  useEffect(() => {
    cache.current.details = details;
    cache.current.expanded = expanded;
    cache.current.gitSnap = gitSnap;
  }, [details, expanded, gitSnap, cache]);

  // Delete or gitignore a file — two-click: first sets pending, second executes
  function requestFileAction(projectName: string, file: string, action: 'delete' | 'gitignore') {
    const key = `${projectName}:${file}:${action}`;
    if (pendingFileAction === key) {
      setPendingFileAction(null);
      executeFileAction(projectName, file, action);
    } else {
      setPendingFileAction(key);
    }
  }

  async function executeFileAction(projectName: string, file: string, action: 'delete' | 'gitignore') {
    try {
      const res = await fetch(`/api/projects/${projectName}/git`, {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ file, action }),
      });
      const result = await res.json();
      if (result.success) {
        fetchDetail(projectName);
        mutateGit();
      }
    } catch { /* ignore */ }
  }

  // Fetch git details for a single project
  async function fetchDetail(name: string) {
    try {
      const res = await fetch(`/api/projects/${name}/git`);
      const data = await res.json();
      if (!data.error) {
        setDetails((prev) => ({ ...prev, [name]: data }));
      }
    } catch { /* ignore */ }
  }

  // Auto-expand all on mount (or when cache was busted)
  // Fetch sequentially so top (most recent) repos load first
  useEffect(() => {
    if (projects.length === 0) return;
    if (Object.keys(details).length > 0) return;
    const allExpanded: Record<string, boolean> = {};
    for (const p of projects) allExpanded[p.name] = true;
    setExpanded(allExpanded);
    let cancelled = false;
    (async () => {
      for (const p of projects) {
        if (cancelled) break;
        await fetchDetail(p.name);
      }
    })();
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projects.length]);

  // Toggle expand + lazy-fetch git details
  async function toggleExpand(project: ProjectInfo) {
    const name = project.name;
    const isOpen = expanded[name];
    setExpanded((prev) => ({ ...prev, [name]: !isOpen }));
    if (!isOpen && !details[name]) {
      fetchDetail(name);
    }
  }

  // Expand/collapse all
  function expandAll() {
    const allExpanded: Record<string, boolean> = {};
    for (const p of projects) {
      allExpanded[p.name] = true;
      if (!details[p.name]) fetchDetail(p.name);
    }
    setExpanded(allExpanded);
  }
  function collapseAll() {
    setExpanded({});
  }
  const allExpanded = projects.length > 0 && projects.every((p) => expanded[p.name]);

  const getAction = useCallback((name: string): RepoAction => {
    return actions[name] ?? { status: 'idle', message: '', commitMsg: '', result: '', provider: '' };
  }, [actions]);

  const updateAction = useCallback((name: string, patch: Partial<RepoAction>) => {
    setActions((prev) => ({ ...prev, [name]: { ...prev[name] ?? { status: 'idle', message: '', commitMsg: '', result: '', provider: '' }, ...patch } }));
  }, []);

  // Generate commit message for one repo
  async function suggestOne(project: ProjectInfo) {
    updateAction(project.name, { status: 'suggesting', result: '' });
    try {
      const res = await fetch(`/api/projects/${project.name}/git/suggest`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
      });
      const data = await res.json();
      if (data.message) {
        updateAction(project.name, { status: 'idle', commitMsg: data.message, provider: data.provider || '' });
      } else {
        updateAction(project.name, { status: 'error', result: data.error || 'No message returned' });
      }
    } catch (err) {
      updateAction(project.name, { status: 'error', result: String(err) });
    }
  }

  // Commit + push one repo
  async function commitOne(project: ProjectInfo) {
    const action = getAction(project.name);
    const msg = action.commitMsg.trim();
    if (!msg) return;
    updateAction(project.name, { status: 'committing', result: '' });
    try {
      const res = await fetch(`/api/projects/${project.name}/git`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: msg, addAll: true }),
      });
      const data = await res.json();
      if (data.success) {
        const pushInfo = data.pushed ? ' + pushed' : data.pushError ? ` (push failed: ${data.pushError})` : '';
        updateAction(project.name, { status: 'done', result: `${data.commit}${pushInfo}` });
        mutateGit();
      } else {
        updateAction(project.name, { status: 'error', result: data.error || 'Commit failed' });
      }
    } catch (err) {
      updateAction(project.name, { status: 'error', result: String(err) });
    }
  }

  // Push only
  async function pushOne(project: ProjectInfo) {
    updateAction(project.name, { status: 'pushing', result: '' });
    try {
      const res = await fetch(`/api/projects/${project.name}/git`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'push' }),
      });
      const data = await res.json();
      if (data.success) {
        updateAction(project.name, { status: 'done', result: 'Pushed' });
        mutateGit();
      } else {
        updateAction(project.name, { status: 'error', result: data.error || 'Push failed' });
      }
    } catch (err) {
      updateAction(project.name, { status: 'error', result: String(err) });
    }
  }

  // Batch: generate all commit messages
  async function batchSuggest() {
    setBatchRunning(true);
    const dirty = projects.filter((p) => (gitStatuses[p.name]?.dirty ?? 0) > 0);
    for (const p of dirty) {
      await suggestOne(p);
    }
    setBatchRunning(false);
  }

  // Batch: commit all that have messages
  async function batchCommit() {
    setBatchRunning(true);
    for (const p of projects) {
      const a = getAction(p.name);
      if (a.commitMsg.trim() && a.status !== 'done') {
        await commitOne(p);
      }
    }
    setBatchRunning(false);
  }

  // Batch: push all unpushed
  async function batchPush() {
    setBatchRunning(true);
    const unpushed = projects.filter((p) => (gitStatuses[p.name]?.unpushed ?? 0) > 0);
    for (const p of unpushed) {
      await pushOne(p);
    }
    setBatchRunning(false);
  }

  const totalDirty = projects.filter((p) => (gitStatuses[p.name]?.dirty ?? 0) > 0).length;
  const totalUnpushed = projects.filter((p) => (gitStatuses[p.name]?.unpushed ?? 0) > 0).length;
  const totalReady = projects.filter((p) => getAction(p.name).commitMsg.trim() && getAction(p.name).status !== 'done').length;

  if (projects.length === 0) {
    return (
      <div className="text-center py-16 text-[var(--color-muted)]">
        <div className="text-3xl mb-3">✓</div>
        <div className="text-lg font-bold mb-1">All clean</div>
        <div>No dirty or unpushed repos across {projects.length} projects</div>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {/* Batch action bar */}
      <div className="flex items-center gap-3 flex-wrap p-3 rounded border border-[var(--color-border)] bg-[var(--color-surface)]">
        <div className="text-sm text-[var(--color-muted)]">
          <span className="font-bold" style={{ color: '#fbbf24' }}>{totalDirty}</span> dirty
          {' · '}
          <span className="font-bold" style={{ color: '#60a5fa' }}>{totalUnpushed}</span> unpushed
          {totalReady > 0 && <>{' · '}<span className="font-bold" style={{ color: '#22c55e' }}>{totalReady}</span> ready to commit</>}
        </div>
        <div className="ml-auto flex gap-2">
          <button
            onClick={allExpanded ? collapseAll : expandAll}
            className="px-3 py-1.5 text-sm rounded border border-[var(--color-border)] bg-[var(--color-surface-hover)] hover:bg-[var(--color-border)] transition-colors flex items-center gap-1.5"
          >
            <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor" style={{ transform: allExpanded ? 'rotate(90deg)' : 'none', transition: 'transform 0.15s' }}>
              <path d="M6.22 3.22a.75.75 0 0 1 1.06 0l4.25 4.25a.75.75 0 0 1 0 1.06l-4.25 4.25a.751.751 0 0 1-1.042-.018.751.751 0 0 1-.018-1.042L9.94 8 6.22 4.28a.75.75 0 0 1 0-1.06Z" />
            </svg>
            {allExpanded ? 'Collapse All' : 'Expand All'}
          </button>
          <button
            onClick={batchSuggest}
            disabled={batchRunning || totalDirty === 0}
            className="px-3 py-1.5 text-sm rounded border border-[var(--color-border)] bg-[var(--color-surface-hover)] hover:bg-[var(--color-border)] transition-colors disabled:opacity-40 flex items-center gap-1.5"
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M12 2v4m0 12v4M2 12h4m12 0h4m-3.5-6.5L17 7m-10 10l-1.5 1.5M20.5 17.5L19 17M5 7l-1.5-1.5"/></svg>
            Generate All Messages
          </button>
          <button
            onClick={batchCommit}
            disabled={batchRunning || totalReady === 0}
            className="px-3 py-1.5 text-sm font-bold rounded bg-[var(--color-accent)] text-[var(--color-background)] hover:opacity-90 transition-opacity disabled:opacity-40"
          >
            Commit All ({totalReady})
          </button>
          <button
            onClick={batchPush}
            disabled={batchRunning || totalUnpushed === 0}
            className="px-3 py-1.5 text-sm rounded border border-[var(--color-border)] bg-[var(--color-surface-hover)] hover:bg-[var(--color-border)] transition-colors disabled:opacity-40"
          >
            Push All ({totalUnpushed})
          </button>
        </div>
      </div>

      {/* Repo list */}
      <div className="border border-[var(--color-border)] rounded overflow-hidden divide-y divide-[var(--color-border)]">
        {projects.map((project) => {
          const gs = gitStatuses[project.name];
          const action = getAction(project.name);
          const isDirty = (gs?.dirty ?? 0) > 0;
          const isUnpushed = (gs?.unpushed ?? 0) > 0;
          const isExpanded = expanded[project.name] ?? false;
          const detail = details[project.name];

          return (
            <div key={project.name} className="bg-[var(--color-surface)]">
              {/* Header row — clickable to expand */}
              <div className="p-4 hover:bg-[var(--color-surface-hover)] transition-colors">
                <div className="flex items-center gap-3 flex-wrap">
                  {/* Expand toggle */}
                  <button
                    onClick={() => toggleExpand(project)}
                    className="text-[var(--color-muted)] hover:text-[var(--color-foreground)] transition-colors shrink-0"
                    title={isExpanded ? 'Collapse' : 'Expand to see files & diff'}
                  >
                    <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor" style={{ transform: isExpanded ? 'rotate(90deg)' : 'none', transition: 'transform 0.15s' }}>
                      <path d="M6.22 3.22a.75.75 0 0 1 1.06 0l4.25 4.25a.75.75 0 0 1 0 1.06l-4.25 4.25a.751.751 0 0 1-1.042-.018.751.751 0 0 1-.018-1.042L9.94 8 6.22 4.28a.75.75 0 0 1 0-1.06Z" />
                    </svg>
                  </button>

                  <button
                    onClick={() => toggleExpand(project)}
                    className="font-bold text-sm hover:text-[var(--color-accent)] transition-colors text-left"
                  >
                    {project.displayName}
                  </button>
                  <span className="font-mono text-xs text-[var(--color-muted)]">{gs?.branch}</span>

                  {isDirty && (
                    <span className="text-xs px-1.5 py-0.5 rounded font-bold" style={{ backgroundColor: 'rgba(251,191,36,0.15)', color: '#fbbf24' }}>
                      {gs!.dirty} uncommitted
                    </span>
                  )}
                  {isUnpushed && (
                    <span className="text-xs px-1.5 py-0.5 rounded font-bold" style={{ backgroundColor: 'rgba(96,165,250,0.15)', color: '#60a5fa' }}>
                      {gs!.unpushed} unpushed
                    </span>
                  )}

                  <div className="ml-auto flex items-center gap-2">
                    {isDirty && action.status !== 'done' && (
                      <button
                        onClick={() => suggestOne(project)}
                        disabled={action.status === 'suggesting' || action.status === 'committing'}
                        className="px-2.5 py-1 text-xs rounded border border-[var(--color-border)] hover:border-[var(--color-accent)] transition-colors disabled:opacity-40 flex items-center gap-1"
                        title="Generate commit message"
                      >
                        {action.status === 'suggesting' ? (
                          <span className="animate-spin inline-block w-3 h-3 border-2 border-[var(--color-muted)] border-t-[var(--color-accent)] rounded-full" />
                        ) : (
                          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M12 2v4m0 12v4M2 12h4m12 0h4m-3.5-6.5L17 7m-10 10l-1.5 1.5M20.5 17.5L19 17M5 7l-1.5-1.5"/></svg>
                        )}
                        Generate
                      </button>
                    )}
                    {isDirty && action.status !== 'done' && (
                      <button
                        onClick={() => commitOne(project)}
                        disabled={!action.commitMsg.trim() || action.status === 'committing' || action.status === 'suggesting'}
                        className="px-2.5 py-1 text-xs font-bold rounded bg-[var(--color-accent)] text-[var(--color-background)] hover:opacity-90 transition-opacity disabled:opacity-40"
                      >
                        {action.status === 'committing' ? 'Committing...' : 'Commit + Push'}
                      </button>
                    )}
                    {!isDirty && isUnpushed && action.status !== 'done' && (
                      <button
                        onClick={() => pushOne(project)}
                        disabled={action.status === 'pushing'}
                        className="px-2.5 py-1 text-xs rounded border border-[var(--color-border)] hover:border-[var(--color-accent)] transition-colors disabled:opacity-40"
                      >
                        {action.status === 'pushing' ? 'Pushing...' : 'Push'}
                      </button>
                    )}
                    {action.status === 'done' && (
                      <span className="text-xs font-bold" style={{ color: '#22c55e' }}>✓ Done</span>
                    )}
                  </div>
                </div>

                {/* Commit message input */}
                {isDirty && action.status !== 'done' && (
                  <div className="mt-2 flex gap-2 pl-6">
                    <input
                      type="text"
                      value={action.commitMsg}
                      onChange={(e) => updateAction(project.name, { commitMsg: e.target.value })}
                      onKeyDown={(e) => { if (e.key === 'Enter' && action.commitMsg.trim()) commitOne(project); }}
                      placeholder="Commit message..."
                      className="flex-1 px-3 py-1.5 text-sm rounded border border-[var(--color-border)] bg-[var(--color-background)] focus:outline-none focus:border-[var(--color-accent)] font-mono"
                    />
                  </div>
                )}

                {/* Result */}
                {action.result && (
                  <div className={`mt-2 pl-6 text-xs font-mono ${action.status === 'error' ? 'text-[var(--color-error)]' : 'text-[var(--color-muted)]'}`}>
                    {action.result}
                  </div>
                )}
                {action.provider && action.status !== 'error' && (
                  <div className="mt-1 pl-6 text-xs text-[var(--color-muted)]">via {action.provider}</div>
                )}
              </div>

              {/* Expanded: file list + diff */}
              {isExpanded && (
                <div className="border-t border-[var(--color-border)] bg-[var(--color-background)]">
                  {!detail && (
                    <div className="p-4 text-sm text-[var(--color-muted)]">Loading diff...</div>
                  )}

                  {detail && (
                    <>
                      {/* Changed files */}
                      {detail.files && detail.files.length > 0 && (
                        <div className="border-b border-[var(--color-border)]">
                          <div className="px-4 py-2 text-xs font-bold text-[var(--color-muted)] bg-[var(--color-surface)]">
                            {detail.files.length} changed files
                          </div>
                          {detail.files.map((f: any, i: number) => {
                            const s = STATUS_COLORS[f.status] ?? { label: f.status, color: 'var(--color-muted)' };
                            return (
                              <div key={i} className="px-4 py-1.5 flex items-center gap-3 text-xs font-mono hover:bg-[var(--color-surface-hover)] border-t border-[var(--color-border)]">
                                <span className="w-4 h-4 rounded flex items-center justify-center text-xs font-bold shrink-0" style={{ backgroundColor: `${s.color}22`, color: s.color }}>
                                  {s.label}
                                </span>
                                <span className="truncate flex-1">{f.file}</span>
                                <div className="shrink-0 flex gap-1">
                                  <button
                                    onClick={() => requestFileAction(project.name, f.file, 'gitignore')}
                                    className={`px-1.5 py-0.5 text-xs rounded border transition-colors bg-[var(--color-surface)] ${pendingFileAction === `${project.name}:${f.file}:gitignore` ? 'border-[var(--color-accent)] text-[var(--color-accent)] opacity-100 font-bold' : 'border-[var(--color-border)] hover:border-[var(--color-accent)] hover:text-[var(--color-accent)] opacity-50 hover:opacity-100'}`}
                                    title="Add to .gitignore"
                                  >
                                    {pendingFileAction === `${project.name}:${f.file}:gitignore` ? 'confirm?' : '.gitignore'}
                                  </button>
                                  <button
                                    onClick={() => requestFileAction(project.name, f.file, 'delete')}
                                    className={`px-1.5 py-0.5 text-xs rounded border transition-colors ${pendingFileAction === `${project.name}:${f.file}:delete` ? 'bg-[#ef4444] border-[#ef4444] text-white opacity-100 font-bold' : 'bg-[var(--color-surface)] border-[var(--color-border)] hover:border-[#ef4444] hover:text-[#ef4444] opacity-50 hover:opacity-100'}`}
                                    title="Delete file"
                                  >
                                    {pendingFileAction === `${project.name}:${f.file}:delete` ? 'confirm?' : 'Delete'}
                                  </button>
                                </div>
                              </div>
                            );
                          })}
                        </div>
                      )}

                      {/* Unified diff */}
                      {detail.diff && (
                        <div>
                          <div className="px-4 py-2 text-xs font-bold text-[var(--color-muted)] bg-[var(--color-surface)] border-b border-[var(--color-border)]">
                            Diff
                          </div>
                          <pre className="text-xs p-0 overflow-auto max-h-[500px] font-mono leading-relaxed">
                            {detail.diff.split('\n').map((line: string, i: number) => {
                              let color = 'inherit';
                              let bg = 'transparent';
                              if (line.startsWith('+') && !line.startsWith('+++')) { color = '#22c55e'; bg = 'rgba(34,197,94,0.08)'; }
                              else if (line.startsWith('-') && !line.startsWith('---')) { color = '#ef4444'; bg = 'rgba(239,68,68,0.08)'; }
                              else if (line.startsWith('@@')) { color = '#60a5fa'; bg = 'rgba(96,165,250,0.06)'; }
                              else if (line.startsWith('diff ') || line.startsWith('index ')) color = 'var(--color-muted)';
                              return <div key={i} style={{ color, backgroundColor: bg, paddingLeft: '16px', paddingRight: '16px' }}>{line || ' '}</div>;
                            })}
                          </pre>
                        </div>
                      )}

                      {/* No diff (unpushed only) */}
                      {!detail.diff?.trim() && detail.files?.length === 0 && (
                        <div className="p-4 text-sm text-[var(--color-muted)]">
                          Working tree clean — {gs?.unpushed ?? 0} commits ahead of remote
                        </div>
                      )}

                      {/* Recent commits */}
                      {detail.recentCommits && (
                        <div className="border-t border-[var(--color-border)]">
                          <div className="px-4 py-2 text-xs font-bold text-[var(--color-muted)] bg-[var(--color-surface)]">
                            Recent commits
                          </div>
                          {detail.recentCommits.split('\n').filter(Boolean).map((line: string, i: number) => {
                            const hash = line.slice(0, 7);
                            const msg = line.slice(8);
                            return (
                              <div key={i} className="px-4 py-1.5 flex items-center gap-3 text-xs hover:bg-[var(--color-surface-hover)] border-t border-[var(--color-border)]">
                                <span className="font-mono text-[var(--color-accent)] shrink-0">{hash}</span>
                                <span className="truncate">{msg}</span>
                              </div>
                            );
                          })}
                        </div>
                      )}
                    </>
                  )}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
