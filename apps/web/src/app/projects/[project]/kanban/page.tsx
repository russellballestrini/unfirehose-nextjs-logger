'use client';

import { use, useState, useCallback, useEffect, Fragment } from 'react';
import useSWR from 'swr';
import Link from 'next/link';
import { formatRelativeTime, formatTimestamp } from '@unfirehose/core/format';
import { PageContext } from '@unfirehose/ui/PageContext';
import { TimeRangeSelect, useTimeRange, getTimeRangeMinutes } from '@unfirehose/ui/TimeRangeSelect';

/* eslint-disable @typescript-eslint/no-explicit-any */

const fetcher = (url: string) => fetch(url).then(r => r.json());

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

const TICKET_THRESHOLD = 15;

const STATUS_COLUMNS = [
  { key: 'pending', label: 'Pending', color: 'var(--color-muted)', icon: '○' },
  { key: 'in_progress', label: 'In Progress', color: '#fbbf24', icon: '◉' },
  { key: 'completed', label: 'Completed', color: '#10b981', icon: '●' },
] as const;

const SOURCE_BADGE: Record<string, { label: string; color: string }> = {
  claude: { label: 'claude', color: '#a78bfa' },
  fetch: { label: 'fetch', color: '#60a5fa' },
  manual: { label: 'manual', color: '#34d399' },
};

const TIME_PRESETS = [5, 10, 15, 30, 60, 120];

function ParticleBurst({ x, y, color }: { x: number; y: number; color: string }) {
  const particles = Array.from({ length: 12 }, (_, i) => {
    const angle = (i / 12) * Math.PI * 2;
    const dist = 40 + Math.random() * 30;
    const size = 4 + Math.random() * 4;
    return { angle, dist, size, delay: Math.random() * 0.1 };
  });

  return (
    <div className="pointer-events-none fixed z-50" style={{ left: x, top: y }}>
      {particles.map((p, i) => (
        <div
          key={i}
          className="absolute rounded-full"
          style={{
            width: p.size,
            height: p.size,
            backgroundColor: color,
            left: -p.size / 2,
            top: -p.size / 2,
            animation: `burst-particle 0.5s ease-out ${p.delay}s forwards`,
            transform: `translate(${Math.cos(p.angle) * p.dist}px, ${Math.sin(p.angle) * p.dist}px) scale(0)`,
          }}
        />
      ))}
    </div>
  );
}

export default function ProjectKanbanPage({ params }: { params: Promise<{ project: string }> }) {
  const { project } = use(params);
  const decodedProject = decodeURIComponent(project);

  const { data: projectData } = useSWR<any>(`/api/projects/${project}/sessions`, fetcher);
  const { data: full } = useSWR<any>(`/api/projects/${project}/full`, fetcher);

  const [todos, setTodos] = useState<Todo[]>([]);
  const [loading, setLoading] = useState(true);
  const [newTodo, setNewTodo] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [booting, setBooting] = useState<string | null>(null);
  const [bootResult, setBootResult] = useState<{ key: string; msg: string } | null>(null);
  const [draggedTodo, setDraggedTodo] = useState<Todo | null>(null);
  const [dragOverColumn, setDragOverColumn] = useState<string | null>(null);
  const [landedCardId, setLandedCardId] = useState<number | null>(null);
  const [pulsedColumn, setPulsedColumn] = useState<string | null>(null);
  const [burst, setBurst] = useState<{ x: number; y: number; color: string } | null>(null);
  const [dragOverIndex, setDragOverIndex] = useState<number>(-1);
  const [range, setRange] = useTimeRange('kanban_range', '7d');
  const completedWindowDays = Math.max(1, Math.ceil((getTimeRangeMinutes(range) || 60 * 24 * 365) / 60 / 24));

  const canDropOnColumn = useCallback((from: string, to: string) => {
    if (from === to) return false;
    if (from === 'pending' && to === 'in_progress') return true;
    if (from === 'in_progress' && to === 'completed') return true;
    if (from === 'in_progress' && to === 'pending') return true;
    return false;
  }, []);

  const fetchTodos = useCallback((showLoading = true) => {
    if (showLoading) setLoading(true);
    fetch(`/api/todos?project=${encodeURIComponent(decodedProject)}`)
      .then(r => r.json())
      .then(data => {
        const group = (data.byProject ?? []).find((g: any) => g.project === decodedProject);
        setTodos(group?.todos ?? []);
      })
      .catch(() => setTodos([]))
      .finally(() => setLoading(false));
  }, [decodedProject]);

  useEffect(() => { fetchTodos(); }, [fetchTodos]);

  const updateTodo = useCallback(async (id: number, updates: { estimatedMinutes?: number; status?: string }) => {
    // Optimistic update — move the card immediately
    setTodos(prev => prev.map(t => t.id === id ? {
      ...t,
      ...updates,
      ...(updates.status === 'completed' ? { completedAt: new Date().toISOString() } : {}),
      updatedAt: new Date().toISOString(),
    } : t));
    await fetch('/api/todos', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id, ...updates }),
    });
    // Sync with server silently (no loading flash)
    fetchTodos(false);
  }, [fetchTodos]);

  const deleteTodo = useCallback(async (id: number) => {
    setTodos(prev => prev.filter(t => t.id !== id));
    await fetch('/api/todos', {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id }),
    });
    fetchTodos(false);
  }, [fetchTodos]);

  const addTodo = useCallback(async (startNow = false) => {
    if (!newTodo.trim() || submitting) return;
    setSubmitting(true);
    try {
      await fetch('/api/todos', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          content: newTodo.trim(),
          projectName: decodedProject,
          source: 'manual',
          status: startNow ? 'in_progress' : 'pending',
        }),
      });

      if (startNow && projectData?.originalPath) {
        const res = await fetch('/api/boot', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ projectPath: projectData.originalPath, yolo: true, prompt: newTodo.trim() }),
        });
        const result = await res.json();
        setBootResult({
          key: 'new-todo',
          msg: result.success ? `tmux: ${result.tmuxSession}` : `Error: ${result.error}`,
        });
      }

      setNewTodo('');
      fetchTodos(false);
    } catch { /* silent */ }
    setSubmitting(false);
  }, [newTodo, submitting, fetchTodos, decodedProject, projectData]);

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
      setBootResult({ key, msg: result.success ? `tmux: ${result.tmuxSession}` : `Error: ${result.error}` });
    } catch (err) {
      setBootResult({ key, msg: `Error: ${String(err)}` });
    }
    setBooting(null);
  }, []);

  // Sort todos into columns
  const columns: Record<string, Todo[]> = { pending: [], in_progress: [], completed: [] };
  for (const todo of todos) {
    if (columns[todo.status]) columns[todo.status].push(todo);
  }

  // Filter completed to last N days
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - completedWindowDays);
  const cutoffStr = cutoff.toISOString();
  const recentCompleted = columns.completed.filter(t => (t.completedAt ?? t.updatedAt) >= cutoffStr);

  const completedByDay: Record<string, Todo[]> = {};
  for (const t of recentCompleted) {
    const day = (t.completedAt ?? t.updatedAt).slice(0, 10);
    if (!completedByDay[day]) completedByDay[day] = [];
    completedByDay[day].push(t);
  }
  const completedDays = Object.keys(completedByDay).sort().reverse();

  const handleDragStart = useCallback((todo: Todo) => { setDraggedTodo(todo); }, []);
  const handleDragEnd = useCallback(() => { setDraggedTodo(null); setDragOverColumn(null); setDragOverIndex(-1); }, []);

  const handleDrop = useCallback(async (targetStatus: string, e: React.DragEvent) => {
    if (!draggedTodo || !canDropOnColumn(draggedTodo.status, targetStatus)) {
      setDraggedTodo(null); setDragOverColumn(null); setDragOverIndex(-1);
      return;
    }

    const todo = draggedTodo;
    setDraggedTodo(null);
    setDragOverColumn(null);
    setDragOverIndex(-1);

    const accent = getComputedStyle(document.documentElement).getPropertyValue('--color-accent').trim();
    const burstColor = targetStatus === 'in_progress' ? accent : targetStatus === 'completed' ? '#22c55e' : '#a1a1aa';
    setBurst({ x: e.clientX, y: e.clientY, color: burstColor });
    setTimeout(() => setBurst(null), 600);

    setLandedCardId(todo.id);
    setPulsedColumn(targetStatus);
    setTimeout(() => { setLandedCardId(null); setPulsedColumn(null); }, 700);

    await updateTodo(todo.id, { status: targetStatus });

    if (targetStatus === 'in_progress' && todo.status === 'pending' && projectData?.originalPath) {
      bootAgent(projectData.originalPath, `todo-${todo.id}`, `Work on this task: ${todo.content}`);
    }
  }, [draggedTodo, updateTodo, projectData, bootAgent]);

  const projectPath = projectData?.originalPath ?? null;
  const displayName = full?.project?.displayName ?? decodedProject;

  return (
    <div className="p-6">
      <PageContext
        pageType="project-kanban"
        summary={`Kanban for ${displayName}. ${todos.length} todos.`}
        metrics={{ project: decodedProject, total: todos.length }}
      />

      {burst && <ParticleBurst x={burst.x} y={burst.y} color={burst.color} />}

      {/* Header */}
      <div className="flex items-center gap-3 mb-4">
        <Link href={`/projects/${project}`} className="text-sm text-[var(--color-muted)] hover:text-[var(--color-foreground)]">
          &larr; {displayName}
        </Link>
        <h1 className="text-xl font-bold">Kanban</h1>
        <div className="flex gap-2 text-sm ml-2">
          <span className="px-2 py-0.5 rounded bg-[var(--color-surface-hover)]">{columns.pending.length} pending</span>
          <span className="px-2 py-0.5 rounded bg-[var(--color-surface-hover)] text-yellow-400">{columns.in_progress.length} active</span>
          <span className="px-2 py-0.5 rounded bg-[var(--color-surface-hover)] text-green-400">{recentCompleted.length} done</span>
        </div>
        <div className="ml-auto flex items-center gap-3">
          <Link href="/todos" className="text-xs text-[var(--color-accent)] hover:underline">Global Kanban</Link>
          <TimeRangeSelect value={range} onChange={setRange} />
        </div>
      </div>

      {/* Add todo */}
      <div className="flex gap-2 mb-4">
        <input
          type="text" value={newTodo} onChange={e => setNewTodo(e.target.value)}
          onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); addTodo(false); } }}
          placeholder={`Add task for ${displayName}...`}
          className="flex-1 px-3 py-2 text-sm rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] text-[var(--color-foreground)] placeholder:text-[var(--color-muted)] focus:outline-none focus:border-[var(--color-accent)]"
          disabled={submitting}
        />
        <button onClick={() => addTodo(false)} disabled={submitting || !newTodo.trim()} className="px-4 py-2 text-sm rounded-lg bg-[var(--color-surface-hover)] text-[var(--color-foreground)] hover:bg-[var(--color-border)] disabled:opacity-40 transition-colors">Queue</button>
        <button onClick={() => addTodo(true)} disabled={submitting || !newTodo.trim() || !projectPath} className="px-5 py-2 text-sm font-bold rounded-lg bg-[var(--color-accent)] text-[var(--color-background)] hover:opacity-90 disabled:opacity-40 transition-opacity" title="Creates todo and boots Claude in tmux">
          {submitting ? '...' : 'Start Now'}
        </button>
      </div>

      {draggedTodo && (
        <div className="mb-4 text-sm text-[var(--color-accent)] font-bold animate-pulse">
          Drag to In Progress to boot agent — drop on Completed to finish
        </div>
      )}

      {loading ? (
        <p className="text-[var(--color-muted)]">Loading...</p>
      ) : todos.length === 0 ? (
        <div className="border border-[var(--color-border)] rounded-lg p-8 text-center">
          <p className="text-[var(--color-muted)] text-lg mb-2">No todos for this project</p>
          <p className="text-[var(--color-muted)] text-base">Add a task above to get started.</p>
        </div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-3 gap-6 items-start">
          {STATUS_COLUMNS.map(col => {
            const isOver = dragOverColumn === col.key;
            const validDrop = draggedTodo != null && canDropOnColumn(draggedTodo.status, col.key);
            const isPulsed = pulsedColumn === col.key;
            const isCompleted = col.key === 'completed';
            const columnTodos = isCompleted ? recentCompleted : (columns[col.key] ?? []);
            const gapColor = col.key === 'in_progress' ? 'var(--color-accent)' : col.key === 'completed' ? '#22c55e' : 'var(--color-muted)';
            const gapLabel = col.key === 'in_progress' ? 'Drop to power up agent' : col.key === 'completed' ? 'Drop to mark done' : 'Drop to queue';

            return (
              <div
                key={col.key}
                onDragOver={(e) => {
                  if (!draggedTodo || !canDropOnColumn(draggedTodo.status, col.key)) return;
                  e.preventDefault();
                  e.dataTransfer.dropEffect = 'move';
                  setDragOverColumn(col.key);
                  if (e.target === e.currentTarget) setDragOverIndex(columnTodos.length);
                }}
                onDragLeave={(e) => {
                  if (!e.currentTarget.contains(e.relatedTarget as Node)) {
                    setDragOverColumn(null);
                    setDragOverIndex(-1);
                  }
                }}
                onDrop={(e) => { e.preventDefault(); handleDrop(col.key, e); }}
                data-kanban-col={col.key}
                className={`rounded-xl p-3 transition-all duration-300 min-h-[200px] ${
                  isOver && validDrop ? 'scale-[1.01]' : isPulsed ? 'column-drop-pulse' : ''
                }`}
                style={isOver && validDrop ? { outline: `2px solid ${gapColor}`, outlineOffset: '-2px', borderRadius: '12px' } : undefined}
              >
                <div className="flex items-center gap-2 mb-4 pb-2 border-b-2" style={{ borderBottomColor: col.color }}>
                  <span className="text-lg" style={{ color: col.color }}>{col.icon}</span>
                  <h2 className="font-bold text-sm">{col.label}</h2>
                  {isCompleted && <span className="text-xs text-[var(--color-muted)]">last {completedWindowDays}d</span>}
                  <span className="text-xs text-[var(--color-muted)] ml-auto tabular-nums">{columnTodos.length}</span>
                </div>

                <div className="space-y-2 overflow-y-auto max-h-[calc(100vh-220px)] pr-1">
                  {isCompleted ? (
                    completedDays.length === 0 ? (
                      <p className="text-sm text-[var(--color-muted)] text-center py-8 italic">No completions in last {completedWindowDays} days</p>
                    ) : (
                      <>
                        {isOver && validDrop && dragOverIndex === 0 && (
                          <InsertionGap color={gapColor} label={gapLabel} />
                        )}
                        {completedDays.map(day => (
                          <div key={day}>
                            <div className="text-xs text-[var(--color-muted)] font-bold mb-1.5 mt-2">{day}</div>
                            {completedByDay[day].map(todo => (
                              <CompletedCard key={todo.id} todo={todo} landed={landedCardId === todo.id} />
                            ))}
                          </div>
                        ))}
                      </>
                    )
                  ) : (
                    <>
                      {columnTodos.map((todo, i) => (
                        <Fragment key={todo.id}>
                          {isOver && validDrop && dragOverIndex === i && (
                            <InsertionGap color={gapColor} label={gapLabel} />
                          )}
                          <div
                            onDragOver={(e) => {
                              if (!draggedTodo || !canDropOnColumn(draggedTodo.status, col.key)) return;
                              e.preventDefault();
                              e.stopPropagation();
                              const rect = e.currentTarget.getBoundingClientRect();
                              setDragOverIndex(e.clientY < rect.top + rect.height / 2 ? i : i + 1);
                              setDragOverColumn(col.key);
                            }}
                          >
                            <KanbanCard
                              todo={todo}
                              onUpdate={updateTodo} onDelete={deleteTodo}
                              projectPath={projectPath}
                              onBoot={bootAgent} booting={booting} bootResult={bootResult}
                              onDragStart={handleDragStart} onDragEnd={handleDragEnd}
                              isDragging={draggedTodo?.id === todo.id}
                              landed={landedCardId === todo.id}
                              project={project}
                            />
                          </div>
                        </Fragment>
                      ))}
                      {isOver && validDrop && dragOverIndex >= columnTodos.length && (
                        <InsertionGap color={gapColor} label={gapLabel} />
                      )}
                      {columnTodos.length === 0 && !validDrop && (
                        <p className="text-sm text-[var(--color-muted)] text-center py-8 italic">Empty</p>
                      )}
                      {columnTodos.length === 0 && isOver && validDrop && (
                        <InsertionGap color={gapColor} label={gapLabel} />
                      )}
                    </>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

function KanbanCard({ todo, onUpdate, onDelete, projectPath, onBoot, booting, bootResult, onDragStart, onDragEnd, isDragging, landed, project }: {
  todo: Todo; onUpdate: (id: number, u: any) => void; onDelete: (id: number) => void;
  projectPath: string | null; onBoot: (p: string, k: string, pr?: string) => void;
  booting: string | null; bootResult: { key: string; msg: string } | null;
  onDragStart: (t: Todo) => void; onDragEnd: () => void; isDragging: boolean; landed: boolean;
  project: string;
}) {
  const [showEstimate, setShowEstimate] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const needsTicket = (todo.estimatedMinutes ?? 0) > TICKET_THRESHOLD;
  const bootKey = `todo-${todo.id}`;
  const isActive = todo.status === 'in_progress';

  return (
    <div
      draggable
      onDragStart={(e) => {
        const el = e.currentTarget;
        const clone = el.cloneNode(true) as HTMLElement;
        clone.style.width = `${el.offsetWidth}px`;
        clone.style.transform = 'rotate(3deg) scale(1.05)';
        const accent = getComputedStyle(document.documentElement).getPropertyValue('--color-accent').trim();
        clone.style.boxShadow = `0 25px 50px rgba(0,0,0,0.5), 0 0 30px ${accent}66`;
        clone.style.borderRadius = '12px';
        clone.style.position = 'absolute';
        clone.style.left = '-9999px';
        clone.style.top = '-9999px';
        document.body.appendChild(clone);
        e.dataTransfer.setDragImage(clone, e.nativeEvent.offsetX, e.nativeEvent.offsetY);
        requestAnimationFrame(() => document.body.removeChild(clone));
        e.dataTransfer.effectAllowed = 'move';
        e.dataTransfer.setData('text/plain', String(todo.id));
        onDragStart(todo);
      }}
      onDragEnd={onDragEnd}
      className={`
        rounded-xl border p-3.5 text-sm
        transition-all duration-200 select-none
        ${isDragging
          ? 'border-2 border-dashed border-[var(--color-muted)]/40 bg-[var(--color-surface)]/30 shadow-none [&>*]:opacity-20'
          : landed
            ? 'card-landed bg-[var(--color-surface)]'
            : 'bg-[var(--color-surface)] cursor-grab active:cursor-grabbing hover:shadow-xl hover:-translate-y-0.5 active:scale-[1.03] active:rotate-1'
        }
        ${isDragging ? ''
          : needsTicket ? 'border-yellow-400/40 bg-yellow-400/[0.03]'
          : isActive ? 'border-[var(--color-accent)]/50 shadow-[0_0_12px_var(--color-accent)] shadow-lg'
          : 'border-[var(--color-border)] shadow-md hover:border-[var(--color-muted)]'
        }
      `}
    >
      {isActive && (
        <div className="flex items-center gap-1.5 mb-2">
          <span className="w-1.5 h-1.5 rounded-full bg-[var(--color-accent)] animate-pulse" />
          <span className="text-xs font-bold text-[var(--color-accent)]">RUNNING</span>
        </div>
      )}

      <p className="font-medium mb-2 leading-snug">{todo.content}</p>

      <div className="flex items-center gap-1.5 mb-2">
        <span
          className={`text-xs px-1.5 py-0.5 rounded cursor-pointer transition-colors ${needsTicket ? 'bg-yellow-400/20 text-yellow-400 hover:bg-yellow-400/30' : 'bg-[var(--color-surface-hover)] text-[var(--color-muted)] hover:text-[var(--color-foreground)]'}`}
          onClick={(e) => { e.stopPropagation(); setShowEstimate(!showEstimate); }}
        >
          {todo.estimatedMinutes !== null ? `~${todo.estimatedMinutes}m` : '?m'}
        </span>
        {needsTicket && <span className="text-xs px-1.5 py-0.5 rounded bg-yellow-400/20 text-yellow-400 font-bold">ticket</span>}
      </div>

      {showEstimate && (
        <div className="flex gap-1 mb-2 flex-wrap">
          {TIME_PRESETS.map(m => (
            <button key={m} onClick={(e) => { e.stopPropagation(); onUpdate(todo.id, { estimatedMinutes: m }); setShowEstimate(false); }}
              className={`text-xs px-1.5 py-0.5 rounded border transition-colors cursor-pointer ${m > TICKET_THRESHOLD ? 'border-yellow-400/40 text-yellow-400 hover:bg-yellow-400/10' : 'border-[var(--color-border)] text-[var(--color-muted)] hover:border-[var(--color-accent)]'}`}
            >{m}m</button>
          ))}
        </div>
      )}

      <div className="flex items-center gap-1.5 text-xs text-[var(--color-muted)] flex-wrap">
        <SourceBadge source={todo.source} />
        {todo.sessionDisplay && todo.sessionUuid && (
          <Link href={`/projects/${project}/${todo.sessionUuid}`} className="hover:text-[var(--color-accent)] truncate max-w-[100px]" onClick={(e) => e.stopPropagation()}>{todo.sessionDisplay}</Link>
        )}
        {projectPath && !isActive && (
          <button onClick={(e) => { e.stopPropagation(); onBoot(projectPath, bootKey, `Work on this task: ${todo.content}`); }} disabled={booting === bootKey}
            className="px-1.5 py-0.5 text-xs font-bold bg-[var(--color-accent)] text-white rounded hover:opacity-90 disabled:opacity-50 cursor-pointer">
            {booting === bootKey ? '...' : 'Deploy'}
          </button>
        )}
        {confirmDelete ? (
          <span className="flex items-center gap-1 shrink-0">
            <button onClick={(e) => { e.stopPropagation(); onDelete(todo.id); setConfirmDelete(false); }} className="px-1.5 py-0.5 text-xs font-bold bg-[var(--color-error)] text-white rounded hover:opacity-90 cursor-pointer">Confirm</button>
            <button onClick={(e) => { e.stopPropagation(); setConfirmDelete(false); }} className="px-1.5 py-0.5 text-xs text-[var(--color-muted)] rounded border border-[var(--color-border)] hover:border-[var(--color-muted)] cursor-pointer">Cancel</button>
          </span>
        ) : (
          <button onClick={(e) => { e.stopPropagation(); setConfirmDelete(true); }} className="px-1.5 py-0.5 text-xs text-[var(--color-muted)] rounded border border-[var(--color-border)] hover:border-[var(--color-error)] hover:text-[var(--color-error)] shrink-0 cursor-pointer">Del</button>
        )}
        <span className="ml-auto shrink-0" title={formatTimestamp(todo.createdAt)}>{formatRelativeTime(todo.updatedAt)}</span>
      </div>

      {bootResult?.key === bootKey && (
        <div className={`mt-2 text-xs font-mono px-2 py-1 rounded ${bootResult.msg.startsWith('Error') ? 'text-[var(--color-error)] bg-[var(--color-error)]/10' : 'text-[var(--color-accent)] bg-[var(--color-accent)]/10'}`}>
          {bootResult.msg}
        </div>
      )}
    </div>
  );
}

function InsertionGap({ color, label }: { color: string; label: string }) {
  return (
    <div
      className="rounded-xl border-2 border-dashed p-4 text-center transition-all duration-200 animate-pulse"
      style={{ borderColor: color, backgroundColor: `color-mix(in srgb, ${color} 7%, transparent)` }}
    >
      <span className="text-sm font-bold" style={{ color }}>{label}</span>
    </div>
  );
}

function CompletedCard({ todo, landed }: { todo: Todo; landed: boolean }) {
  return (
    <div className={`rounded-lg border border-[#10b981]/20 p-2.5 mb-1.5 text-sm bg-[var(--color-surface)] ${landed ? 'card-landed' : ''}`}>
      <p className="line-through text-[var(--color-muted)] text-xs leading-snug">{todo.content}</p>
      <div className="flex items-center gap-1.5 mt-1 text-xs text-[var(--color-muted)]">
        <SourceBadge source={todo.source} />
        {todo.completedAt && <span className="text-[#10b981]">{formatRelativeTime(todo.completedAt)}</span>}
      </div>
    </div>
  );
}

function SourceBadge({ source }: { source: string }) {
  const badge = SOURCE_BADGE[source] ?? { label: source, color: 'var(--color-muted)' };
  return <span className="px-1.5 py-0.5 rounded text-xs font-medium" style={{ backgroundColor: `${badge.color}22`, color: badge.color }}>{badge.label}</span>;
}
