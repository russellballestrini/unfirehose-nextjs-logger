'use client';

import { useState } from 'react';
import useSWR from 'swr';
import { fetcher } from '@unturf/unfirehose-ui/fetcher';

/**
 * Export training set: one project's sessions as SFT lines (ticket 4011
 * item 8). Pick filters, preview what a download would hold (examples,
 * turns, redactions by type), then download it. The preview is a dry run of
 * the same pass, so its counts are the file's; changing a filter clears it,
 * and Download waits for a preview of the filters it would use.
 */

export interface TrainingExportForm {
  model: string;
  harness: string;
  from: string;
  to: string;
  toolErrors: 'turn' | 'session' | 'keep';
  minTurns: string;
  maxTurns: string;
  reasoning: boolean;
  tools: boolean;
  metadata: boolean;
}

export const EMPTY_TRAINING_FORM: TrainingExportForm = {
  model: '', harness: '', from: '', to: '', toolErrors: 'turn',
  minTurns: '', maxTurns: '', reasoning: false, tools: true, metadata: false,
};

/** Our API route's query for a form: defaults are left out. */
export function trainingExportQuery(project: string, f: TrainingExportForm, dryRun = false): string {
  const q = new URLSearchParams({ project });
  if (f.model) q.set('model', f.model);
  if (f.harness) q.set('harness', f.harness);
  if (f.from) q.set('from', f.from);
  if (f.to) q.set('to', f.to);
  if (f.toolErrors !== 'turn') q.set('toolErrors', f.toolErrors);
  if (f.minTurns) q.set('minTurns', f.minTurns);
  if (f.maxTurns) q.set('maxTurns', f.maxTurns);
  if (f.reasoning) q.set('reasoning', '1');
  if (!f.tools) q.set('tools', '0');
  if (f.metadata) q.set('metadata', '1');
  if (dryRun) q.set('dryRun', '1');
  return q.toString();
}

interface DryRun {
  stats: {
    sessionsScanned: number; examples: number; turns: number; messages: number;
    toolCalls: number; turnsDroppedForToolErrors: number;
    skipped: Record<string, number>;
    redactions: Record<string, number>; redactionsTotal: number;
  };
  bytes: number;
}

const FIELD = 'text-sm bg-[var(--color-background)] border border-[var(--color-border)] rounded px-2 py-1 focus:outline-none focus:border-[var(--color-accent)] min-w-0';
const LABEL = 'flex flex-col gap-1 text-xs text-[var(--color-muted)]';

function fmtBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

export function TrainingExport({ project }: {
  /** Encoded project name, as our API takes it. */
  project: string;
}) {
  const { data: facets } = useSWR<{ harnesses?: string[]; models?: string[] }>(
    `/api/training-export?facets=1&project=${encodeURIComponent(project)}`, fetcher,
  );
  const models = Array.isArray(facets?.models) ? facets.models : [];
  const harnesses = Array.isArray(facets?.harnesses) ? facets.harnesses : [];
  const [form, setForm] = useState<TrainingExportForm>(EMPTY_TRAINING_FORM);
  const [preview, setPreview] = useState<{ query: string; result: DryRun } | null>(null);
  const [state, setState] = useState<'idle' | 'pending' | { error: string }>('idle');

  const set = <K extends keyof TrainingExportForm>(k: K, v: TrainingExportForm[K]) => {
    setForm((f) => ({ ...f, [k]: v }));
    setPreview(null);
  };
  const query = trainingExportQuery(project, form);

  const runPreview = async () => {
    setState('pending');
    try {
      const res = await fetch(`/api/training-export?${trainingExportQuery(project, form, true)}`);
      const body = await res.json();
      if (!res.ok) { setState({ error: body.error ?? `HTTP ${res.status}` }); return; }
      setPreview({ query, result: body });
      setState('idle');
    } catch (err) {
      setState({ error: String(err) });
    }
  };

  const fresh = preview?.query === query ? preview.result : null;
  const redactions = fresh ? Object.entries(fresh.stats.redactions).sort((a, b) => b[1] - a[1]) : [];
  const skipped = fresh ? Object.entries(fresh.stats.skipped).filter(([, n]) => n > 0) : [];

  return (
    <div className="border border-[var(--color-border)] rounded p-4 space-y-3">
      <div>
        <h3 className="text-sm font-bold text-[var(--color-muted)]">Export training set</h3>
        <p className="text-xs text-[var(--color-muted)] mt-1">
          Sessions as SFT lines (<code>{'{"messages":[…]}'}</code>), with secrets, home paths and PII redacted.
        </p>
      </div>

      <div className="grid grid-cols-2 gap-2">
        <label className={LABEL}>Model
          <select value={form.model} onChange={(e) => set('model', e.target.value)} className={FIELD}>
            <option value="">any</option>
            {models.map((m) => <option key={m} value={m}>{m}</option>)}
          </select>
        </label>
        <label className={LABEL}>Harness
          <select value={form.harness} onChange={(e) => set('harness', e.target.value)} className={FIELD}>
            <option value="">any</option>
            {harnesses.map((h) => <option key={h} value={h}>{h}</option>)}
          </select>
        </label>
        <label className={LABEL}>From
          <input type="date" value={form.from} onChange={(e) => set('from', e.target.value)} className={FIELD} />
        </label>
        <label className={LABEL}>To
          <input type="date" value={form.to} onChange={(e) => set('to', e.target.value)} className={FIELD} />
        </label>
        <label className={LABEL}>Min turns
          <input type="number" min={0} inputMode="numeric" value={form.minTurns} onChange={(e) => set('minTurns', e.target.value)} className={FIELD} />
        </label>
        <label className={LABEL}>Max turns
          <input type="number" min={0} inputMode="numeric" value={form.maxTurns} onChange={(e) => set('maxTurns', e.target.value)} className={FIELD} />
        </label>
        <label className={`${LABEL} col-span-2`}>Errored tool results
          <select value={form.toolErrors} onChange={(e) => set('toolErrors', e.target.value as TrainingExportForm['toolErrors'])} className={FIELD}>
            <option value="turn">drop that turn</option>
            <option value="session">drop the session</option>
            <option value="keep">keep</option>
          </select>
        </label>
      </div>

      <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs">
        <label className="flex items-center gap-1.5">
          <input type="checkbox" checked={form.tools} onChange={(e) => set('tools', e.target.checked)} className="accent-[var(--color-accent)]" />
          tool calls
        </label>
        <label className="flex items-center gap-1.5">
          <input type="checkbox" checked={form.reasoning} onChange={(e) => set('reasoning', e.target.checked)} className="accent-[var(--color-accent)]" />
          reasoning
        </label>
        <label className="flex items-center gap-1.5">
          <input type="checkbox" checked={form.metadata} onChange={(e) => set('metadata', e.target.checked)} className="accent-[var(--color-accent)]" />
          metadata
        </label>
      </div>

      {fresh && (
        <div className="text-xs space-y-1" data-testid="training-preview">
          <div className="flex justify-between"><span className="text-[var(--color-muted)]">Examples</span><span>{fresh.stats.examples} of {fresh.stats.sessionsScanned} sessions</span></div>
          <div className="flex justify-between"><span className="text-[var(--color-muted)]">Turns · messages</span><span>{fresh.stats.turns} · {fresh.stats.messages}</span></div>
          <div className="flex justify-between"><span className="text-[var(--color-muted)]">Tool calls</span><span>{fresh.stats.toolCalls}</span></div>
          {fresh.stats.turnsDroppedForToolErrors > 0 && (
            <div className="flex justify-between"><span className="text-[var(--color-muted)]">Turns dropped for tool errors</span><span>{fresh.stats.turnsDroppedForToolErrors}</span></div>
          )}
          {skipped.map(([k, n]) => (
            <div key={k} className="flex justify-between"><span className="text-[var(--color-muted)]">Skipped, {k.replace(/([A-Z])/g, ' $1').toLowerCase()}</span><span>{n}</span></div>
          ))}
          <div className="flex justify-between"><span className="text-[var(--color-muted)]">Redactions</span><span>{fresh.stats.redactionsTotal}</span></div>
          {redactions.map(([k, n]) => (
            <div key={k} className="flex justify-between pl-3"><span className="text-[var(--color-muted)] font-mono">{k}</span><span>{n}</span></div>
          ))}
          <div className="flex justify-between"><span className="text-[var(--color-muted)]">Size</span><span>{fmtBytes(fresh.bytes)}</span></div>
        </div>
      )}
      {typeof state === 'object' && <p className="text-xs text-[var(--color-error)]">{state.error}</p>}

      <div className="flex items-center justify-end gap-2">
        <button onClick={runPreview} disabled={state === 'pending'}
          className="px-3 py-1.5 text-sm bg-[var(--color-surface-hover)] text-[var(--color-foreground)] rounded-lg hover:bg-[var(--color-border)] transition-colors disabled:opacity-40">
          {state === 'pending' ? 'Counting…' : 'Preview'}
        </button>
        {fresh && fresh.stats.examples > 0 ? (
          <a href={`/api/training-export?${query}`} download
            className="px-4 py-1.5 text-sm font-bold bg-[var(--color-accent)] text-[var(--color-background)] rounded-lg hover:opacity-90 transition-opacity">
            Download .jsonl
          </a>
        ) : (
          <span className="px-4 py-1.5 text-sm font-bold bg-[var(--color-accent)] text-[var(--color-background)] rounded-lg opacity-40" aria-disabled="true"
            title={fresh ? 'Nothing matches these filters' : 'Preview first'}>
            Download .jsonl
          </span>
        )}
      </div>
    </div>
  );
}
