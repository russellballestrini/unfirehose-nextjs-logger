'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { formatRelativeTime } from '@/lib/format';
import { PageContext } from '@/components/PageContext';

/* eslint-disable @typescript-eslint/no-explicit-any */

interface Todo {
  id: number;
  content: string;
  status: string;
  activeForm: string | null;
  source: string;
  externalId: string | null;
  blockedBy: string[];
  sessionUuid: string | null;
  sessionDisplay: string | null;
  createdAt: string;
  updatedAt: string;
  completedAt: string | null;
}

interface ProjectGroup {
  project: string;
  display: string;
  todos: Todo[];
}

interface Counts {
  pending: number;
  inProgress: number;
  completed: number;
  total: number;
}

const STATUS_COLUMNS = [
  { key: 'pending', label: 'Pending', color: 'var(--color-muted)' },
  { key: 'in_progress', label: 'In Progress', color: '#fbbf24' },
  { key: 'completed', label: 'Completed', color: '#10b981' },
] as const;

const SOURCE_BADGE: Record<string, { label: string; color: string }> = {
  claude: { label: 'claude', color: '#a78bfa' },
  fetch: { label: 'fetch', color: '#60a5fa' },
  manual: { label: 'manual', color: '#34d399' },
};

export default function TodosPage() {
  const [byProject, setByProject] = useState<ProjectGroup[]>([]);
  const [counts, setCounts] = useState<Counts>({ pending: 0, inProgress: 0, completed: 0, total: 0 });
  const [filter, setFilter] = useState<string>('active'); // active, all, project:<name>
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    setLoading(true);
    const statusParam = filter === 'active' ? '?status=pending,in_progress' : '';
    fetch(`/api/todos${statusParam}`)
      .then(r => r.json())
      .then(data => {
        if (data.error) throw new Error(data.error);
        setByProject(data.byProject ?? []);
        setCounts(data.counts ?? { pending: 0, inProgress: 0, completed: 0, total: 0 });
      })
      .catch(() => {
        setByProject([]);
        setCounts({ pending: 0, inProgress: 0, completed: 0, total: 0 });
      })
      .finally(() => setLoading(false));
  }, [filter]);

  // Collect all todos into columns
  const columns: Record<string, Todo[]> = { pending: [], in_progress: [], completed: [] };
  for (const group of byProject) {
    for (const todo of group.todos) {
      if (columns[todo.status]) {
        columns[todo.status].push({ ...todo, content: `[${group.display}] ${todo.content}` });
      }
    }
  }

  return (
    <div className="p-6">
      <PageContext
        pageType="todos"
        summary={`Todos. ${counts.total} total, ${counts.pending} pending, ${counts.inProgress} in progress.`}
        metrics={{ pending: counts.pending, in_progress: counts.inProgress, completed: counts.completed, total: counts.total }}
      />
      <div className="flex items-center gap-4 mb-6">
        <h1 className="text-xl font-bold">Todos</h1>
        <div className="flex gap-2 text-sm">
          <span className="px-2 py-0.5 rounded bg-[var(--color-surface-hover)]">
            {counts.pending} pending
          </span>
          <span className="px-2 py-0.5 rounded bg-[var(--color-surface-hover)] text-yellow-400">
            {counts.inProgress} in progress
          </span>
          <span className="px-2 py-0.5 rounded bg-[var(--color-surface-hover)] text-green-400">
            {counts.completed} completed
          </span>
        </div>
        <div className="ml-auto flex gap-2">
          <button
            onClick={() => setFilter('active')}
            className={`px-3 py-1 text-sm rounded border ${filter === 'active' ? 'border-[var(--color-accent)] text-[var(--color-accent)]' : 'border-[var(--color-border)] text-[var(--color-muted)]'}`}
          >
            Active
          </button>
          <button
            onClick={() => setFilter('all')}
            className={`px-3 py-1 text-sm rounded border ${filter === 'all' ? 'border-[var(--color-accent)] text-[var(--color-accent)]' : 'border-[var(--color-border)] text-[var(--color-muted)]'}`}
          >
            All
          </button>
        </div>
      </div>

      {loading ? (
        <p className="text-[var(--color-muted)]">Loading...</p>
      ) : counts.total === 0 ? (
        <div className="border border-[var(--color-border)] rounded p-8 text-center">
          <p className="text-[var(--color-muted)] text-lg mb-2">No todos found</p>
          <p className="text-[var(--color-muted)] text-base">
            Todos are extracted from Claude Code sessions (TodoWrite, TaskCreate/TaskUpdate) during ingestion.
          </p>
        </div>
      ) : (
        <>
          {/* Kanban columns */}
          <div className="grid grid-cols-1 md:grid-cols-3 gap-6 mb-8">
            {STATUS_COLUMNS.map(col => (
              <div key={col.key}>
                <div className="flex items-center gap-2 mb-3 pb-2 border-b border-[var(--color-border)]">
                  <span
                    className="w-2 h-2 rounded-full"
                    style={{ backgroundColor: col.color }}
                  />
                  <h2 className="font-medium">{col.label}</h2>
                  <span className="text-[var(--color-muted)] text-sm ml-auto">
                    {columns[col.key]?.length ?? 0}
                  </span>
                </div>
                <div className="space-y-2 max-h-[70vh] overflow-y-auto">
                  {(columns[col.key] ?? []).map(todo => (
                    <TodoCard key={todo.id} todo={todo} />
                  ))}
                  {(columns[col.key]?.length ?? 0) === 0 && (
                    <p className="text-sm text-[var(--color-muted)] text-center py-4">
                      None
                    </p>
                  )}
                </div>
              </div>
            ))}
          </div>

          {/* By project view */}
          <h2 className="text-lg font-bold mb-4 border-t border-[var(--color-border)] pt-6">
            By Project
          </h2>
          <div className="space-y-4">
            {byProject.map(group => (
              <div
                key={group.project}
                className="border border-[var(--color-border)] rounded p-4"
              >
                <Link
                  href={`/projects/${encodeURIComponent(group.project)}`}
                  className="font-medium hover:text-[var(--color-accent)] transition-colors"
                >
                  {group.display}
                </Link>
                <span className="text-sm text-[var(--color-muted)] ml-2">
                  {group.todos.length} todos
                </span>
                <div className="mt-3 space-y-1">
                  {group.todos.slice(0, 10).map(todo => (
                    <div
                      key={todo.id}
                      className="flex items-center gap-2 text-sm"
                    >
                      <StatusDot status={todo.status} />
                      <span className="flex-1 truncate">{todo.content}</span>
                      <SourceBadge source={todo.source} />
                    </div>
                  ))}
                  {group.todos.length > 10 && (
                    <p className="text-sm text-[var(--color-muted)]">
                      +{group.todos.length - 10} more
                    </p>
                  )}
                </div>
              </div>
            ))}
          </div>
        </>
      )}
    </div>
  );
}

function TodoCard({ todo }: { todo: Todo }) {
  return (
    <div className="border border-[var(--color-border)] rounded p-3 text-sm">
      <p className="mb-2">{todo.content}</p>
      <div className="flex items-center gap-2 text-xs text-[var(--color-muted)]">
        <SourceBadge source={todo.source} />
        {todo.blockedBy.length > 0 && (
          <span className="text-[var(--color-error)]">
            blocked by {todo.blockedBy.join(', ')}
          </span>
        )}
        <span className="ml-auto">{formatRelativeTime(todo.updatedAt)}</span>
      </div>
    </div>
  );
}

function StatusDot({ status }: { status: string }) {
  const colors: Record<string, string> = {
    pending: 'var(--color-muted)',
    in_progress: '#fbbf24',
    completed: '#10b981',
  };
  return (
    <span
      className="w-2 h-2 rounded-full shrink-0"
      style={{ backgroundColor: colors[status] ?? 'var(--color-muted)' }}
    />
  );
}

function SourceBadge({ source }: { source: string }) {
  const badge = SOURCE_BADGE[source] ?? { label: source, color: 'var(--color-muted)' };
  return (
    <span
      className="px-1.5 py-0.5 rounded text-xs font-medium"
      style={{ backgroundColor: `${badge.color}22`, color: badge.color }}
    >
      {badge.label}
    </span>
  );
}
