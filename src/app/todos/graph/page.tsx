'use client';

import { useState } from 'react';
import useSWR from 'swr';

const fetcher = (url: string) => fetch(url).then(r => r.json());

interface GraphData {
  svg: string;
  nodeCount: number;
  edgeCount: number;
  dot: string;
  error?: string;
  detail?: string;
}

interface ProjectGroup {
  project: string;
  display: string;
}

const STATUS_OPTIONS = [
  { label: 'Active (pending + in progress)', value: 'pending,in_progress' },
  { label: 'All statuses', value: '' },
  { label: 'Pending only', value: 'pending' },
  { label: 'Completed', value: 'completed' },
];

export default function TodoGraphPage() {
  const [project, setProject] = useState('');
  const [status, setStatus] = useState('pending,in_progress');
  const [showDot, setShowDot] = useState(false);

  // Fetch project list from byProject grouping
  const { data: projectData } = useSWR<{ byProject: ProjectGroup[] }>(
    '/api/todos?status=pending,in_progress',
    fetcher
  );

  const projects = projectData?.byProject ?? [];

  // Fetch graph
  const qs = new URLSearchParams();
  if (project) qs.set('project', project);
  if (status) qs.set('status', status);
  const queryString = qs.toString();
  const { data, error, isLoading } = useSWR<GraphData>(
    `/api/todos/graph${queryString ? `?${queryString}` : ''}`,
    fetcher
  );

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between gap-4">
        <h1 className="text-xl font-bold text-[var(--color-foreground)]">
          Todo Dependency Graph
        </h1>
        <div className="flex items-center gap-3">
          <select
            value={status}
            onChange={e => setStatus(e.target.value)}
            className="bg-[var(--color-surface)] border border-[var(--color-border)] rounded px-3 py-1.5 text-base text-[var(--color-foreground)] cursor-pointer"
          >
            {STATUS_OPTIONS.map(o => (
              <option key={o.value} value={o.value}>{o.label}</option>
            ))}
          </select>
          <select
            value={project}
            onChange={e => setProject(e.target.value)}
            className="bg-[var(--color-surface)] border border-[var(--color-border)] rounded px-3 py-1.5 text-base text-[var(--color-foreground)] cursor-pointer"
          >
            <option value="">All projects</option>
            {projects.map(p => (
              <option key={p.project} value={p.project}>
                {p.display}
              </option>
            ))}
          </select>
        </div>
      </div>

      {/* Stats bar */}
      {data && !data.error && (
        <div className="flex gap-4 text-base text-[var(--color-muted)]">
          <span>{data.nodeCount} nodes</span>
          <span>{data.edgeCount} edges</span>
          <button
            onClick={() => setShowDot(!showDot)}
            className="text-[var(--color-accent)] hover:underline cursor-pointer"
          >
            {showDot ? 'Hide' : 'Show'} DOT source
          </button>
        </div>
      )}

      {/* DOT source panel */}
      {showDot && data?.dot && (
        <pre className="p-4 bg-[var(--color-background)] border border-[var(--color-border)] rounded text-sm text-[var(--color-muted)] overflow-x-auto max-h-80 overflow-y-auto">
          {data.dot}
        </pre>
      )}

      {/* Graph */}
      {isLoading && (
        <div className="text-[var(--color-muted)] text-base">Loading graph...</div>
      )}

      {error && (
        <div className="text-red-400 text-base">Failed to load graph</div>
      )}

      {data?.error && (
        <div className="text-red-400 text-base">{data.error}: {data.detail}</div>
      )}

      {data && !data.error && data.edgeCount === 0 && (
        <div className="p-6 border border-[var(--color-border)] rounded bg-[var(--color-surface)] text-center">
          <p className="text-[var(--color-muted)] text-base">
            No dependency edges. Todos with <code className="text-[var(--color-accent)]">blocked_by</code> references will form a graph.
          </p>
          <p className="text-[var(--color-muted)] text-sm mt-2">
            {data.nodeCount} todos shown as isolated nodes.
          </p>
        </div>
      )}

      {data?.svg && !data.error && (
        <div
          className="overflow-auto border border-[var(--color-border)] rounded bg-[var(--color-background)] p-4"
          dangerouslySetInnerHTML={{ __html: data.svg }}
        />
      )}
    </div>
  );
}
