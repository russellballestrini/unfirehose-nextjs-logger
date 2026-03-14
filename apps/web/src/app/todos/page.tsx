'use client';

import { useEffect, useState, useCallback, useRef, Fragment } from 'react';
import Link from 'next/link';
import useSWR from 'swr';
import { formatRelativeTime, formatTimestamp } from '@unturf/unfirehose/format';
import { PageContext } from '@unturf/unfirehose-ui/PageContext';

const fetcher = (url: string) => fetch(url).then(r => r.json());

/* eslint-disable @typescript-eslint/no-explicit-any */

interface Attachment {
  id: number;
  filename: string;
  mimeType: string;
  sizeBytes: number;
  hash: string;
  createdAt: string;
}

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
  tmuxSession: string | null;
  attachments: Attachment[];
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
const COMPLETED_WINDOW_DAYS = 6;

const STATUS_COLUMNS = [
  { key: 'pending', label: 'Pending', color: '#fbbf24', icon: '○' },
  { key: 'in_progress', label: 'In Progress', color: '#60a5fa', icon: '◉' },
  { key: 'completed', label: 'Completed', color: '#22c55e', icon: '●' },
] as const;

const SOURCE_BADGE: Record<string, { label: string; color: string }> = {
  claude: { label: 'claude', color: '#a78bfa' },
  fetch: { label: 'fetch', color: '#60a5fa' },
  manual: { label: 'manual', color: '#34d399' },
};

const TIME_PRESETS = [5, 10, 15, 30, 60, 120];

// Pre-computed random particle data (module level to satisfy react-hooks/purity)
const POWERUP_INNER = Array.from({ length: 16 }, (_, i) => {
  const angle = (i / 16) * Math.PI * 2 + Math.random() * 0.3;
  return { angle, dist: 30 + Math.random() * 25, size: 5 + Math.random() * 5, delay: Math.random() * 0.05 };
});
const POWERUP_OUTER = Array.from({ length: 24 }, (_, i) => {
  const angle = (i / 24) * Math.PI * 2 + Math.random() * 0.2;
  return { angle, dist: 70 + Math.random() * 60, size: 3 + Math.random() * 4, delay: 0.05 + Math.random() * 0.1 };
});
const POWERUP_SPARKS = Array.from({ length: 10 }, () => {
  const angle = Math.random() * Math.PI * 2;
  return { angle, dist: 100 + Math.random() * 80, delay: Math.random() * 0.08 };
});
const PENDING_PARTICLES = Array.from({ length: 8 }, (_, i) => {
  const angle = (i / 8) * Math.PI * 2;
  return { angle, dist: 30 + Math.random() * 20, size: 3 + Math.random() * 3, delay: Math.random() * 0.1 };
});

// Power-up explosion: massive multi-ring particle burst with sparks and shockwave
function PowerUpBurst({ x, y, color }: { x: number; y: number; color: string }) {
  const inner = POWERUP_INNER;
  const outer = POWERUP_OUTER;
  const sparks = POWERUP_SPARKS;

  return (
    <div className="pointer-events-none fixed z-50" style={{ left: x, top: y }}>
      {/* Shockwave ring */}
      <div className="absolute -translate-x-1/2 -translate-y-1/2 rounded-full powerup-shockwave" style={{ borderColor: color }} />
      {/* Central flash */}
      <div className="absolute -translate-x-1/2 -translate-y-1/2 rounded-full powerup-flash" style={{ backgroundColor: color }} />
      {/* Inner particles */}
      {inner.map((p, i) => (
        <div key={`i${i}`} className="absolute rounded-full powerup-particle" style={{
          width: p.size, height: p.size, backgroundColor: color,
          left: -p.size / 2, top: -p.size / 2,
          '--px': `${Math.cos(p.angle) * p.dist}px`, '--py': `${Math.sin(p.angle) * p.dist}px`,
          animationDelay: `${p.delay}s`,
        } as React.CSSProperties} />
      ))}
      {/* Outer particles */}
      {outer.map((p, i) => (
        <div key={`o${i}`} className="absolute rounded-full powerup-particle-slow" style={{
          width: p.size, height: p.size, backgroundColor: color,
          left: -p.size / 2, top: -p.size / 2,
          '--px': `${Math.cos(p.angle) * p.dist}px`, '--py': `${Math.sin(p.angle) * p.dist}px`,
          animationDelay: `${p.delay}s`,
        } as React.CSSProperties} />
      ))}
      {/* Sparks — elongated streaks */}
      {sparks.map((s, i) => (
        <div key={`s${i}`} className="absolute powerup-spark" style={{
          backgroundColor: color,
          '--sx': `${Math.cos(s.angle) * s.dist}px`, '--sy': `${Math.sin(s.angle) * s.dist}px`,
          '--rot': `${s.angle}rad`,
          animationDelay: `${s.delay}s`,
        } as React.CSSProperties} />
      ))}
    </div>
  );
}

// Power-down flash: capacitor discharge — intense white flash then gone
function CapacitorFlash({ x, y }: { x: number; y: number }) {
  return (
    <div className="pointer-events-none fixed z-50" style={{ left: x, top: y }}>
      {/* Bright core flash */}
      <div className="absolute -translate-x-1/2 -translate-y-1/2 rounded-full capacitor-core" />
      {/* Expanding ring */}
      <div className="absolute -translate-x-1/2 -translate-y-1/2 rounded-full capacitor-ring" />
      {/* Screen flash overlay */}
      <div className="fixed inset-0 capacitor-screen" />
    </div>
  );
}

// Route to the right effect based on target column
function ParticleBurst({ x, y, color, targetStatus }: { x: number; y: number; color: string; targetStatus: string }) {
  if (targetStatus === 'in_progress') return <PowerUpBurst x={x} y={y} color={color} />;
  if (targetStatus === 'completed') return <CapacitorFlash x={x} y={y} />;
  // Fallback: small burst for pending
  const particles = PENDING_PARTICLES;
  return (
    <div className="pointer-events-none fixed z-50" style={{ left: x, top: y }}>
      {particles.map((p, i) => (
        <div key={i} className="absolute rounded-full powerup-particle" style={{
          width: p.size, height: p.size, backgroundColor: color,
          left: -p.size / 2, top: -p.size / 2,
          '--px': `${Math.cos(p.angle) * p.dist}px`, '--py': `${Math.sin(p.angle) * p.dist}px`,
          animationDelay: `${p.delay}s`,
        } as React.CSSProperties} />
      ))}
    </div>
  );
}

export default function TodosPage() {
  const [byProject, setByProject] = useState<ProjectGroup[]>([]);
  const [counts, setCounts] = useState<Counts>({ pending: 0, inProgress: 0, completed: 0, total: 0 });
  const [filter, setFilter] = useState<string>('all');
  const [loading, setLoading] = useState(true);
  const [view, setView] = useState<'kanban' | 'project'>('kanban');
  const [bootResult, setBootResult] = useState<{ key: string; msg: string } | null>(null);
  const [booting, setBooting] = useState<string | null>(null);
  const [megaStatus, setMegaStatus] = useState<any>(null);
  const [megaLoading, setMegaLoading] = useState(false);
  const [megaPanelOpen, setMegaPanelOpen] = useState(false);
  const [autoCull, setAutoCull] = useState(false);
  const [draggedTodo, setDraggedTodo] = useState<Todo | null>(null);
  const [dragOverColumn, setDragOverColumn] = useState<string | null>(null);
  const [landedCardId, setLandedCardId] = useState<number | null>(null);
  const [pulsedColumn, setPulsedColumn] = useState<string | null>(null);
  const [burst, setBurst] = useState<{ x: number; y: number; color: string; targetStatus: string } | null>(null);
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const [_dragOverIndex, setDragOverIndex] = useState<number>(-1);
  const [showCreateForm, setShowCreateForm] = useState(false);
  const [newContent, setNewContent] = useState('');
  const [newFiles, setNewFiles] = useState<File[]>([]);
  const [creating, setCreating] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const { data: meshData } = useSWR('/api/mesh', fetcher, { refreshInterval: 30000 });
  const meshNodes: { hostname: string; reachable: boolean }[] = meshData?.nodes ?? [];

  const fetchTodos = useCallback((showLoading = true) => {
    if (showLoading) setLoading(true);
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

  // eslint-disable-next-line react-hooks/set-state-in-effect -- data fetching on mount
  useEffect(() => { fetchTodos(true); }, [fetchTodos]);

  const updateTodo = useCallback(async (id: number, updates: { estimatedMinutes?: number; status?: string; content?: string }) => {
    // Optimistic local update
    setByProject(prev => prev.map(group => ({
      ...group,
      todos: group.todos.map(t => t.id === id ? { ...t, ...updates } : t),
    })));

    await fetch('/api/todos', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id, ...updates }),
    });
    fetchTodos(false);
  }, [fetchTodos]);

  const deleteTodo = useCallback(async (id: number) => {
    // Optimistic local removal
    setByProject(prev => prev.map(group => ({
      ...group,
      todos: group.todos.filter(t => t.id !== id),
    })));

    await fetch('/api/todos', {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id }),
    });
    fetchTodos(false);
  }, [fetchTodos]);

  const bootAgent = useCallback(async (projectPath: string, key: string, prompt?: string, host?: string, todoIds?: number[], projectName?: string) => {
    setBooting(key);
    setBootResult(null);
    try {
      const body: any = { projectPath, yolo: true, prompt };
      if (host && host !== 'localhost') body.host = host;
      if (todoIds?.length) body.todoIds = todoIds;
      if (projectName) body.projectName = projectName;
      const res = await fetch('/api/boot', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const result = await res.json();
      setBootResult({
        key,
        msg: result.success ? `tmux: ${result.tmuxSession}${host && host !== 'localhost' ? ` @${host}` : ''}` : `Error: ${result.error}${result.detail ? ` — ${result.detail}` : ''}`,
      });
      // Revalidate todos so tmuxSession shows up via agent_deployments
      if (result.success) setTimeout(() => fetchTodos(false), 1000);
    } catch (err) {
      setBootResult({ key, msg: `Error: ${String(err)}` });
    }
    setBooting(null);
  }, [fetchTodos]);

  const megaDeploy = useCallback(async () => {
    setMegaLoading(true); setMegaPanelOpen(true);
    try {
      const res = await fetch('/api/boot/mega', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ maxAgents: 10 }) });
      setMegaStatus(await res.json());
    } catch (err) { setMegaStatus({ error: String(err) }); }
    setMegaLoading(false);
  }, []);

  const megaRefresh = useCallback(async () => {
    try { const res = await fetch('/api/boot/mega'); setMegaStatus(await res.json()); setMegaPanelOpen(true); }
    catch (err) { setMegaStatus({ error: String(err) }); }
  }, []);

  const megaCull = useCallback(async () => {
    setMegaLoading(true);
    try { const res = await fetch('/api/boot/mega', { method: 'DELETE' }); const data = await res.json(); setMegaStatus((prev: any) => ({ ...prev, cullResult: data })); setTimeout(() => { megaRefresh(); fetchTodos(); }, 500); }
    catch (err) { setMegaStatus({ error: String(err) }); }
    setMegaLoading(false);
  }, [megaRefresh, fetchTodos]);

  const createTodo = useCallback(async () => {
    if (!newContent.trim()) return;
    setCreating(true);
    try {
      const res = await fetch('/api/todos', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content: newContent.trim() }),
      });
      const data = await res.json();
      if (data.ok && newFiles.length > 0) {
        const form = new FormData();
        form.append('todoId', String(data.id));
        for (const f of newFiles) form.append('files', f);
        await fetch('/api/todos/attachments', { method: 'POST', body: form });
      }
      setNewContent('');
      setNewFiles([]);
      setShowCreateForm(false);
      fetchTodos();
    } catch { /* silent */ }
    setCreating(false);
  }, [newContent, newFiles, fetchTodos]);

  useEffect(() => {
    if (!autoCull) return;
    const interval = setInterval(async () => {
      try {
        await fetch('/api/boot/mega', { method: 'DELETE' });
        const res = await fetch('/api/boot/mega');
        const data = await res.json();
        setMegaStatus(data); setMegaPanelOpen(true); fetchTodos();
        if (data.active === 0) setAutoCull(false);
      } catch { /* silent */ }
    }, 60000);
    return () => clearInterval(interval);
  }, [autoCull, fetchTodos]);

  // Collect all todos into columns
  const columns: Record<string, Todo[]> = { pending: [], in_progress: [], completed: [] };
  for (const group of byProject) {
    for (const todo of group.todos) {
      if (columns[todo.status]) columns[todo.status].push(todo);
    }
  }

  // Filter completed to last N days
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - COMPLETED_WINDOW_DAYS);
  const cutoffStr = cutoff.toISOString();
  const recentCompleted = columns.completed.filter(t => (t.completedAt ?? t.updatedAt) >= cutoffStr);

  // Group completed by day
  const completedByDay: Record<string, Todo[]> = {};
  for (const t of recentCompleted) {
    const day = (t.completedAt ?? t.updatedAt).slice(0, 10);
    if (!completedByDay[day]) completedByDay[day] = [];
    completedByDay[day].push(t);
  }
  const completedDays = Object.keys(completedByDay).sort().reverse();

  // Valid drop transitions
  const canDropOnColumn = useCallback((from: string, to: string) => {
    if (from === to) return false;
    if (from === 'pending' && to === 'in_progress') return true;
    if (from === 'in_progress' && to === 'completed') return true;
    if (from === 'in_progress' && to === 'pending') return true;
    return false;
  }, []);

  // Drag handlers
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

    // Burst effect at drop point
    const accent = getComputedStyle(document.documentElement).getPropertyValue('--color-accent').trim();
    const burstColor = targetStatus === 'in_progress' ? accent : targetStatus === 'completed' ? '#ffffff' : '#a1a1aa';
    setBurst({ x: e.clientX, y: e.clientY, color: burstColor, targetStatus });
    setTimeout(() => setBurst(null), targetStatus === 'in_progress' ? 1000 : 600);

    // Landing animation
    setLandedCardId(todo.id);
    setPulsedColumn(targetStatus);
    setTimeout(() => { setLandedCardId(null); setPulsedColumn(null); }, 700);

    // Update status
    await updateTodo(todo.id, { status: targetStatus });

    // Boot agent when dropping to in_progress
    if (targetStatus === 'in_progress' && todo.status === 'pending') {
      const group = byProject.find(g => g.todos.some(t => t.id === todo.id) && g.projectPath);
      if (group?.projectPath) {
        bootAgent(group.projectPath, `todo-${todo.id}`, `Work on this task: ${todo.content}`, undefined, [todo.id], group.project);
      }
    }
  }, [draggedTodo, updateTodo, byProject, bootAgent, canDropOnColumn]);

  // Stats
  const unestimated = [...(columns.pending ?? []), ...(columns.in_progress ?? [])].filter(t => t.estimatedMinutes === null);
  const totalEstMinutes = [...(columns.pending ?? []), ...(columns.in_progress ?? [])].reduce((s, t) => s + (t.estimatedMinutes ?? 0), 0);

  return (
    <div className="p-6">
      <PageContext
        pageType="todos"
        summary={`Todos. ${counts.total} total, ${counts.pending} pending, ${counts.inProgress} in progress.`}
        metrics={{ pending: counts.pending, in_progress: counts.inProgress, completed: counts.completed, total: counts.total }}
      />

      {/* Particle burst overlay */}
      {burst && <ParticleBurst x={burst.x} y={burst.y} color={burst.color} targetStatus={burst.targetStatus} />}

      <div className="flex items-center gap-4 mb-4">
        <h1 className="text-xl font-bold">Todos</h1>
        <div className="flex gap-2 text-sm">
          <span className="px-2 py-0.5 rounded bg-[var(--color-surface-hover)]">{counts.pending} pending</span>
          <span className="px-2 py-0.5 rounded bg-[var(--color-surface-hover)] text-yellow-400">{counts.inProgress} in progress</span>
          <span className="px-2 py-0.5 rounded bg-[var(--color-surface-hover)] text-green-400">{counts.completed} completed</span>
        </div>
        <div className="ml-auto flex gap-2">
          {[
            { v: 'kanban' as const, l: 'Kanban' },
            { v: 'project' as const, l: 'By Project' },
          ].map(b => (
            <button key={b.v} onClick={() => setView(b.v)} className={`px-3 py-1 text-sm rounded border ${view === b.v ? 'border-[var(--color-accent)] text-[var(--color-accent)]' : 'border-[var(--color-border)] text-[var(--color-muted)]'}`}>{b.l}</button>
          ))}
          <span className="w-px bg-[var(--color-border)]" />
          {[
            { v: 'all', l: 'All' },
            { v: 'active', l: 'Active' },
          ].map(b => (
            <button key={b.v} onClick={() => setFilter(b.v)} className={`px-3 py-1 text-sm rounded border ${filter === b.v ? 'border-[var(--color-accent)] text-[var(--color-accent)]' : 'border-[var(--color-border)] text-[var(--color-muted)]'}`}>{b.l}</button>
          ))}
          <button onClick={() => setShowCreateForm(!showCreateForm)} className={`px-3 py-1 text-sm rounded border ${showCreateForm ? 'border-[var(--color-accent)] text-[var(--color-accent)]' : 'border-[var(--color-border)] text-[var(--color-muted)] hover:border-[var(--color-accent)] hover:text-[var(--color-accent)]'}`}>
            + Add Todo
          </button>
          <span className="w-px bg-[var(--color-border)]" />
          <button onClick={megaDeploy} disabled={megaLoading} className="px-3 py-1 text-sm rounded border border-[var(--color-error)] text-[var(--color-error)] hover:bg-[var(--color-error)]/10 disabled:opacity-50 font-bold">
            {megaLoading ? 'Deploying...' : 'Mega Deploy'}
          </button>
          <button onClick={megaRefresh} className="px-3 py-1 text-sm rounded border border-[var(--color-border)] text-[var(--color-muted)] hover:border-[var(--color-accent)]">Status</button>
          <button onClick={megaCull} disabled={megaLoading} className="px-3 py-1 text-sm rounded border border-[var(--color-border)] text-[var(--color-muted)] hover:border-green-400 hover:text-green-400 disabled:opacity-50">Cull</button>
          <label className="flex items-center gap-1 text-sm text-[var(--color-muted)] cursor-pointer">
            <input type="checkbox" checked={autoCull} onChange={(e) => setAutoCull(e.target.checked)} className="accent-green-400" />
            Auto
          </label>
        </div>
      </div>

      {/* Mega Deploy Status Panel */}
      {megaPanelOpen && megaStatus && (
        <MegaPanel megaStatus={megaStatus} onClose={() => setMegaPanelOpen(false)} />
      )}

      {/* Create todo form */}
      {showCreateForm && (
        <div className="mb-4 border border-[var(--color-border)] rounded-lg p-4 bg-[var(--color-surface)]">
          <h2 className="font-bold text-sm mb-3">New Todo</h2>
          <input
            type="text"
            value={newContent}
            onChange={(e) => setNewContent(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); createTodo(); } }}
            placeholder="What needs to be done?"
            className="w-full px-3 py-2 mb-3 rounded border border-[var(--color-border)] bg-[var(--color-background)] text-sm focus:outline-none focus:border-[var(--color-accent)]"
          />
          <div
            onDragOver={(e) => { e.preventDefault(); e.stopPropagation(); }}
            onDrop={(e) => { e.preventDefault(); e.stopPropagation(); const files = Array.from(e.dataTransfer.files); setNewFiles(prev => [...prev, ...files]); }}
            onClick={() => fileInputRef.current?.click()}
            className="border-2 border-dashed border-[var(--color-border)] rounded-lg p-4 text-center cursor-pointer hover:border-[var(--color-accent)] transition-colors mb-3"
          >
            <p className="text-sm text-[var(--color-muted)]">Drop files here or click to browse</p>
            <input ref={fileInputRef} type="file" multiple className="hidden" onChange={(e) => { if (e.target.files) setNewFiles(prev => [...prev, ...Array.from(e.target.files!)]); }} />
          </div>
          {newFiles.length > 0 && (
            <div className="flex gap-2 mb-3 flex-wrap">
              {newFiles.map((f, i) => (
                <div key={i} className="flex items-center gap-1.5 px-2 py-1 rounded bg-[var(--color-surface-hover)] text-xs">
                  {f.type.startsWith('image/') ? (
                    // eslint-disable-next-line @next/next/no-img-element -- blob URL
                    <img src={URL.createObjectURL(f)} alt={f.name} className="w-8 h-8 rounded object-cover" />
                  ) : (
                    <span className="text-[var(--color-muted)]">{f.name}</span>
                  )}
                  <button onClick={(e) => { e.stopPropagation(); setNewFiles(prev => prev.filter((_, j) => j !== i)); }} className="text-[var(--color-muted)] hover:text-[var(--color-error)]">&times;</button>
                </div>
              ))}
            </div>
          )}
          <div className="flex gap-2">
            <button onClick={createTodo} disabled={creating || !newContent.trim()} className="px-4 py-1.5 text-sm rounded bg-[var(--color-accent)] text-white font-bold hover:opacity-90 disabled:opacity-50">
              {creating ? 'Creating...' : 'Create'}
            </button>
            <button onClick={() => { setShowCreateForm(false); setNewContent(''); setNewFiles([]); }} className="px-4 py-1.5 text-sm rounded border border-[var(--color-border)] text-[var(--color-muted)] hover:border-[var(--color-muted)]">
              Cancel
            </button>
          </div>
        </div>
      )}

      {/* Triage summary */}
      {!loading && counts.total > 0 && (
        <div className="flex gap-4 mb-6 text-sm text-[var(--color-muted)]">
          {totalEstMinutes > 0 && <span>~{totalEstMinutes < 60 ? `${totalEstMinutes}m` : `${Math.floor(totalEstMinutes / 60)}h ${totalEstMinutes % 60}m`} remaining</span>}
          {unestimated.length > 0 && <span>{unestimated.length} unestimated</span>}
          {draggedTodo && (
            <span className="text-[var(--color-accent)] font-bold animate-pulse">
              Drag to In Progress to boot agent — drop on Completed to finish
            </span>
          )}
        </div>
      )}

      {loading ? (
        <p className="text-[var(--color-muted)]">Loading...</p>
      ) : counts.total === 0 ? (
        <div className="border border-[var(--color-border)] rounded-lg p-8 text-center">
          <p className="text-[var(--color-muted)] text-lg mb-2">No todos found</p>
          <p className="text-[var(--color-muted)] text-base">Todos are extracted from Claude Code sessions during ingestion.</p>
        </div>
      ) : (
        <>
          {view === 'kanban' ? (
          <div className="grid grid-cols-1 md:grid-cols-3 gap-6 items-start">
            {STATUS_COLUMNS.map(col => {
              const isOver = dragOverColumn === col.key;
              const validDrop = draggedTodo != null && canDropOnColumn(draggedTodo.status, col.key);
              const isPulsed = pulsedColumn === col.key;
              const isCompleted = col.key === 'completed';
              const columnTodos = isCompleted ? recentCompleted : (columns[col.key] ?? []);

              // Insertion gap color — use accent for in_progress
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
                    isOver && validDrop
                      ? 'scale-[1.01]'
                      : isPulsed
                        ? 'column-drop-pulse'
                        : ''
                  }`}
                  style={isOver && validDrop ? { outline: `2px solid ${gapColor}`, outlineOffset: '-2px', borderRadius: '12px' } : undefined}
                >
                  {/* Column header */}
                  <div className="flex items-center gap-2 mb-4 pb-2 border-b-2" style={{ borderBottomColor: col.color }}>
                    <span className="text-lg" style={{ color: col.color }}>{col.icon}</span>
                    <h2 className="font-bold text-sm">{col.label}</h2>
                    {isCompleted && <span className="text-xs text-[var(--color-muted)]">last {COMPLETED_WINDOW_DAYS}d</span>}
                    <span className="text-xs text-[var(--color-muted)] ml-auto tabular-nums">{columnTodos.length}</span>
                  </div>

                  {/* Drop zone at top of column */}
                  {isOver && validDrop && (
                    <div className="mb-2">
                      <InsertionGap color={gapColor} label={gapLabel} />
                    </div>
                  )}

                  {/* Cards — scrollable to prevent layout shift */}
                  <div className="space-y-2 overflow-y-auto max-h-[calc(100vh-220px)] pr-1">
                    {isCompleted ? (
                      completedDays.length === 0 ? (
                        <p className="text-sm text-[var(--color-muted)] text-center py-8 italic">No completions in last {COMPLETED_WINDOW_DAYS} days</p>
                      ) : (
                        completedDays.map(day => (
                          <div key={day}>
                            <div className="text-xs text-[var(--color-muted)] font-bold mb-1.5 mt-2">{day}</div>
                            {completedByDay[day].map(todo => (
                              <CompletedCard key={todo.id} todo={todo} landed={landedCardId === todo.id} />
                            ))}
                          </div>
                        ))
                      )
                    ) : (
                      <>
                        {columnTodos.map((todo) => {
                          const group = byProject.find(g => g.project === todo.projectName);
                          return (
                            <KanbanCard
                              key={todo.id}
                              todo={todo}
                              onUpdate={updateTodo} onDelete={deleteTodo}
                              projectPath={group?.projectPath ?? null}
                              onBoot={bootAgent} booting={booting} bootResult={bootResult}
                              onDragStart={handleDragStart} onDragEnd={handleDragEnd}
                              isDragging={draggedTodo?.id === todo.id}
                              landed={landedCardId === todo.id}
                              meshNodes={meshNodes}
                            />
                          );
                        })}
                        {columnTodos.length === 0 && !validDrop && (
                          <p className="text-sm text-[var(--color-muted)] text-center py-8 italic">Empty</p>
                        )}
                      </>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
          ) : (
          <div className="space-y-4">
            {byProject.map(group => {
              const groupEst = group.todos.filter(t => t.status !== 'completed').reduce((s, t) => s + (t.estimatedMinutes ?? 0), 0);
              return (
                <div key={group.project} className="border border-[var(--color-border)] rounded-lg p-4">
                  <div className="flex items-center gap-2">
                    <Link href={`/projects/${encodeURIComponent(group.project)}`} className="font-medium hover:text-[var(--color-accent)] transition-colors">{group.display}</Link>
                    <span className="text-sm text-[var(--color-muted)]">{group.todos.length} todos</span>
                    {groupEst > 0 && <span className="text-sm text-[var(--color-muted)]">~{groupEst < 60 ? `${groupEst}m` : `${Math.floor(groupEst / 60)}h ${groupEst % 60}m`}</span>}
                    <Link href={`/projects/${encodeURIComponent(group.project)}/kanban`} className="text-xs text-[var(--color-accent)] hover:underline">kanban</Link>
                    {group.projectPath && (
                      <ProjectDeployButton
                        group={group}
                        meshNodes={meshNodes}
                        booting={booting}
                        onBoot={bootAgent}
                      />
                    )}
                  </div>
                  <div className="mt-3 space-y-1">
                    {group.todos.slice(0, 15).map(todo => (
                      <div key={todo.id} className="flex items-center gap-2 text-sm">
                        <StatusDot status={todo.status} />
                        <span className="flex-1 truncate">{todo.content}</span>
                        {todo.estimatedMinutes !== null && <span className={`text-xs shrink-0 ${todo.estimatedMinutes > TICKET_THRESHOLD ? 'text-yellow-400' : 'text-[var(--color-muted)]'}`}>{todo.estimatedMinutes}m</span>}
                        <SourceBadge source={todo.source} />
                        <span className="text-xs text-[var(--color-muted)] shrink-0">{formatRelativeTime(todo.updatedAt)}</span>
                      </div>
                    ))}
                    {group.todos.length > 15 && <p className="text-sm text-[var(--color-muted)]">+{group.todos.length - 15} more</p>}
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

// --- Kanban Card (Pending / In Progress) ---
function KanbanCard({ todo, onUpdate, onDelete, projectPath, onBoot, booting, bootResult, onDragStart, onDragEnd, isDragging, landed, meshNodes }: {
  todo: Todo; onUpdate: (id: number, u: any) => void; onDelete: (id: number) => void;
  projectPath: string | null; onBoot: (p: string, k: string, pr?: string, host?: string, todoIds?: number[], projectName?: string) => void;
  booting: string | null; bootResult: { key: string; msg: string } | null;
  onDragStart: (t: Todo) => void; onDragEnd: () => void; isDragging: boolean; landed: boolean;
  meshNodes: { hostname: string; reachable: boolean }[];
}) {
  const [showEstimate, setShowEstimate] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [editing, setEditing] = useState(false);
  const [editText, setEditText] = useState(todo.content);
  const [showNodePicker, setShowNodePicker] = useState(false);
  const needsTicket = (todo.estimatedMinutes ?? 0) > TICKET_THRESHOLD;
  const bootKey = `todo-${todo.id}`;
  const isActive = todo.status === 'in_progress';

  return (
    <div
      draggable={!editing}
      onDragStart={(e) => {
        // Custom drag image with glow
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
        clone.style.zIndex = '9999';
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
          : isActive ? 'border-blue-400/50 shadow-[0_0_12px_#60a5fa] shadow-lg'
          : 'border-[var(--color-border)] shadow-md hover:border-[var(--color-muted)]'
        }
      `}
    >
      {/* Power indicator for in_progress */}
      {isActive && (
        <div className="flex items-center gap-1.5 mb-2">
          <span className="w-1.5 h-1.5 rounded-full bg-blue-400 animate-pulse" />
          <span className="text-xs font-bold text-blue-400">RUNNING</span>
        </div>
      )}

      {editing ? (
        <textarea
          value={editText}
          onChange={(e) => setEditText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); if (editText.trim() && editText !== todo.content) onUpdate(todo.id, { content: editText.trim() }); setEditing(false); }
            if (e.key === 'Escape') { setEditText(todo.content); setEditing(false); }
          }}
          onBlur={() => { if (editText.trim() && editText !== todo.content) onUpdate(todo.id, { content: editText.trim() }); setEditing(false); }}
          autoFocus
          rows={3}
          className="w-full font-medium mb-2 leading-snug text-sm bg-[var(--color-background)] border border-[var(--color-accent)] rounded px-2 py-1 focus:outline-none resize-y"
          onClick={(e) => e.stopPropagation()}
        />
      ) : (
        <p className="font-medium mb-2 leading-snug cursor-text" onClick={(e) => { e.stopPropagation(); setEditing(true); }}>{todo.content}</p>
      )}

      {todo.attachments && todo.attachments.length > 0 && (
        <div className="flex gap-1.5 mb-2 flex-wrap">
          {todo.attachments.map(a => (
            a.mimeType.startsWith('image/') ? (
              <a key={a.id} href={`/api/todos/attachments/${a.hash}`} target="_blank" rel="noopener" onClick={(e) => e.stopPropagation()}>
                {/* eslint-disable-next-line @next/next/no-img-element -- content-addressed attachment */}
                <img src={`/api/todos/attachments/${a.hash}`} alt={a.filename} className="w-8 h-8 rounded object-cover border border-[var(--color-border)]" />
              </a>
            ) : (
              <a key={a.id} href={`/api/todos/attachments/${a.hash}`} target="_blank" rel="noopener" onClick={(e) => e.stopPropagation()}
                className="text-xs px-1.5 py-0.5 rounded bg-[var(--color-surface-hover)] text-[var(--color-muted)] hover:text-[var(--color-accent)]">
                {a.filename}
              </a>
            )
          ))}
        </div>
      )}

      {/* Estimate */}
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

      {/* Footer */}
      <div className="flex items-center gap-1.5 text-xs text-[var(--color-muted)] flex-wrap">
        <SourceBadge source={todo.source} />
        {todo.sessionDisplay && todo.sessionUuid && todo.projectName && (
          <Link href={`/projects/${encodeURIComponent(todo.projectName)}/${todo.sessionUuid}`} className="hover:text-[var(--color-accent)] truncate max-w-[100px]" onClick={(e) => e.stopPropagation()}>{todo.sessionDisplay}</Link>
        )}
        {projectPath && !isActive && (
          <div className="relative">
            <button onClick={(e) => { e.stopPropagation(); setShowNodePicker(!showNodePicker); }} disabled={booting === bootKey}
              className="px-1.5 py-0.5 text-xs font-bold bg-[var(--color-accent)] text-white rounded hover:opacity-90 disabled:opacity-50 cursor-pointer">
              {booting === bootKey ? '...' : 'Deploy'}
            </button>
            {showNodePicker && (
              <div className="absolute z-50 top-full mt-1 left-0 bg-[var(--color-surface)] border border-[var(--color-border)] rounded-lg shadow-xl py-1 min-w-[140px]" onClick={(e) => e.stopPropagation()}>
                <button
                  onClick={() => { onBoot(projectPath, bootKey, `Work on this task: ${todo.content}`, 'localhost', [todo.id], todo.projectName); setShowNodePicker(false); }}
                  className="w-full text-left px-3 py-1.5 text-xs hover:bg-[var(--color-surface-hover)] flex items-center gap-2 cursor-pointer"
                >
                  <span className="w-1.5 h-1.5 rounded-full bg-green-400" />
                  localhost
                </button>
                {meshNodes.filter(n => n.hostname !== 'localhost').map(n => (
                  <button
                    key={n.hostname}
                    onClick={() => { onBoot(projectPath, bootKey, `Work on this task: ${todo.content}`, n.hostname, [todo.id], todo.projectName); setShowNodePicker(false); }}
                    className="w-full text-left px-3 py-1.5 text-xs hover:bg-[var(--color-surface-hover)] flex items-center gap-2 cursor-pointer"
                  >
                    <span className={`w-1.5 h-1.5 rounded-full ${n.reachable ? 'bg-green-400' : 'bg-red-400'}`} />
                    {n.hostname}
                  </button>
                ))}
              </div>
            )}
          </div>
        )}
        {isActive && todo.tmuxSession && (
          <Link href={`/tmux/${encodeURIComponent(todo.tmuxSession)}`} onClick={(e) => e.stopPropagation()}
            className="px-1.5 py-0.5 text-xs font-bold bg-blue-500 text-white rounded hover:opacity-90">
            Watch
          </Link>
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
          {bootResult.msg.startsWith('tmux: ') ? (
            <Link href={`/tmux/${encodeURIComponent(bootResult.msg.slice(6))}`} className="hover:underline" onClick={(e) => e.stopPropagation()}>
              {bootResult.msg} →
            </Link>
          ) : bootResult.msg}
        </div>
      )}
    </div>
  );
}

// --- Completed card (compact) ---
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

// --- Mega panel ---
function MegaPanel({ megaStatus, onClose }: { megaStatus: any; onClose: () => void }) {
  return (
    <div className="mb-4 border border-[var(--color-border)] rounded-lg p-4 bg-[var(--color-surface)]">
      <div className="flex items-center gap-3 mb-3">
        <h2 className="font-bold text-sm">Agent Fleet</h2>
        {megaStatus.active != null && (
          <>
            <span className="text-xs px-2 py-0.5 rounded bg-green-400/20 text-green-400">{megaStatus.active} alive</span>
            {megaStatus.allDone > 0 && <span className="text-xs px-2 py-0.5 rounded bg-blue-400/20 text-blue-400">{megaStatus.allDone} done</span>}
            {megaStatus.dead > 0 && <span className="text-xs px-2 py-0.5 rounded bg-[var(--color-error)]/20 text-[var(--color-error)]">{megaStatus.dead} dead</span>}
          </>
        )}
        {megaStatus.launched != null && <span className="text-xs px-2 py-0.5 rounded bg-[var(--color-error)]/20 text-[var(--color-error)]">{megaStatus.launched}/{megaStatus.total} launched</span>}
        <button onClick={onClose} className="ml-auto text-[var(--color-muted)] hover:text-[var(--color-foreground)] text-sm cursor-pointer">Close</button>
      </div>
      {megaStatus.results && (
        <div className="space-y-1 text-sm">
          {megaStatus.results.map((r: any, i: number) => (
            <div key={i} className="flex items-center gap-2">
              <span className={`w-2 h-2 rounded-full shrink-0 ${r.status === 'launched' ? 'bg-green-400' : r.status === 'skipped' ? 'bg-yellow-400' : 'bg-[var(--color-error)]'}`} />
              <span className="font-medium">{r.project}</span>
              <span className="text-[var(--color-muted)]">{r.status === 'launched' ? `${r.tmuxSession} (${r.todoCount} todos)` : r.reason}</span>
            </div>
          ))}
        </div>
      )}
      {megaStatus.deployments && (
        <div className="space-y-1 text-sm">
          {megaStatus.deployments.map((d: any) => (
            <div key={d.id} className="flex items-center gap-2">
              <span className={`w-2 h-2 rounded-full shrink-0 ${d.allDone ? 'bg-blue-400' : d.alive ? 'bg-green-400' : 'bg-[var(--color-error)]'}`} />
              <span className="font-medium">{d.project}</span>
              <span className="font-mono text-xs text-[var(--color-muted)]">{d.tmuxSession}</span>
              <span className="text-xs">{d.todosCompleted}/{d.todoCount} done</span>
              {d.allDone && <span className="text-xs text-blue-400">ready to cull</span>}
              {!d.alive && <span className="text-xs text-[var(--color-error)]">dead</span>}
              <span className="text-xs text-[var(--color-muted)] ml-auto">{formatRelativeTime(d.startedAt)}</span>
            </div>
          ))}
          {megaStatus.deployments.length === 0 && <p className="text-[var(--color-muted)]">No active deployments</p>}
        </div>
      )}
      {megaStatus.error && <p className="text-[var(--color-error)] text-sm">{megaStatus.error}</p>}
    </div>
  );
}

// --- Insertion gap for drag target ---
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

// --- Project Deploy Button with node picker ---
function ProjectDeployButton({ group, meshNodes, booting, onBoot }: {
  group: ProjectGroup;
  meshNodes: { hostname: string; reachable: boolean }[];
  booting: string | null;
  onBoot: (p: string, k: string, pr?: string, host?: string, todoIds?: number[], projectName?: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const bootKey = `project-${group.project}`;
  const activeTodos = group.todos.filter(t => t.status !== 'completed');
  const todoIds = activeTodos.slice(0, 10).map(t => t.id);
  const prompt = `Work on the pending todos for this project:\n${activeTodos.slice(0, 10).map(t => `- ${t.content}`).join('\n')}`;

  return (
    <div className="relative ml-auto">
      <button onClick={() => setOpen(!open)} disabled={booting === bootKey}
        className="px-2 py-1 text-xs font-bold bg-[var(--color-accent)] text-white rounded-lg hover:opacity-90 disabled:opacity-50 cursor-pointer">
        {booting === bootKey ? 'Deploying...' : 'Deploy Agent'}
      </button>
      {open && (
        <div className="absolute z-50 top-full mt-1 right-0 bg-[var(--color-surface)] border border-[var(--color-border)] rounded-lg shadow-xl py-1 min-w-[140px]">
          <button onClick={() => { onBoot(group.projectPath!, bootKey, prompt, 'localhost', todoIds, group.project); setOpen(false); }}
            className="w-full text-left px-3 py-1.5 text-xs hover:bg-[var(--color-surface-hover)] flex items-center gap-2 cursor-pointer">
            <span className="w-1.5 h-1.5 rounded-full bg-green-400" /> localhost
          </button>
          {meshNodes.filter(n => n.hostname !== 'localhost').map(n => (
            <button key={n.hostname} onClick={() => { onBoot(group.projectPath!, bootKey, prompt, n.hostname, todoIds, group.project); setOpen(false); }}
              className="w-full text-left px-3 py-1.5 text-xs hover:bg-[var(--color-surface-hover)] flex items-center gap-2 cursor-pointer">
              <span className={`w-1.5 h-1.5 rounded-full ${n.reachable ? 'bg-green-400' : 'bg-red-400'}`} /> {n.hostname}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

// --- Small components ---
function StatusDot({ status }: { status: string }) {
  const colors: Record<string, string> = { pending: '#fbbf24', in_progress: '#60a5fa', completed: '#22c55e' };
  return <span className="w-2 h-2 rounded-full shrink-0" style={{ backgroundColor: colors[status] ?? 'var(--color-muted)' }} />;
}

function SourceBadge({ source }: { source: string }) {
  const badge = SOURCE_BADGE[source] ?? { label: source, color: 'var(--color-muted)' };
  return <span className="px-1.5 py-0.5 rounded text-xs font-medium" style={{ backgroundColor: `${badge.color}22`, color: badge.color }}>{badge.label}</span>;
}
