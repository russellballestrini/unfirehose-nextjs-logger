'use client';

import { useState, useMemo, useCallback, useEffect, useRef } from 'react';
import useSWR from 'swr';
import {
  LineChart,
  Line,
  XAxis,
  YAxis,
  Tooltip,
  ResponsiveContainer,
  CartesianGrid,
  Area,
  ComposedChart,
} from 'recharts';

/* eslint-disable @typescript-eslint/no-explicit-any */

const fetcher = (url: string) => fetch(url).then((r) => r.json());

// ---------- types ----------

interface TrainingRun {
  run_id: string;
  model: string;
  status: 'running' | 'completed' | 'failed';
  latest_step: number | null;
  latest_loss: number | null;
  started_at: string;
  ended_at: string | null;
  wall_ms: number | null;
}

interface TrainingEventRow {
  event_type: string;
  step: number;
  loss: number | null;
  lr: number | null;
  text_content: string | null;
  checkpoint_path: string | null;
  size_bytes: number | null;
  eval_name: string | null;
  eval_score: number | null;
  ts: string;
}

interface RunDetailResponse {
  run: any;
  events: TrainingEventRow[];
  event_counts: Record<string, number>;
}

interface LossPoint {
  step: number;
  loss: number;
}

interface Checkpoint {
  step: number;
  path: string;
  size_bytes: number | null;
}

interface Sample {
  step: number;
  text: string;
  loss: number | null;
}

interface EvalResult {
  step: number;
  eval_name: string;
  score: number;
}

interface InfraSnapshot {
  t: number; // epoch ms
  gpu_util: number;
  gpu_mem_used: number;
  gpu_mem_total: number;
  gpu_power_w: number;
  gpu_power_limit_w: number;
  gpu_temp_c: number;
  cpu_pct: number; // load_1m / cores * 100
  mem_used_gb: number;
  mem_total_gb: number;
  cost_usd: number; // cumulative
}

const COST_PER_KWH = 0.31;

// ---------- helpers ----------

function emaSmooth(data: { step: number; loss: number }[], alpha: number) {
  const out: { step: number; loss: number; ema: number }[] = [];
  let prev = data[0]?.loss ?? 0;
  for (const d of data) {
    prev = alpha * d.loss + (1 - alpha) * prev;
    out.push({ step: d.step, loss: d.loss, ema: prev });
  }
  return out;
}

function formatWallTime(iso: string): string {
  try {
    const d = new Date(iso);
    const now = Date.now();
    const diffMs = now - d.getTime();
    if (diffMs < 60_000) return 'just now';
    if (diffMs < 3_600_000) return `${Math.floor(diffMs / 60_000)}m ago`;
    if (diffMs < 86_400_000) return `${Math.floor(diffMs / 3_600_000)}h ago`;
    return `${Math.floor(diffMs / 86_400_000)}d ago`;
  } catch {
    return iso;
  }
}

const STATUS_COLORS: Record<string, string> = {
  running: '#10b981',
  completed: '#60a5fa',
  failed: '#f87171',
};

// ---------- localStorage run flags ----------

interface RunFlags {
  favorites: Set<string>;
  locked: Set<string>;
}

function loadRunFlags(): RunFlags {
  try {
    const raw = localStorage.getItem('training_run_flags');
    if (raw) {
      const parsed = JSON.parse(raw);
      return {
        favorites: new Set(parsed.favorites ?? []),
        locked: new Set(parsed.locked ?? []),
      };
    }
  } catch { /* ignore */ }
  return { favorites: new Set(), locked: new Set() };
}

function saveRunFlags(flags: RunFlags) {
  localStorage.setItem('training_run_flags', JSON.stringify({
    favorites: [...flags.favorites],
    locked: [...flags.locked],
  }));
}

function useRunFlags() {
  const [flags, setFlags] = useState<RunFlags>({ favorites: new Set(), locked: new Set() });

  useEffect(() => {
    setFlags(loadRunFlags());
  }, []);

  const toggle = useCallback((runId: string, field: 'favorites' | 'locked') => {
    setFlags((prev) => {
      const next = {
        favorites: new Set(prev.favorites),
        locked: new Set(prev.locked),
      };
      if (next[field].has(runId)) next[field].delete(runId);
      else next[field].add(runId);
      saveRunFlags(next);
      return next;
    });
  }, []);

  return { flags, toggle };
}

// ---------- components ----------

function StatusBadge({ status }: { status: string }) {
  const color = STATUS_COLORS[status] ?? '#6b7280';
  return (
    <span
      className="inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium"
      style={{ backgroundColor: `${color}22`, color }}
    >
      {status === 'running' && (
        <span className="relative flex h-2 w-2">
          <span className="absolute inline-flex h-full w-full animate-ping rounded-full opacity-75" style={{ backgroundColor: color }} />
          <span className="relative inline-flex h-2 w-2 rounded-full" style={{ backgroundColor: color }} />
        </span>
      )}
      {status}
    </span>
  );
}

function EmptyState({ onScan, scanning, scanResult }: { onScan: () => void; scanning: boolean; scanResult: any }) {
  return (
    <div className="flex flex-1 items-center justify-center p-12">
      <div className="max-w-lg text-center" style={{ color: 'var(--color-muted)' }}>
        <div className="mb-4 text-4xl">{'{ }'}</div>
        <h2 className="mb-2 text-lg font-semibold" style={{ color: 'var(--color-foreground)' }}>
          No training runs yet
        </h2>
        <p className="mb-6 text-sm leading-relaxed">
          Scan local and remote nodes for training data, or POST events directly.
        </p>

        <button
          onClick={onScan}
          disabled={scanning}
          className="mb-6 rounded-lg px-6 py-3 font-mono text-sm font-semibold transition-colors cursor-pointer disabled:opacity-50"
          style={{
            backgroundColor: 'var(--color-accent)',
            color: 'var(--color-background)',
          }}
        >
          {scanning ? 'Scanning nodes...' : 'Scan for training data'}
        </button>

        {scanResult && !scanResult.error && (
          <div className="mb-6 rounded-lg p-4 text-left font-mono text-xs" style={{ backgroundColor: 'var(--color-surface)', border: '1px solid var(--color-border)' }}>
            <div style={{ color: 'var(--color-foreground)' }}>
              Scanned {scanResult.scanned} node{scanResult.scanned !== 1 ? 's' : ''} — found {scanResult.total_files} file{scanResult.total_files !== 1 ? 's' : ''}
            </div>
            {scanResult.total_events_ingested > 0 && (
              <div style={{ color: '#10b981' }} className="mt-1">
                Ingested {scanResult.total_events_ingested} events across {scanResult.total_runs} run{scanResult.total_runs !== 1 ? 's' : ''}
              </div>
            )}
            {scanResult.results?.map((r: any, i: number) => (
              r.files?.length > 0 && (
                <div key={i} className="mt-2" style={{ color: 'var(--color-muted)' }}>
                  <span style={{ color: 'var(--color-foreground)' }}>{r.host}</span>: {r.files.map((f: any) => f.model).join(', ')}
                </div>
              )
            ))}
          </div>
        )}

        {scanResult?.error && (
          <div className="mb-6 rounded-lg p-3 text-left font-mono text-xs" style={{ backgroundColor: '#991b1b22', color: '#f87171', border: '1px solid #991b1b' }}>
            {scanResult.error}
          </div>
        )}

        <p className="text-xs mb-3" style={{ color: 'var(--color-muted)' }}>
          Scans configured paths + live training proxies on all mesh nodes. Paths configurable in Settings → Training.
        </p>

        <details className="text-left">
          <summary className="cursor-pointer text-xs mb-2" style={{ color: 'var(--color-muted)' }}>Manual ingestion via API</summary>
          <pre
            className="rounded-lg p-4 font-mono text-xs leading-relaxed"
            style={{ backgroundColor: 'var(--color-surface)', color: 'var(--color-foreground)', border: '1px solid var(--color-border)' }}
          >
{`curl -X POST localhost:3000/api/training \\
  -H 'Content-Type: application/json' \\
  -d '{"type":"run.loss","run_id":"run-001",
       "model":"llama-3","step":100,"loss":2.34,
       "ts":"2026-03-09T00:01:00Z"}'`}
          </pre>
        </details>
      </div>
    </div>
  );
}

function RunsList({
  runs,
  selectedId,
  onSelect,
  flags,
  onToggleFlag,
  onDelete,
}: {
  runs: TrainingRun[];
  selectedId: string | null;
  onSelect: (id: string) => void;
  flags: RunFlags;
  onToggleFlag: (runId: string, field: 'favorites' | 'locked') => void;
  onDelete: (runId: string) => void;
}) {
  const [pendingDelete, setPendingDelete] = useState<string | null>(null);

  // Auto-clear pending delete after 3s
  useEffect(() => {
    if (!pendingDelete) return;
    const t = setTimeout(() => setPendingDelete(null), 3000);
    return () => clearTimeout(t);
  }, [pendingDelete]);

  // Sort: favorites first, then by started_at (already desc from API)
  const sorted = useMemo(() => {
    return [...runs].sort((a, b) => {
      const af = flags.favorites.has(a.run_id) ? 0 : 1;
      const bf = flags.favorites.has(b.run_id) ? 0 : 1;
      if (af !== bf) return af - bf;
      return 0; // preserve original order within same group
    });
  }, [runs, flags.favorites]);

  return (
    <div className="flex flex-col gap-1">
      {sorted.map((run) => {
        const active = run.run_id === selectedId;
        const isFav = flags.favorites.has(run.run_id);
        const isLocked = flags.locked.has(run.run_id);
        return (
          <div
            key={run.run_id}
            className="relative rounded-lg transition-colors"
            style={{
              backgroundColor: active ? 'var(--color-surface)' : 'transparent',
              border: active ? '1px solid var(--color-border)' : '1px solid transparent',
            }}
          >
            <button
              onClick={() => onSelect(run.run_id)}
              className="w-full px-3 py-2.5 text-left"
            >
              <div className="flex items-center justify-between gap-2">
                <span className="truncate font-mono text-sm font-medium" style={{ color: 'var(--color-foreground)' }}>
                  {run.model}
                </span>
                <StatusBadge status={run.status} />
              </div>
              <div className="mt-1 flex items-center gap-3 font-mono text-xs" style={{ color: 'var(--color-muted)' }}>
                {run.latest_step != null && <span>step {run.latest_step.toLocaleString()}</span>}
                {run.latest_loss != null && <span>loss {run.latest_loss.toFixed(4)}</span>}
                <span className="ml-auto">{formatWallTime(run.started_at)}</span>
              </div>
              <div className="mt-0.5 flex items-center gap-1 font-mono text-xs" style={{ color: 'var(--color-muted)', opacity: 0.6 }}>
                <span className="truncate flex-1">{run.run_id}</span>
              </div>
            </button>
            {/* Always-visible action buttons */}
            <div className="flex items-center gap-0.5 px-3 pb-2 -mt-1">
              <button
                onClick={(e) => { e.stopPropagation(); onToggleFlag(run.run_id, 'favorites'); }}
                className="w-6 h-6 flex items-center justify-center rounded text-xs transition-colors"
                title={isFav ? 'Unfavorite' : 'Favorite'}
                style={{ color: isFav ? '#fbbf24' : 'var(--color-muted)', opacity: isFav ? 1 : 0.4 }}
              >
                {isFav ? '★' : '☆'}
              </button>
              <button
                onClick={(e) => { e.stopPropagation(); onToggleFlag(run.run_id, 'locked'); }}
                className="w-6 h-6 flex items-center justify-center rounded text-xs transition-colors"
                title={isLocked ? 'Unlock (allow deletion)' : 'Lock (prevent deletion)'}
                style={{ color: isLocked ? '#60a5fa' : 'var(--color-muted)', opacity: isLocked ? 1 : 0.4 }}
              >
                {isLocked ? '🔒' : '🔓'}
              </button>
              {pendingDelete === run.run_id ? (
                <button
                  onClick={(e) => { e.stopPropagation(); setPendingDelete(null); onDelete(run.run_id); }}
                  className="h-6 px-1.5 flex items-center justify-center rounded text-xs font-bold transition-colors"
                  style={{ color: '#fff', backgroundColor: '#ef4444' }}
                >
                  confirm?
                </button>
              ) : (
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    if (isLocked) return;
                    setPendingDelete(run.run_id);
                  }}
                  className="w-6 h-6 flex items-center justify-center rounded text-xs transition-colors"
                  title={isLocked ? 'Locked — unlock first' : 'Delete run'}
                  style={{ color: isLocked ? 'var(--color-muted)' : '#ef4444', opacity: isLocked ? 0.2 : 0.4 }}
                >
                  ✕
                </button>
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
}

function LossCurve({ data, showEma }: { data: LossPoint[]; showEma: boolean }) {
  const chartData = useMemo(() => {
    if (!data?.length) return [];
    return emaSmooth(
      data.map((d) => ({ step: d.step, loss: d.loss })),
      0.1
    );
  }, [data]);

  if (!chartData.length) {
    return (
      <div className="flex h-80 items-center justify-center font-mono text-sm" style={{ color: 'var(--color-muted)' }}>
        No loss data recorded yet
      </div>
    );
  }

  return (
    <ResponsiveContainer width="100%" height={360}>
      <LineChart data={chartData} margin={{ top: 8, right: 16, bottom: 8, left: 8 }}>
        <CartesianGrid strokeDasharray="3 3" stroke="#333" />
        <XAxis
          dataKey="step"
          stroke="#737373"
          tick={{ fill: '#737373', fontSize: 12 }}
          tickFormatter={(v: number) => v.toLocaleString()}
        />
        <YAxis
          stroke="#737373"
          tick={{ fill: '#737373', fontSize: 12 }}
          tickFormatter={(v: number) => v.toFixed(2)}
        />
        <Tooltip
          contentStyle={{
            backgroundColor: '#1a1a1a',
            border: '1px solid #333',
            borderRadius: '8px',
            fontFamily: 'monospace',
            fontSize: '12px',
          }}
          labelStyle={{ color: '#a3a3a3' }}
          itemStyle={{ color: '#e5e5e5' }}
          labelFormatter={(v: any) => `Step ${Number(v).toLocaleString()}`}
          formatter={(value: any, name: any) => [Number(value).toFixed(6), name === 'ema' ? 'EMA' : 'Loss']}
        />
        <Line
          type="monotone"
          dataKey="loss"
          stroke={showEma ? '#60a5fa33' : '#60a5fa'}
          strokeWidth={showEma ? 1 : 2}
          dot={false}
          isAnimationActive={false}
        />
        {showEma && (
          <Line
            type="monotone"
            dataKey="ema"
            stroke="#60a5fa"
            strokeWidth={2.5}
            dot={false}
            isAnimationActive={false}
          />
        )}
      </LineChart>
    </ResponsiveContainer>
  );
}

const OVERLAY_COLORS = ['#60a5fa', '#f87171', '#10b981', '#fbbf24', '#a78bfa', '#f472b6', '#22d3ee', '#fb923c'];

function FavoritesChart({ data, showEma, runs }: { data: Record<string, LossPoint[]>; showEma: boolean; runs: TrainingRun[] }) {
  const chartData = useMemo(() => {
    const entries = Object.entries(data);
    if (!entries.length) return [];

    // Merge all runs into step-indexed rows
    const stepMap = new Map<number, Record<string, number>>();
    for (const [runId, points] of entries) {
      let ema = points[0]?.loss ?? 0;
      for (const p of points) {
        ema = 0.1 * p.loss + 0.9 * ema;
        const row = stepMap.get(p.step) ?? { step: p.step };
        row[`${runId}_loss`] = p.loss;
        row[`${runId}_ema`] = ema;
        stepMap.set(p.step, row);
      }
    }
    return [...stepMap.values()].sort((a, b) => a.step - b.step);
  }, [data]);

  const runIds = Object.keys(data);
  const runLabel = (id: string) => runs.find(r => r.run_id === id)?.model ?? id;

  if (!chartData.length) {
    return (
      <div className="flex h-80 items-center justify-center font-mono text-sm" style={{ color: 'var(--color-muted)' }}>
        Star some runs to compare their loss curves
      </div>
    );
  }

  return (
    <ResponsiveContainer width="100%" height={400}>
      <LineChart data={chartData} margin={{ top: 8, right: 16, bottom: 8, left: 8 }}>
        <CartesianGrid strokeDasharray="3 3" stroke="#333" />
        <XAxis
          dataKey="step"
          stroke="#737373"
          tick={{ fill: '#737373', fontSize: 12 }}
          tickFormatter={(v: number) => v.toLocaleString()}
        />
        <YAxis
          stroke="#737373"
          tick={{ fill: '#737373', fontSize: 12 }}
          tickFormatter={(v: number) => v.toFixed(2)}
        />
        <Tooltip
          contentStyle={{
            backgroundColor: '#1a1a1a',
            border: '1px solid #333',
            borderRadius: '8px',
            fontFamily: 'monospace',
            fontSize: '12px',
          }}
          labelStyle={{ color: '#a3a3a3' }}
          labelFormatter={(v: any) => `Step ${Number(v).toLocaleString()}`}
          formatter={(value: any, name: any) => {
            const id = name.replace(/_loss$|_ema$/, '');
            const isEma = name.endsWith('_ema');
            return [Number(value).toFixed(6), `${runLabel(id)}${isEma ? ' EMA' : ''}`];
          }}
        />
        {runIds.map((id, i) => {
          const color = OVERLAY_COLORS[i % OVERLAY_COLORS.length];
          return showEma ? (
            <Line key={`${id}_ema`} type="monotone" dataKey={`${id}_ema`} stroke={color} strokeWidth={2} dot={false} isAnimationActive={false} name={`${id}_ema`} connectNulls />
          ) : (
            <Line key={`${id}_loss`} type="monotone" dataKey={`${id}_loss`} stroke={color} strokeWidth={1.5} dot={false} isAnimationActive={false} name={`${id}_loss`} connectNulls />
          );
        })}
        {showEma && runIds.map((id, i) => {
          const color = OVERLAY_COLORS[i % OVERLAY_COLORS.length];
          return (
            <Line key={`${id}_loss_dim`} type="monotone" dataKey={`${id}_loss`} stroke={`${color}33`} strokeWidth={1} dot={false} isAnimationActive={false} name={`${id}_loss`} connectNulls />
          );
        })}
      </LineChart>
    </ResponsiveContainer>
  );
}

// ---------- infra chart ----------

function useInfraHistory(host: string | null, active: boolean) {
  const history = useRef<InfraSnapshot[]>([]);
  const cumCost = useRef(0);
  const [data, setData] = useState<InfraSnapshot[]>([]);

  useEffect(() => {
    if (!host || !active) return;
    let mounted = true;
    const poll = async () => {
      try {
        const res = await fetch(`/api/training/system?host=${encodeURIComponent(host)}`);
        if (!res.ok) return;
        const s = await res.json();
        const now = Date.now();
        // Incremental cost: power_w * interval_hours * $/kWh / 1000
        const lastT = history.current.length > 0 ? history.current[history.current.length - 1].t : now - 5000;
        const hoursElapsed = (now - lastT) / 3_600_000;
        cumCost.current += (s.gpu_power_w ?? 0) * hoursElapsed * COST_PER_KWH / 1000;
        const cpuCores = s.cpu_cores || 1;
        const snap: InfraSnapshot = {
          t: now,
          gpu_util: s.gpu_util ?? 0,
          gpu_mem_used: s.gpu_mem_used ?? 0,
          gpu_mem_total: s.gpu_mem_total ?? 1,
          gpu_power_w: s.gpu_power_w ?? 0,
          gpu_power_limit_w: s.gpu_power_limit_w ?? 1,
          gpu_temp_c: s.gpu_temp_c ?? 0,
          cpu_pct: Math.min(100, ((s.cpu_load_1m ?? 0) / cpuCores) * 100),
          mem_used_gb: (s.mem_used ?? 0) / 1073741824,
          mem_total_gb: (s.mem_total ?? 1) / 1073741824,
          cost_usd: cumCost.current,
        };
        history.current.push(snap);
        // Keep last 720 points (~1hr at 5s intervals)
        if (history.current.length > 720) history.current = history.current.slice(-720);
        if (mounted) setData([...history.current]);
      } catch { /* proxy down */ }
    };
    poll();
    const iv = setInterval(poll, 5000);
    return () => { mounted = false; clearInterval(iv); };
  }, [host, active]);

  return data;
}

const INFRA_COLORS = {
  gpuUtil: '#10b981',   // green
  cpuUtil: '#60a5fa',   // blue
  power: '#f59e0b',     // amber
  gpuTemp: '#ef4444',   // red
  vram: '#8b5cf6',      // purple
  mem: '#6366f1',       // indigo
};

function InfraChart({ data }: { data: InfraSnapshot[] }) {
  if (data.length === 0) {
    return (
      <div className="py-12 text-center font-mono text-sm" style={{ color: 'var(--color-muted)' }}>
        Waiting for system data...
      </div>
    );
  }

  const latest = data[data.length - 1];
  const vramPct = (latest.gpu_mem_used / latest.gpu_mem_total) * 100;
  const vramGb = latest.gpu_mem_used / 1073741824;
  const vramTotalGb = latest.gpu_mem_total / 1073741824;
  const powerPct = (latest.gpu_power_w / latest.gpu_power_limit_w) * 100;

  // Chart data: normalize everything to percentages for left axis, power in watts for right
  const chartData = data.map((s) => ({
    t: s.t,
    label: new Date(s.t).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' }),
    gpu: s.gpu_util,
    cpu: s.cpu_pct,
    vram: (s.gpu_mem_used / s.gpu_mem_total) * 100,
    mem: (s.mem_used_gb / s.mem_total_gb) * 100,
    power: s.gpu_power_w,
    temp: s.gpu_temp_c,
  }));

  return (
    <div className="flex flex-col gap-4">
      {/* Stats bar */}
      <div className="grid grid-cols-3 gap-3 sm:grid-cols-6">
        {[
          { label: 'GPU', value: `${latest.gpu_util.toFixed(0)}%`, color: INFRA_COLORS.gpuUtil },
          { label: 'CPU', value: `${latest.cpu_pct.toFixed(0)}%`, color: INFRA_COLORS.cpuUtil },
          { label: 'Power', value: `${latest.gpu_power_w.toFixed(0)}W`, color: INFRA_COLORS.power },
          { label: 'Temp', value: `${latest.gpu_temp_c.toFixed(0)}°C`, color: INFRA_COLORS.gpuTemp },
          { label: 'VRAM', value: `${vramGb.toFixed(1)}/${vramTotalGb.toFixed(0)}G`, color: INFRA_COLORS.vram },
          { label: 'Cost', value: `$${latest.cost_usd.toFixed(4)}`, color: '#fbbf24' },
        ].map(({ label, value, color }) => (
          <div
            key={label}
            className="rounded-lg px-3 py-2 text-center"
            style={{ backgroundColor: 'var(--color-background)', border: '1px solid var(--color-border)' }}
          >
            <div className="font-mono text-xs" style={{ color: 'var(--color-muted)' }}>{label}</div>
            <div className="font-mono text-sm font-bold" style={{ color }}>{value}</div>
          </div>
        ))}
      </div>

      {/* Utilization chart (%, left axis) */}
      <div>
        <div className="mb-1 font-mono text-xs" style={{ color: 'var(--color-muted)' }}>Utilization</div>
        <ResponsiveContainer width="100%" height={200}>
          <ComposedChart data={chartData} margin={{ top: 5, right: 10, bottom: 5, left: 0 }}>
            <CartesianGrid strokeDasharray="3 3" stroke="var(--color-border)" strokeOpacity={0.3} />
            <XAxis dataKey="label" tick={{ fontSize: 10, fill: 'var(--color-muted)' }} interval="preserveStartEnd" />
            <YAxis domain={[0, 100]} tick={{ fontSize: 10, fill: 'var(--color-muted)' }} tickFormatter={(v: number) => `${v}%`} width={40} />
            <Tooltip
              contentStyle={{ backgroundColor: 'var(--color-surface)', border: '1px solid var(--color-border)', borderRadius: 6, fontSize: 12 }}
              labelStyle={{ color: 'var(--color-foreground)', fontWeight: 600 }}
              formatter={(v: any, name: any) => [`${Number(v).toFixed(1)}%`, String(name).toUpperCase()]}
            />
            <Area type="monotone" dataKey="vram" fill={`${INFRA_COLORS.vram}20`} stroke={INFRA_COLORS.vram} strokeWidth={1} dot={false} isAnimationActive={false} name="vram" />
            <Area type="monotone" dataKey="mem" fill={`${INFRA_COLORS.mem}15`} stroke={INFRA_COLORS.mem} strokeWidth={1} dot={false} isAnimationActive={false} name="mem" />
            <Line type="monotone" dataKey="gpu" stroke={INFRA_COLORS.gpuUtil} strokeWidth={2} dot={false} isAnimationActive={false} name="gpu" />
            <Line type="monotone" dataKey="cpu" stroke={INFRA_COLORS.cpuUtil} strokeWidth={2} dot={false} isAnimationActive={false} name="cpu" />
          </ComposedChart>
        </ResponsiveContainer>
      </div>

      {/* Power & temp chart */}
      <div>
        <div className="mb-1 font-mono text-xs" style={{ color: 'var(--color-muted)' }}>Power &amp; Temperature</div>
        <ResponsiveContainer width="100%" height={160}>
          <ComposedChart data={chartData} margin={{ top: 5, right: 10, bottom: 5, left: 0 }}>
            <CartesianGrid strokeDasharray="3 3" stroke="var(--color-border)" strokeOpacity={0.3} />
            <XAxis dataKey="label" tick={{ fontSize: 10, fill: 'var(--color-muted)' }} interval="preserveStartEnd" />
            <YAxis yAxisId="power" tick={{ fontSize: 10, fill: 'var(--color-muted)' }} tickFormatter={(v: number) => `${v}W`} width={45} />
            <YAxis yAxisId="temp" orientation="right" tick={{ fontSize: 10, fill: 'var(--color-muted)' }} tickFormatter={(v: number) => `${v}°`} width={35} />
            <Tooltip
              contentStyle={{ backgroundColor: 'var(--color-surface)', border: '1px solid var(--color-border)', borderRadius: 6, fontSize: 12 }}
              labelStyle={{ color: 'var(--color-foreground)', fontWeight: 600 }}
              formatter={(v: any, name: any) => [name === 'temp' ? `${Number(v).toFixed(0)}°C` : `${Number(v).toFixed(0)}W`, name === 'temp' ? 'Temp' : 'Power']}
            />
            <Area type="monotone" dataKey="power" yAxisId="power" fill={`${INFRA_COLORS.power}20`} stroke={INFRA_COLORS.power} strokeWidth={2} dot={false} isAnimationActive={false} name="power" />
            <Line type="monotone" dataKey="temp" yAxisId="temp" stroke={INFRA_COLORS.gpuTemp} strokeWidth={2} dot={false} isAnimationActive={false} name="temp" />
          </ComposedChart>
        </ResponsiveContainer>
      </div>

      {/* Power efficiency bar */}
      <div className="flex items-center gap-3 font-mono text-xs" style={{ color: 'var(--color-muted)' }}>
        <span>Power: {latest.gpu_power_w.toFixed(0)}W / {latest.gpu_power_limit_w.toFixed(0)}W</span>
        <div className="flex-1 h-2 rounded-full overflow-hidden" style={{ backgroundColor: 'var(--color-background)' }}>
          <div
            className="h-full rounded-full transition-all"
            style={{ width: `${Math.min(100, powerPct)}%`, backgroundColor: powerPct > 90 ? INFRA_COLORS.gpuTemp : INFRA_COLORS.power }}
          />
        </div>
        <span>VRAM: {vramPct.toFixed(0)}%</span>
        <div className="w-24 h-2 rounded-full overflow-hidden" style={{ backgroundColor: 'var(--color-background)' }}>
          <div
            className="h-full rounded-full transition-all"
            style={{ width: `${Math.min(100, vramPct)}%`, backgroundColor: vramPct > 90 ? INFRA_COLORS.gpuTemp : INFRA_COLORS.vram }}
          />
        </div>
      </div>
    </div>
  );
}

// ---------- page ----------

export default function TrainingPage() {
  const [selectedRunId, setSelectedRunId] = useState<string | null>(null);
  const [showEma, setShowEma] = useState(true);
  const [activeTab, setActiveTab] = useState<'favorites' | 'loss' | 'checkpoints' | 'samples' | 'evals' | 'infra'>('favorites');
  const [scanning, setScanning] = useState(false);
  const [scanResult, setScanResult] = useState<any>(null);
  const { flags, toggle: toggleFlag } = useRunFlags();

  // Training settings
  const { data: settings } = useSWR('/api/settings', fetcher);
  const deleteSourceDefault = settings?.training_delete_source === 'true';
  const autoScan = settings?.training_auto_scan === 'true';

  // Runs list — polls every 5s for live updates
  const { data: runsData, mutate: mutateRuns } = useSWR<{ runs: TrainingRun[] }>(
    '/api/training',
    fetcher,
    { refreshInterval: 5000 }
  );

  const runs = runsData?.runs ?? [];

  // Auto-select first run if none selected
  const activeRunId = selectedRunId ?? runs[0]?.run_id ?? null;

  // Run detail — fetches loss events, checkpoints, samples, evals
  const { data: detailRaw } = useSWR<RunDetailResponse>(
    activeRunId ? `/api/training?run_id=${activeRunId}` : null,
    fetcher,
    { refreshInterval: 5000 }
  );

  // Parse flat events array into categorized arrays
  const detail = useMemo(() => {
    if (!detailRaw?.events) return null;
    const lossEvents: LossPoint[] = [];
    const checkpoints: Checkpoint[] = [];
    const samples: Sample[] = [];
    const evals: EvalResult[] = [];
    for (const ev of detailRaw.events) {
      const t = ev.event_type;
      if ((t === 'loss' || t === 'run.loss') && ev.loss != null) {
        lossEvents.push({ step: ev.step, loss: ev.loss });
      } else if (t === 'checkpoint' || t === 'run.checkpoint') {
        checkpoints.push({ step: ev.step, path: ev.checkpoint_path ?? '', size_bytes: ev.size_bytes });
      } else if (t === 'sample' || t === 'run.sample') {
        samples.push({ step: ev.step, text: ev.text_content ?? '', loss: ev.loss });
      } else if (t === 'eval' || t === 'run.eval') {
        evals.push({ step: ev.step, eval_name: ev.eval_name ?? '', score: ev.eval_score ?? 0 });
      }
    }
    return { lossEvents, checkpoints, samples, evals };
  }, [detailRaw]);

  // Infra monitoring — poll /system on the active run's host
  const activeRunHost = detailRaw?.run?.source_host ?? null;
  const infraData = useInfraHistory(activeRunHost, activeTab === 'infra');

  // Fetch loss data for all favorited runs (for overlay chart)
  const favRunIds = useMemo(() => [...flags.favorites].sort(), [flags.favorites]);
  const { data: favData } = useSWR<Record<string, LossPoint[]>>(
    favRunIds.length > 0 ? `/api/training/favorites?ids=${favRunIds.map(encodeURIComponent).join(',')}` : null,
    async (url: string) => {
      // Fetch each run's events in parallel
      const results: Record<string, LossPoint[]> = {};
      await Promise.all(favRunIds.map(async (id) => {
        try {
          const res = await fetch(`/api/training?run_id=${encodeURIComponent(id)}`);
          const data = await res.json();
          if (data?.events) {
            results[id] = data.events
              .filter((ev: any) => (ev.event_type === 'loss' || ev.event_type === 'run.loss') && ev.loss != null)
              .map((ev: any) => ({ step: ev.step, loss: ev.loss }));
          }
        } catch { /* skip */ }
      }));
      return results;
    },
    { refreshInterval: 10000 }
  );

  const runScan = useCallback(async () => {
    setScanning(true);
    setScanResult(null);
    try {
      const res = await fetch('/api/training/scan');
      const data = await res.json();
      setScanResult(data);
      mutateRuns();
    } catch (e: any) {
      setScanResult({ error: e.message });
    } finally {
      setScanning(false);
    }
  }, [mutateRuns]);

  const deleteRun = useCallback(async (runId: string) => {
    try {
      const params = new URLSearchParams({ run_id: runId });
      if (deleteSourceDefault) params.set('delete_source', 'true');
      const res = await fetch(`/api/training?${params}`, { method: 'DELETE' });
      const data = await res.json();
      if (data.ok) {
        mutateRuns();
        if (selectedRunId === runId) setSelectedRunId(null);
      }
    } catch { /* ignore */ }
  }, [mutateRuns, selectedRunId, deleteSourceDefault]);

  // Auto-scan on page load if enabled in settings
  const autoScanned = useRef(false);
  useEffect(() => {
    if (autoScan && !autoScanned.current && runsData) {
      autoScanned.current = true;
      runScan();
    }
  }, [autoScan, runsData, runScan]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!runs.length && !runsData) {
    return (
      <div className="flex h-full items-center justify-center" style={{ color: 'var(--color-muted)' }}>
        <span className="font-mono text-sm">Loading...</span>
      </div>
    );
  }

  if (!runs.length) {
    return <EmptyState onScan={runScan} scanning={scanning} scanResult={scanResult} />;
  }

  return (
    <div className="flex h-full gap-4 p-4">
      {/* Left panel — runs list */}
      <div
        className="w-72 shrink-0 overflow-y-auto rounded-xl p-3"
        style={{ backgroundColor: 'var(--color-surface)', border: '1px solid var(--color-border)' }}
      >
        <div className="mb-3 flex items-center justify-between">
          <h2 className="font-mono text-xs font-semibold uppercase tracking-wider" style={{ color: 'var(--color-muted)' }}>
            Runs ({runs.length})
          </h2>
          <button
            onClick={runScan}
            disabled={scanning}
            className="rounded px-2 py-1 font-mono text-xs transition-colors cursor-pointer disabled:opacity-50"
            style={{ color: 'var(--color-accent)', border: '1px solid var(--color-border)' }}
            title="Scan local and remote nodes for training data"
          >
            {scanning ? '...' : 'Scan'}
          </button>
        </div>
        <RunsList runs={runs} selectedId={activeRunId} onSelect={setSelectedRunId} flags={flags} onToggleFlag={toggleFlag} onDelete={deleteRun} />
      </div>

      {/* Main area */}
      <div className="flex min-w-0 flex-1 flex-col gap-4 overflow-y-auto">
        {/* Tabs */}
        <div className="flex items-center gap-1">
          {([
            ['favorites', '★ Favorites', favRunIds.length],
            ['loss', 'Loss', detail?.lossEvents?.length ?? 0],
            ['checkpoints', 'Checkpoints', detail?.checkpoints?.length ?? 0],
            ['samples', 'Samples', detail?.samples?.length ?? 0],
            ['evals', 'Evals', detail?.evals?.length ?? 0],
            ['infra', 'Infra', infraData.length],
          ] as const).map(([key, label, count]) => (
            <button
              key={key}
              onClick={() => setActiveTab(key as typeof activeTab)}
              className="flex items-center gap-2 rounded-lg px-4 py-2 font-mono text-sm transition-colors cursor-pointer"
              style={{
                backgroundColor: activeTab === key ? 'var(--color-surface)' : 'transparent',
                color: activeTab === key ? 'var(--color-foreground)' : 'var(--color-muted)',
                border: activeTab === key ? '1px solid var(--color-border)' : '1px solid transparent',
                fontWeight: activeTab === key ? 600 : 400,
              }}
            >
              {label}
              {count > 0 && (
                <span className="rounded-full px-1.5 py-0.5 text-xs" style={{
                  backgroundColor: activeTab === key ? 'var(--color-accent)' : 'var(--color-border)',
                  color: activeTab === key ? 'var(--color-background)' : 'var(--color-muted)',
                }}>
                  {count.toLocaleString()}
                </span>
              )}
            </button>
          ))}
        </div>

        {/* Tab content */}
        <div
          className="flex-1 rounded-xl p-4"
          style={{ backgroundColor: 'var(--color-surface)', border: '1px solid var(--color-border)' }}
        >
          {activeTab === 'favorites' && (
            <>
              <div className="mb-3 flex items-center justify-between">
                <h2 className="font-mono text-sm font-semibold" style={{ color: 'var(--color-foreground)' }}>
                  Favorites — Loss Comparison
                </h2>
                <div className="flex items-center gap-4">
                  {favRunIds.length > 0 && (
                    <div className="flex items-center gap-2 flex-wrap">
                      {favRunIds.map((id, i) => (
                        <span key={id} className="flex items-center gap-1 font-mono text-xs">
                          <span className="inline-block w-3 h-0.5 rounded" style={{ backgroundColor: OVERLAY_COLORS[i % OVERLAY_COLORS.length] }} />
                          <span style={{ color: 'var(--color-muted)' }}>{runs.find(r => r.run_id === id)?.model ?? id}</span>
                        </span>
                      ))}
                    </div>
                  )}
                  <label className="flex cursor-pointer items-center gap-2 font-mono text-xs shrink-0" style={{ color: 'var(--color-muted)' }}>
                    <input
                      type="checkbox"
                      checked={showEma}
                      onChange={(e) => setShowEma(e.target.checked)}
                      className="accent-blue-500"
                    />
                    EMA
                  </label>
                </div>
              </div>
              <FavoritesChart data={favData ?? {}} showEma={showEma} runs={runs} />
            </>
          )}

          {activeTab === 'loss' && (
            <>
              <div className="mb-3 flex items-center justify-between">
                <h2 className="font-mono text-sm font-semibold" style={{ color: 'var(--color-foreground)' }}>
                  Loss Curve
                </h2>
                <label className="flex cursor-pointer items-center gap-2 font-mono text-xs" style={{ color: 'var(--color-muted)' }}>
                  <input
                    type="checkbox"
                    checked={showEma}
                    onChange={(e) => setShowEma(e.target.checked)}
                    className="accent-blue-500"
                  />
                  EMA smoothing (alpha=0.1)
                </label>
              </div>
              <LossCurve data={detail?.lossEvents ?? []} showEma={showEma} />
            </>
          )}

          {activeTab === 'checkpoints' && (
            detail?.checkpoints?.length ? (
              <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
                {detail.checkpoints.map((cp, i) => (
                  <div
                    key={i}
                    className="rounded-lg p-3"
                    style={{ backgroundColor: 'var(--color-background)', border: '1px solid var(--color-border)' }}
                  >
                    <div className="flex items-center justify-between">
                      <span className="font-mono text-xs font-medium" style={{ color: '#10b981' }}>
                        Step {cp.step.toLocaleString()}
                      </span>
                      {cp.size_bytes != null && (
                        <span className="font-mono text-xs" style={{ color: 'var(--color-muted)' }}>
                          {(cp.size_bytes / 1024 / 1024).toFixed(1)} MB
                        </span>
                      )}
                    </div>
                    <div className="mt-1 truncate font-mono text-xs" style={{ color: 'var(--color-muted)' }} title={cp.path}>
                      {cp.path}
                    </div>
                  </div>
                ))}
              </div>
            ) : (
              <div className="py-12 text-center font-mono text-sm" style={{ color: 'var(--color-muted)' }}>
                No checkpoints recorded
              </div>
            )
          )}

          {activeTab === 'samples' && (
            detail?.samples?.length ? (
              <div className="grid gap-2 lg:grid-cols-2">
                {detail.samples.map((s, i) => (
                  <div
                    key={i}
                    className="rounded-lg p-3"
                    style={{ backgroundColor: 'var(--color-background)', border: '1px solid var(--color-border)' }}
                  >
                    <div className="mb-1 flex items-center gap-3">
                      <span className="font-mono text-xs font-medium" style={{ color: '#fbbf24' }}>
                        Step {s.step.toLocaleString()}
                      </span>
                      {s.loss != null && (
                        <span className="font-mono text-xs" style={{ color: 'var(--color-muted)' }}>
                          loss {s.loss.toFixed(4)}
                        </span>
                      )}
                    </div>
                    <div className="font-mono text-xs leading-relaxed" style={{ color: 'var(--color-foreground)' }}>
                      {s.text.length > 200 ? s.text.slice(0, 200) + '...' : s.text}
                    </div>
                  </div>
                ))}
              </div>
            ) : (
              <div className="py-12 text-center font-mono text-sm" style={{ color: 'var(--color-muted)' }}>
                No samples recorded
              </div>
            )
          )}

          {activeTab === 'evals' && (
            detail?.evals?.length ? (
              <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
                {detail.evals.map((ev, i) => (
                  <div
                    key={i}
                    className="rounded-lg p-3"
                    style={{ backgroundColor: 'var(--color-background)', border: '1px solid var(--color-border)' }}
                  >
                    <div className="flex items-center justify-between">
                      <span className="font-mono text-xs font-medium" style={{ color: '#a78bfa' }}>
                        Step {ev.step.toLocaleString()}
                      </span>
                      <span className="font-mono text-sm font-bold" style={{ color: 'var(--color-foreground)' }}>
                        {ev.score.toFixed(4)}
                      </span>
                    </div>
                    <div className="mt-1 font-mono text-xs" style={{ color: 'var(--color-muted)' }}>
                      {ev.eval_name}
                    </div>
                  </div>
                ))}
              </div>
            ) : (
              <div className="py-12 text-center font-mono text-sm" style={{ color: 'var(--color-muted)' }}>
                No eval results recorded
              </div>
            )
          )}

          {activeTab === 'infra' && (
            activeRunHost ? (
              <InfraChart data={infraData} />
            ) : (
              <div className="py-12 text-center font-mono text-sm" style={{ color: 'var(--color-muted)' }}>
                Select a live-proxy run to monitor infrastructure
              </div>
            )
          )}
        </div>
      </div>
    </div>
  );
}
