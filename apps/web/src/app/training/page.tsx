'use client';

import { useState, useMemo } from 'react';
import useSWR from 'swr';
import {
  LineChart,
  Line,
  XAxis,
  YAxis,
  Tooltip,
  ResponsiveContainer,
  CartesianGrid,
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

function EmptyState() {
  return (
    <div className="flex flex-1 items-center justify-center p-12">
      <div className="max-w-lg text-center" style={{ color: 'var(--color-muted)' }}>
        <div className="mb-4 text-4xl">{'{ }'}</div>
        <h2 className="mb-2 text-lg font-semibold" style={{ color: 'var(--color-foreground)' }}>
          No training runs yet
        </h2>
        <p className="mb-6 text-sm leading-relaxed">
          Ingest training data by POSTing events to the training API endpoint.
          Each event should include a <code className="rounded px-1 py-0.5 font-mono text-xs" style={{ backgroundColor: 'var(--color-surface)' }}>run_id</code>,{' '}
          <code className="rounded px-1 py-0.5 font-mono text-xs" style={{ backgroundColor: 'var(--color-surface)' }}>step</code>, and{' '}
          <code className="rounded px-1 py-0.5 font-mono text-xs" style={{ backgroundColor: 'var(--color-surface)' }}>loss</code>.
        </p>
        <pre
          className="rounded-lg p-4 text-left font-mono text-xs leading-relaxed"
          style={{ backgroundColor: 'var(--color-surface)', color: 'var(--color-foreground)', border: '1px solid var(--color-border)' }}
        >
{`# Start a run
curl -X POST localhost:3000/api/training \\
  -H 'Content-Type: application/json' \\
  -d '{"type":"run.start","run_id":"run-001","model":"llama-3-8b","ts":"2026-03-09T00:00:00Z"}'

# Log loss
curl -X POST localhost:3000/api/training \\
  -H 'Content-Type: application/json' \\
  -d '{"type":"run.loss","run_id":"run-001","step":100,"loss":2.34,"ts":"2026-03-09T00:01:00Z"}'`}
        </pre>
        <p className="mt-4 text-xs" style={{ color: 'var(--color-muted)' }}>
          Event types: <code className="font-mono">run.start</code>, <code className="font-mono">run.loss</code>,{' '}
          <code className="font-mono">run.sample</code>, <code className="font-mono">run.checkpoint</code>,{' '}
          <code className="font-mono">run.eval</code>, <code className="font-mono">run.end</code>
        </p>
      </div>
    </div>
  );
}

function RunsList({
  runs,
  selectedId,
  onSelect,
}: {
  runs: TrainingRun[];
  selectedId: string | null;
  onSelect: (id: string) => void;
}) {
  return (
    <div className="flex flex-col gap-1">
      {runs.map((run) => {
        const active = run.run_id === selectedId;
        return (
          <button
            key={run.run_id}
            onClick={() => onSelect(run.run_id)}
            className="w-full rounded-lg px-3 py-2.5 text-left transition-colors"
            style={{
              backgroundColor: active ? 'var(--color-surface)' : 'transparent',
              border: active ? '1px solid var(--color-border)' : '1px solid transparent',
            }}
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
            <div className="mt-0.5 font-mono text-xs" style={{ color: 'var(--color-muted)', opacity: 0.6 }}>
              {run.run_id}
            </div>
          </button>
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

function EventsTimeline({
  checkpoints,
  samples,
  evals,
}: {
  checkpoints: Checkpoint[];
  samples: Sample[];
  evals: EvalResult[];
}) {
  const hasAny = checkpoints?.length || samples?.length || evals?.length;
  if (!hasAny) return null;

  return (
    <div className="flex flex-col gap-4">
      {/* Checkpoints */}
      {checkpoints?.length > 0 && (
        <div>
          <h3 className="mb-2 font-mono text-xs font-semibold uppercase tracking-wider" style={{ color: 'var(--color-muted)' }}>
            Checkpoints
          </h3>
          <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
            {checkpoints.map((cp, i) => (
              <div
                key={i}
                className="rounded-lg p-3"
                style={{ backgroundColor: 'var(--color-surface)', border: '1px solid var(--color-border)' }}
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
        </div>
      )}

      {/* Evals */}
      {evals?.length > 0 && (
        <div>
          <h3 className="mb-2 font-mono text-xs font-semibold uppercase tracking-wider" style={{ color: 'var(--color-muted)' }}>
            Evaluations
          </h3>
          <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
            {evals.map((ev, i) => (
              <div
                key={i}
                className="rounded-lg p-3"
                style={{ backgroundColor: 'var(--color-surface)', border: '1px solid var(--color-border)' }}
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
        </div>
      )}

      {/* Samples */}
      {samples?.length > 0 && (
        <div>
          <h3 className="mb-2 font-mono text-xs font-semibold uppercase tracking-wider" style={{ color: 'var(--color-muted)' }}>
            Samples
          </h3>
          <div className="grid gap-2 lg:grid-cols-2">
            {samples.map((s, i) => (
              <div
                key={i}
                className="rounded-lg p-3"
                style={{ backgroundColor: 'var(--color-surface)', border: '1px solid var(--color-border)' }}
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
        </div>
      )}
    </div>
  );
}

// ---------- page ----------

export default function TrainingPage() {
  const [selectedRunId, setSelectedRunId] = useState<string | null>(null);
  const [showEma, setShowEma] = useState(true);

  // Runs list — polls every 5s for live updates
  const { data: runsData } = useSWR<{ runs: TrainingRun[] }>(
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

  if (!runs.length && !runsData) {
    return (
      <div className="flex h-full items-center justify-center" style={{ color: 'var(--color-muted)' }}>
        <span className="font-mono text-sm">Loading...</span>
      </div>
    );
  }

  if (!runs.length) {
    return <EmptyState />;
  }

  return (
    <div className="flex h-full gap-4 p-4">
      {/* Left panel — runs list */}
      <div
        className="w-72 shrink-0 overflow-y-auto rounded-xl p-3"
        style={{ backgroundColor: 'var(--color-surface)', border: '1px solid var(--color-border)' }}
      >
        <h2 className="mb-3 font-mono text-xs font-semibold uppercase tracking-wider" style={{ color: 'var(--color-muted)' }}>
          Training Runs ({runs.length})
        </h2>
        <RunsList runs={runs} selectedId={activeRunId} onSelect={setSelectedRunId} />
      </div>

      {/* Main area */}
      <div className="flex min-w-0 flex-1 flex-col gap-4 overflow-y-auto">
        {/* Loss curve */}
        <div
          className="rounded-xl p-4"
          style={{ backgroundColor: 'var(--color-surface)', border: '1px solid var(--color-border)' }}
        >
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
        </div>

        {/* Events timeline */}
        <div
          className="rounded-xl p-4"
          style={{ backgroundColor: 'var(--color-surface)', border: '1px solid var(--color-border)' }}
        >
          <h2 className="mb-3 font-mono text-xs font-semibold uppercase tracking-wider" style={{ color: 'var(--color-muted)' }}>
            Events
          </h2>
          <EventsTimeline
            checkpoints={detail?.checkpoints ?? []}
            samples={detail?.samples ?? []}
            evals={detail?.evals ?? []}
          />
          {!detail?.checkpoints?.length && !detail?.samples?.length && !detail?.evals?.length && detail && (
            <div className="py-8 text-center font-mono text-xs" style={{ color: 'var(--color-muted)' }}>
              No checkpoint, sample, or eval events recorded for this run
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
