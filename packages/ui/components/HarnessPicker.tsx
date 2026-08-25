'use client';

import { useEffect } from 'react';
import useSWR from 'swr';
import { HARNESSES } from '@unturf/unfirehose/harness-models';

/* eslint-disable @typescript-eslint/no-explicit-any */

const fetcher = (url: string) => fetch(url).then((r) => r.json());

export interface HarnessPickerProps {
  harness: string;
  setHarness: (v: string) => void;
  customCmd?: string;
  setCustomCmd?: (v: string) => void;
  model: string;
  setModel: (v: string) => void;
  /** Node the work will run on. 'localhost' and 'unsandbox' probe locally. */
  target?: string;
  /** Stack vertically with labels above, for panel layouts. */
  layout?: 'inline' | 'stacked';
  className?: string;
}

/**
 * Harness + model selection, shared by every surface that dispatches work.
 *
 * It exists because those surfaces disagreed. The project page offered twelve
 * harnesses, the permacomputer bootstrap panel offered two, and the todos page
 * offered none and always ran claude — and none of them let you choose a
 * model, so uncloseai dispatches took whatever default the harness held out of
 * 469 available.
 *
 * Local models are grouped first and marked ⚡: they cost electricity rather
 * than money, which is the distinction the whole choice exists to serve.
 */
export function HarnessPicker({
  harness, setHarness,
  customCmd, setCustomCmd,
  model, setModel,
  target = 'localhost',
  layout = 'inline',
  className = '',
}: HarnessPickerProps) {
  // A model id only means something for the harness and node it came from.
  useEffect(() => { setModel(''); }, [harness, target, setModel]);

  const remote = target && target !== 'localhost' && target !== 'unsandbox';
  const { data } = useSWR<any>(
    `/api/harness/models?harness=${encodeURIComponent(harness)}${remote ? `&host=${encodeURIComponent(target)}` : ''}`,
    fetcher,
    { revalidateOnFocus: false, keepPreviousData: false },
  );

  const models: any[] = data?.models ?? [];
  const local = models.filter((m) => m.local);
  const cloud = models.filter((m) => !m.local);
  const active = models.find((m) => m.active);

  const stacked = layout === 'stacked';
  const wrap = stacked ? 'block' : 'flex items-center gap-1.5';
  const labelCls = stacked
    ? 'text-base text-[var(--color-muted)] block mb-1'
    : 'text-xs text-[var(--color-muted)]';
  const selectCls = stacked
    ? 'w-full bg-[var(--color-background)] border border-[var(--color-border)] rounded px-3 py-1.5 text-base'
    : 'text-sm bg-[var(--color-background)] border border-[var(--color-border)] rounded px-2 py-1 focus:outline-none focus:border-[var(--color-accent)]';

  return (
    <>
      <div className={`${wrap} ${className}`}>
        <span className={labelCls}>Harness</span>
        <select value={harness} onChange={(e) => setHarness(e.target.value)} className={selectCls}>
          {HARNESSES.map((h) => (
            <option key={h.value} value={h.value}>{h.label}</option>
          ))}
        </select>
      </div>

      {harness === 'custom' && setCustomCmd && (
        <div className={wrap}>
          {stacked && <span className={labelCls}>Command</span>}
          <input
            value={customCmd ?? ''}
            onChange={(e) => setCustomCmd(e.target.value)}
            placeholder="command to run"
            className={selectCls}
          />
        </div>
      )}

      {data?.selectable && (
        <div className={wrap}>
          <span className={labelCls}>Model</span>
          <select
            value={model}
            onChange={(e) => setModel(e.target.value)}
            title={
              data?.error
                ? `could not list models: ${data.error}`
                : `${models.length} models on ${data?.host ?? 'localhost'}`
            }
            className={`${selectCls} ${stacked ? '' : 'max-w-[22rem]'}`}
          >
            <option value="">
              {data?.error
                ? 'harness default (list unavailable)'
                : `harness default${active ? ` — ${active.id}` : ''}`}
            </option>
            {local.length > 0 && (
              <optgroup label={`our hardware (${local.length}) — electricity only`}>
                {local.map((m) => <option key={m.id} value={m.id}>⚡ {m.id}</option>)}
              </optgroup>
            )}
            {cloud.length > 0 && (
              <optgroup label={`billed (${cloud.length})`}>
                {cloud.map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.id}{m.providers?.length ? `  [${m.providers.join('+')}]` : ''}
                  </option>
                ))}
              </optgroup>
            )}
          </select>
        </div>
      )}
    </>
  );
}

export default HarnessPicker;
