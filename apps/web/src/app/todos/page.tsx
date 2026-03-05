'use client';

import { useEffect, useState, useCallback, useRef } from 'react';
import Link from 'next/link';
import { formatRelativeTime, formatTimestamp } from '@unfirehose/core/format';
import { PageContext } from '@unfirehose/ui/PageContext';

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
  projectName: string;
  createdAt: string;
  updatedAt: string;
  completedAt: string | null;
  estimatedMinutes: number | null;
}

interface ProjectGroup {
  project: string;
  display: string;
  projectPath: string | null;
  todos: Todo[];
}

interface Counts {
  pending: number;
  inProgress: number;
  completed: number;
  total: number;
}

const TICKET_THRESHOLD = 15;

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

const TIME_PRESETS = [5, 10, 15, 30, 60, 120];

export default function TodosPage() {
  const [byProject, setByProject] = useState<ProjectGroup[]>([]);
  const [counts, setCounts] = useState<Counts>({ pending: 0, inProgress: 0, completed: 0, total: 0 });
  const [filter, setFilter] = useState<string>('active');
  const [loading, setLoading] = useState(true);
  const [view, setView] = useState<'kanban' | 'project'>('kanban');
  const [newTodo, setNewTodo] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [bootResult, setBootResult] = useState<{ key: string; msg: string } | null>(null);
  const [booting, setBooting] = useState<string | null>(null);
  const [megaStatus, setMegaStatus] = useState<any>(null);
  const [megaLoading, setMegaLoading] = useState(false);
  const [megaPanelOpen, setMegaPanelOpen] = useState(false);
  const [autoCull, setAutoCull] = useState(false);
  const [draggedTodo, setDraggedTodo] = useState<Todo | null>(null);
  const [dragOverColumn, setDragOverColumn] = useState<string | null>(null);

  const fetchTodos = useCallback(() => {
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

  useEffect(() => { fetchTodos(); }, [fetchTodos]);

  const updateTodo = useCallback(async (id: number, updates: { estimatedMinutes?: number; status?: string }) => {
    await fetch('/api/todos', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id, ...updates }),
    });
    fetchTodos();
  }, [fetchTodos]);

  const deleteTodo = useCallback(async (id: number) => {
    await fetch('/api/todos', {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id }),
    });
    fetchTodos();
  }, [fetchTodos]);

  const addTodo = useCallback(async (startNow = false) => {
    if (!newTodo.trim() || submitting) return;
    setSubmitting(true);
    try {
      const res = await fetch('/api/todos', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          content: newTodo.trim(),
          source: 'manual',
          status: startNow ? 'in_progress' : 'pending',
        }),
      });
      const todoResult = await res.json();

      if (startNow) {
        const projectGroup = byProject.find(g => g.projectPath);
        if (projectGroup?.projectPath) {
          const bootRes = await fetch('/api/boot', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              projectPath: projectGroup.projectPath,
              yolo: true,
              prompt: newTodo.trim(),
            }),
          });
          const bootData = await bootRes.json();
          if (bootData.success) {
            setBootResult({ key: `todo-${todoResult.id}`, msg: `tmux: ${bootData.tmuxSession}` });
          } else {
            setBootResult({ key: `todo-${todoResult.id}`, msg: `Error: ${bootData.error}` });
          }
        }
      }

      setNewTodo('');
      fetchTodos();
    } catch { /* silent */ }
    setSubmitting(false);
  }, [newTodo, submitting, fetchTodos, byProject]);

  const bootAgent = useCallback(async (projectPath: string, key: string, prompt?: string) => {
    setBooting(key);
    setBootResult(null);
    try {
      const res = await fetch('/api/boot', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ projectPath, yolo: true, prompt }),
      });
      const result = await res.json();
      if (result.success) {
        setBootResult({ key, msg: `tmux: ${result.tmuxSession}` });
      } else {
        setBootResult({ key, msg: `Error: ${result.error}` });
      }
    } catch (err) {
      setBootResult({ key, msg: `Error: ${String(err)}` });
    }
    setBooting(null);
  }, []);

  const megaDeploy = useCallback(async () => {
    setMegaLoading(true);
    setMegaPanelOpen(true);
    try {
      const res = await fetch('/api/boot/mega', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ maxAgents: 10 }),
      });
      const data = await res.json();
      setMegaStatus(data);
    } catch (err) {
      setMegaStatus({ error: String(err) });
    }
    setMegaLoading(false);
  }, []);

  const megaRefresh = useCallback(async () => {
    try {
      const res = await fetch('/api/boot/mega');
      const data = await res.json();
      setMegaStatus(data);
      setMegaPanelOpen(true);
    } catch (err) {
      setMegaStatus({ error: String(err) });
    }
  }, []);

  const megaCull = useCallback(async () => {
    setMegaLoading(true);
    try {
      const res = await fetch('/api/boot/mega', { method: 'DELETE' });
      const data = await res.json();
      setMegaStatus((prev: any) => ({ ...prev, cullResult: data }));
      setTimeout(() => { megaRefresh(); fetchTodos(); }, 500);
    } catch (err) {
      setMegaStatus({ error: String(err) });
    }
    setMegaLoading(false);
  }, [megaRefresh, fetchTodos]);

  useEffect(() => {
    if (!autoCull) return;
    const interval = setInterval(async () => {
      try {
        await fetch('/api/boot/mega', { method: 'DELETE' });
        const res = await fetch('/api/boot/mega');
        const data = await res.json();
        setMegaStatus(data);
        setMegaPanelOpen(true);
        fetchTodos();
        if (data.active === 0) setAutoCull(false);
      } catch { /* silent */ }
    }, 60000);
    return () => clearInterval(interval);
  }, [autoCull, fetchTodos]);

  // Collect all todos into columns
  const columns: Record<string, Todo[]> = { pending: [], in_progress: [], completed: [] };
  for (const group of byProject) {
    for (const todo of group.todos) {
      if (columns[todo.status]) {
        columns[todo.status].push(todo);
      }
    }
  }

  // Drag and drop handlers
  const handleDragStart = useCallback((todo: Todo) => {
    setDraggedTodo(todo);
  }, []);

  const handleDragEnd = useCallback(() => {
    setDraggedTodo(null);
    setDragOverColumn(null);
  }, []);

  const handleDrop = useCallback(async (targetStatus: string) => {
    if (!draggedTodo || draggedTodo.status === targetStatus) {
      setDraggedTodo(null);
      setDragOverColumn(null);
      return;
    }

    const todo = draggedTodo;
    setDraggedTodo(null);
    setDragOverColumn(null);

    // Update status
    await updateTodo(todo.id, { status: targetStatus });

    // If dropping into in_progress, boot an agent
    if (targetStatus === 'in_progress' && todo.status === 'pending') {
      const group = byProject.find(g =>
        g.todos.some(t => t.id === todo.id) && g.projectPath
      );
      if (group?.projectPath) {
        bootAgent(group.projectPath, `todo-${todo.id}`, `Work on this task: ${todo.content}`);
      }
    }
  }, [draggedTodo, updateTodo, byProject, bootAgent]);

  // Stats
  const unestimated = [...(columns.pending ?? []), ...(columns.in_progress ?? [])]
    .filter(t => t.estimatedMinutes === null);
  const totalEstMinutes = [...(columns.pending ?? []), ...(columns.in_progress ?? [])]
    .reduce((s, t) => s + (t.estimatedMinutes ?? 0), 0);

  return (
    <div className="p-6">
      <PageContext
        pageType="todos"
        summary={`Todos. ${counts.total} total, ${counts.pending} pending, ${counts.inProgress} in progress.`}
        metrics={{ pending: counts.pending, in_progress: counts.inProgress, completed: counts.completed, total: counts.total }}
      />
      <div className="flex items-center gap-4 mb-4">
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
            onClick={() => setView('kanban')}
            className={`px-3 py-1 text-sm rounded border ${view === 'kanban' ? 'border-[var(--color-accent)] text-[var(--color-accent)]' : 'border-[var(--color-border)] text-[var(--color-muted)]'}`}
          >
            Kanban
          </button>
          <button
            onClick={() => setView('project')}
            className={`px-3 py-1 text-sm rounded border ${view === 'project' ? 'border-[var(--color-accent)] text-[var(--color-accent)]' : 'border-[var(--color-border)] text-[var(--color-muted)]'}`}
          >
            By Project
          </button>
          <span className="w-px bg-[var(--color-border)]" />
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
          <span className="w-px bg-[var(--color-border)]" />
          <button
            onClick={megaDeploy}
            disabled={megaLoading}
            className="px-3 py-1 text-sm rounded border border-[var(--color-error)] text-[var(--color-error)] hover:bg-[var(--color-error)]/10 disabled:opacity-50 font-bold"
            title="Spawn one agent per project with active todos"
          >
            {megaLoading ? 'Deploying...' : 'Mega Deploy'}
          </button>
          <button
            onClick={megaRefresh}
            className="px-3 py-1 text-sm rounded border border-[var(--color-border)] text-[var(--color-muted)] hover:border-[var(--color-accent)]"
            title="Check status of deployed agents"
          >
            Status
          </button>
          <button
            onClick={megaCull}
            disabled={megaLoading}
            className="px-3 py-1 text-sm rounded border border-[var(--color-border)] text-[var(--color-muted)] hover:border-green-400 hover:text-green-400 disabled:opacity-50"
            title="Kill agents that finished all their todos"
          >
            Cull
          </button>
          <label className="flex items-center gap-1 text-sm text-[var(--color-muted)] cursor-pointer">
            <input
              type="checkbox"
              checked={autoCull}
              onChange={(e) => setAutoCull(e.target.checked)}
              className="accent-green-400"
            />
            Auto
          </label>
        </div>
      </div>

      {/* Mega Deploy Status Panel */}
      {megaPanelOpen && megaStatus && (
        <div className="mb-4 border border-[var(--color-border)] rounded-lg p-4 bg-[var(--color-surface)]">
          <div className="flex items-center gap-3 mb-3">
            <h2 className="font-bold text-sm">Agent Fleet</h2>
            {megaStatus.active != null && (
              <>
                <span className="text-xs px-2 py-0.5 rounded bg-green-400/20 text-green-400">
                  {megaStatus.active} alive
                </span>
                {megaStatus.allDone > 0 && (
                  <span className="text-xs px-2 py-0.5 rounded bg-blue-400/20 text-blue-400">
                    {megaStatus.allDone} done (cullable)
                  </span>
                )}
                {megaStatus.dead > 0 && (
                  <span className="text-xs px-2 py-0.5 rounded bg-[var(--color-error)]/20 text-[var(--color-error)]">
                    {megaStatus.dead} dead
                  </span>
                )}
              </>
            )}
            {megaStatus.launched != null && (
              <span className="text-xs px-2 py-0.5 rounded bg-[var(--color-error)]/20 text-[var(--color-error)]">
                {megaStatus.launched}/{megaStatus.total} launched
              </span>
            )}
            {megaStatus.cullResult && (
              <span className="text-xs text-green-400">
                Culled {megaStatus.cullResult.culled}, dead {megaStatus.cullResult.dead}
              </span>
            )}
            <button
              onClick={() => setMegaPanelOpen(false)}
              className="ml-auto text-[var(--color-muted)] hover:text-[var(--color-foreground)] text-sm cursor-pointer"
            >
              Close
            </button>
          </div>

          {megaStatus.results && (
            <div className="space-y-1 text-sm">
              {megaStatus.results.map((r: any, i: number) => (
                <div key={i} className="flex items-center gap-2">
                  <span className={`w-2 h-2 rounded-full shrink-0 ${
                    r.status === 'launched' ? 'bg-green-400' :
                    r.status === 'skipped' ? 'bg-yellow-400' : 'bg-[var(--color-error)]'
                  }`} />
                  <span className="font-medium">{r.project}</span>
                  <span className="text-[var(--color-muted)]">
                    {r.status === 'launched' ? `${r.tmuxSession} (${r.todoCount} todos)` : r.reason}
                  </span>
                </div>
              ))}
            </div>
          )}

          {megaStatus.deployments && (
            <div className="space-y-1 text-sm">
              {megaStatus.deployments.map((d: any) => (
                <div key={d.id} className="flex items-center gap-2">
                  <span className={`w-2 h-2 rounded-full shrink-0 ${
                    d.allDone ? 'bg-blue-400' : d.alive ? 'bg-green-400' : 'bg-[var(--color-error)]'
                  }`} />
                  <span className="font-medium">{d.project}</span>
                  <span className="font-mono text-xs text-[var(--color-muted)]">{d.tmuxSession}</span>
                  <span className="text-xs">{d.todosCompleted}/{d.todoCount} done</span>
                  {d.allDone && <span className="text-xs text-blue-400">ready to cull</span>}
                  {!d.alive && <span className="text-xs text-[var(--color-error)]">dead</span>}
                  <span className="text-xs text-[var(--color-muted)] ml-auto">
                    {formatRelativeTime(d.startedAt)}
                  </span>
                </div>
              ))}
              {megaStatus.deployments.length === 0 && (
                <p className="text-[var(--color-muted)]">No active deployments</p>
              )}
            </div>
          )}

          {megaStatus.error && (
            <p className="text-[var(--color-error)] text-sm">{megaStatus.error}</p>
          )}
        </div>
      )}

      {/* Add todo */}
      <div className="flex gap-2 mb-4">
        <input
          type="text"
          value={newTodo}
          onChange={e => setNewTodo(e.target.value)}
          onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); addTodo(false); } }}
          placeholder="Add a task..."
          className="flex-1 px-3 py-1.5 text-sm rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] text-[var(--color-foreground)] placeholder:text-[var(--color-muted)] focus:outline-none focus:border-[var(--color-accent)]"
          disabled={submitting}
        />
        <button
          onClick={() => addTodo(false)}
          disabled={submitting || !newTodo.trim()}
          className="px-3 py-1.5 text-sm rounded-lg bg-[var(--color-surface-hover)] text-[var(--color-foreground)] hover:bg-[var(--color-border)] disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
        >
          Queue
        </button>
        <button
          onClick={() => addTodo(true)}
          disabled={submitting || !newTodo.trim()}
          className="px-3 py-1.5 text-sm font-bold rounded-lg bg-[var(--color-accent)] text-[var(--color-background)] hover:opacity-90 disabled:opacity-40 disabled:cursor-not-allowed transition-opacity"
          title="Creates todo and boots Claude in a tmux session"
        >
          {submitting ? '...' : 'Start Now'}
        </button>
      </div>

      {/* Triage summary */}
      {!loading && counts.total > 0 && (
        <div className="flex gap-4 mb-6 text-sm text-[var(--color-muted)]">
          {totalEstMinutes > 0 && (
            <span>~{totalEstMinutes < 60 ? `${totalEstMinutes}m` : `${Math.floor(totalEstMinutes / 60)}h ${totalEstMinutes % 60}m`} remaining</span>
          )}
          {unestimated.length > 0 && (
            <span>{unestimated.length} unestimated</span>
          )}
          {draggedTodo && (
            <span className="text-[var(--color-accent)] font-bold animate-pulse">
              Drop into a column to move &mdash; In Progress boots an agent
            </span>
          )}
        </div>
      )}

      {loading ? (
        <p className="text-[var(--color-muted)]">Loading...</p>
      ) : counts.total === 0 ? (
        <div className="border border-[var(--color-border)] rounded-lg p-8 text-center">
          <p className="text-[var(--color-muted)] text-lg mb-2">No todos found</p>
          <p className="text-[var(--color-muted)] text-base">
            Todos are extracted from Claude Code sessions (TodoWrite, TaskCreate/TaskUpdate) during ingestion.
          </p>
        </div>
      ) : (
        <>
          {view === 'kanban' ? (
          <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
            {STATUS_COLUMNS.map(col => {
              const isOver = dragOverColumn === col.key;
              const canDrop = draggedTodo && draggedTodo.status !== col.key;
              return (
                <div
                  key={col.key}
                  onDragOver={(e) => { e.preventDefault(); setDragOverColumn(col.key); }}
                  onDragLeave={() => setDragOverColumn(null)}
                  onDrop={(e) => { e.preventDefault(); handleDrop(col.key); }}
                  className={`rounded-xl transition-all duration-200 ${
                    isOver && canDrop
                      ? 'bg-[var(--color-accent)]/5 ring-2 ring-[var(--color-accent)]/50 ring-inset'
                      : ''
                  }`}
                >
                  {/* Column header */}
                  <div className="flex items-center gap-2 mb-3 pb-2 border-b-2" style={{ borderBottomColor: col.color }}>
                    <span
                      className="w-2.5 h-2.5 rounded-full"
                      style={{ backgroundColor: col.color }}
                    />
                    <h2 className="font-bold text-sm">{col.label}</h2>
                    <span className="text-xs text-[var(--color-muted)] ml-auto">
                      {columns[col.key]?.length ?? 0}
                    </span>
                  </div>

                  {/* Drop zone indicator */}
                  {isOver && canDrop && (
                    <div className="border-2 border-dashed border-[var(--color-accent)]/50 rounded-lg p-2 mb-2 text-center">
                      <span className="text-xs text-[var(--color-accent)]">
                        {col.key === 'in_progress' ? 'Drop to start agent' : col.key === 'completed' ? 'Drop to complete' : 'Drop to move'}
                      </span>
                    </div>
                  )}

                  {/* Cards */}
                  <div className="space-y-2 min-h-[100px]">
                    {(columns[col.key] ?? []).map(todo => {
                      const group = byProject.find(g => g.project === todo.projectName);
                      return (
                        <KanbanCard
                          key={todo.id}
                          todo={todo}
                          onUpdate={updateTodo}
                          onDelete={deleteTodo}
                          projectPath={group?.projectPath ?? null}
                          onBoot={bootAgent}
                          booting={booting}
                          bootResult={bootResult}
                          onDragStart={handleDragStart}
                          onDragEnd={handleDragEnd}
                          isDragging={draggedTodo?.id === todo.id}
                        />
                      );
                    })}
                    {(columns[col.key]?.length ?? 0) === 0 && (
                      <p className="text-sm text-[var(--color-muted)] text-center py-8 italic">
                        {col.key === 'completed' ? 'Nothing completed yet' : 'Empty'}
                      </p>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
          ) : (
          <div className="space-y-4">
            {byProject.map(group => {
              const groupEst = group.todos
                .filter(t => t.status !== 'completed')
                .reduce((s, t) => s + (t.estimatedMinutes ?? 0), 0);
              return (
                <div key={group.project} className="border border-[var(--color-border)] rounded-lg p-4">
                  <div className="flex items-center gap-2">
                    <Link
                      href={`/projects/${encodeURIComponent(group.project)}`}
                      className="font-medium hover:text-[var(--color-accent)] transition-colors"
                    >
                      {group.display}
                    </Link>
                    <span className="text-sm text-[var(--color-muted)]">{group.todos.length} todos</span>
                    {groupEst > 0 && (
                      <span className="text-sm text-[var(--color-muted)]">
                        ~{groupEst < 60 ? `${groupEst}m` : `${Math.floor(groupEst / 60)}h ${groupEst % 60}m`}
                      </span>
                    )}
                    {group.projectPath && (
                      <div className="ml-auto flex items-center gap-2">
                        <button
                          onClick={() => {
                            const activeTodos = group.todos
                              .filter(t => t.status !== 'completed')
                              .slice(0, 10)
                              .map(t => `- ${t.content}`)
                              .join('\n');
                            const prompt = `Work on the pending todos for this project:\n${activeTodos}`;
                            bootAgent(group.projectPath!, `project-${group.project}`, prompt);
                          }}
                          disabled={booting === `project-${group.project}`}
                          className="px-2 py-1 text-xs font-bold bg-[var(--color-error)] text-white rounded-lg hover:opacity-90 disabled:opacity-50"
                          title="Spawn claude --dangerously-skip-permissions in tmux"
                        >
                          {booting === `project-${group.project}` ? 'Deploying...' : 'Deploy Agent'}
                        </button>
                        {bootResult?.key === `project-${group.project}` && (
                          <span className={`text-xs font-mono ${bootResult.msg.startsWith('Error') ? 'text-[var(--color-error)]' : 'text-[var(--color-accent)]'}`}>
                            {bootResult.msg}
                          </span>
                        )}
                      </div>
                    )}
                  </div>
                  <div className="mt-3 space-y-1">
                    {group.todos.slice(0, 15).map(todo => (
                      <div key={todo.id} className="flex items-center gap-2 text-sm">
                        <StatusDot status={todo.status} />
                        <span className="flex-1 truncate">{todo.content}</span>
                        {todo.estimatedMinutes !== null && (
                          <span className={`text-xs shrink-0 ${
                            todo.estimatedMinutes > TICKET_THRESHOLD ? 'text-yellow-400' : 'text-[var(--color-muted)]'
                          }`}>
                            {todo.estimatedMinutes}m
                          </span>
                        )}
                        <SourceBadge source={todo.source} />
                        <span className="text-xs text-[var(--color-muted)] shrink-0">
                          {formatRelativeTime(todo.updatedAt)}
                        </span>
                      </div>
                    ))}
                    {group.todos.length > 15 && (
                      <p className="text-sm text-[var(--color-muted)]">+{group.todos.length - 15} more</p>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
          )}
        </>
      )}
    </div>
  );
}

// --- Kanban Card ---

function KanbanCard({ todo, onUpdate, onDelete, projectPath, onBoot, booting, bootResult, onDragStart, onDragEnd, isDragging }: {
  todo: Todo;
  onUpdate: (id: number, updates: { estimatedMinutes?: number; status?: string }) => void;
  onDelete: (id: number) => void;
  projectPath: string | null;
  onBoot: (path: string, key: string, prompt?: string) => void;
  booting: string | null;
  bootResult: { key: string; msg: string } | null;
  onDragStart: (todo: Todo) => void;
  onDragEnd: () => void;
  isDragging: boolean;
}) {
  const [showEstimate, setShowEstimate] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const needsTicket = (todo.estimatedMinutes ?? 0) > TICKET_THRESHOLD;
  const bootKey = `todo-${todo.id}`;
  const isCompleted = todo.status === 'completed';

  return (
    <div
      draggable
      onDragStart={(e) => {
        e.dataTransfer.effectAllowed = 'move';
        e.dataTransfer.setData('text/plain', String(todo.id));
        onDragStart(todo);
      }}
      onDragEnd={onDragEnd}
      className={`
        bg-[var(--color-surface)] rounded-lg border p-3 text-sm
        shadow-md hover:shadow-lg
        transition-all duration-150 select-none
        ${isDragging
          ? 'opacity-40 scale-95 rotate-1'
          : 'cursor-grab active:cursor-grabbing hover:border-[var(--color-muted)] active:scale-[1.02] active:shadow-xl active:rotate-1'
        }
        ${needsTicket
          ? 'border-yellow-400/40 bg-yellow-400/[0.03]'
          : isCompleted
            ? 'border-[#10b981]/30 opacity-70'
            : todo.status === 'in_progress'
              ? 'border-[#fbbf24]/40'
              : 'border-[var(--color-border)]'
        }
      `}
    >
      {/* Card content */}
      <p className={`font-medium mb-2 leading-snug ${isCompleted ? 'line-through text-[var(--color-muted)]' : ''}`}>
        {todo.content}
      </p>

      {/* Time estimate row */}
      <div className="flex items-center gap-1.5 mb-2">
        {todo.estimatedMinutes !== null ? (
          <span
            className={`text-xs px-1.5 py-0.5 rounded cursor-pointer transition-colors ${
              needsTicket
                ? 'bg-yellow-400/20 text-yellow-400 hover:bg-yellow-400/30'
                : 'bg-[var(--color-surface-hover)] text-[var(--color-muted)] hover:text-[var(--color-foreground)]'
            }`}
            onClick={(e) => { e.stopPropagation(); setShowEstimate(!showEstimate); }}
          >
            ~{todo.estimatedMinutes}m
          </span>
        ) : (
          <span
            className="text-xs px-1.5 py-0.5 rounded bg-[var(--color-surface-hover)] text-[var(--color-muted)] cursor-pointer hover:text-[var(--color-foreground)] transition-colors"
            onClick={(e) => { e.stopPropagation(); setShowEstimate(!showEstimate); }}
          >
            ?m
          </span>
        )}
        {needsTicket && (
          <span className="text-xs px-1.5 py-0.5 rounded bg-yellow-400/20 text-yellow-400 font-bold">
            ticket
          </span>
        )}
      </div>

      {/* Estimate picker */}
      {showEstimate && (
        <div className="flex gap-1 mb-2 flex-wrap">
          {TIME_PRESETS.map(m => (
            <button
              key={m}
              onClick={(e) => { e.stopPropagation(); onUpdate(todo.id, { estimatedMinutes: m }); setShowEstimate(false); }}
              className={`text-xs px-1.5 py-0.5 rounded border transition-colors cursor-pointer ${
                m > TICKET_THRESHOLD
                  ? 'border-yellow-400/40 text-yellow-400 hover:bg-yellow-400/10'
                  : 'border-[var(--color-border)] text-[var(--color-muted)] hover:border-[var(--color-accent)]'
              }`}
            >
              {m}m
            </button>
          ))}
        </div>
      )}

      {/* Footer: source, session, actions */}
      <div className="flex items-center gap-1.5 text-xs text-[var(--color-muted)] flex-wrap">
        <SourceBadge source={todo.source} />

        {todo.sessionDisplay && todo.sessionUuid && todo.projectName && (
          <Link
            href={`/projects/${encodeURIComponent(todo.projectName)}/${todo.sessionUuid}`}
            className="hover:text-[var(--color-accent)] truncate max-w-[100px]"
            title={todo.sessionDisplay}
            onClick={(e) => e.stopPropagation()}
          >
            {todo.sessionDisplay}
          </Link>
        )}

        {projectPath && todo.status !== 'completed' && (
          <button
            onClick={(e) => { e.stopPropagation(); onBoot(projectPath, bootKey, `Work on this task: ${todo.content}`); }}
            disabled={booting === bootKey}
            className="px-1.5 py-0.5 text-xs font-bold bg-[var(--color-accent)] text-white rounded hover:opacity-90 disabled:opacity-50 cursor-pointer"
            title="Deploy agent to work on this todo"
          >
            {booting === bootKey ? '...' : 'Deploy'}
          </button>
        )}

        {confirmDelete ? (
          <span className="flex items-center gap-1 shrink-0">
            <button
              onClick={(e) => { e.stopPropagation(); onDelete(todo.id); setConfirmDelete(false); }}
              className="px-1.5 py-0.5 text-xs font-bold bg-[var(--color-error)] text-white rounded hover:opacity-90 cursor-pointer"
            >
              Confirm
            </button>
            <button
              onClick={(e) => { e.stopPropagation(); setConfirmDelete(false); }}
              className="px-1.5 py-0.5 text-xs text-[var(--color-muted)] rounded border border-[var(--color-border)] hover:border-[var(--color-muted)] cursor-pointer"
            >
              Cancel
            </button>
          </span>
        ) : (
          <button
            onClick={(e) => { e.stopPropagation(); setConfirmDelete(true); }}
            className="px-1.5 py-0.5 text-xs text-[var(--color-muted)] rounded border border-[var(--color-border)] hover:border-[var(--color-error)] hover:text-[var(--color-error)] shrink-0 cursor-pointer"
          >
            Del
          </button>
        )}

        <span className="ml-auto shrink-0" title={formatTimestamp(todo.createdAt)}>
          {formatRelativeTime(todo.updatedAt)}
        </span>
      </div>

      {/* Boot result */}
      {bootResult?.key === bootKey && (
        <div className={`mt-2 text-xs font-mono px-2 py-1 rounded ${
          bootResult.msg.startsWith('Error')
            ? 'text-[var(--color-error)] bg-[var(--color-error)]/10'
            : 'text-[var(--color-accent)] bg-[var(--color-accent)]/10'
        }`}>
          {bootResult.msg}
        </div>
      )}

      {todo.completedAt && (
        <div className="mt-1.5 text-xs text-[#10b981]">
          Completed {formatRelativeTime(todo.completedAt)}
        </div>
      )}
    </div>
  );
}

// --- Small components ---

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
