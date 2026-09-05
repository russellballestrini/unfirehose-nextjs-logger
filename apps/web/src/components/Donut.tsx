'use client';

import { useEffect, useRef } from 'react';
import { Donut as DonutChart } from '@/lib/donut';

/**
 * A donut with a legend, on our own canvas.
 *
 * The React half is as thin as UPlotTimeChart's: create on mount, resize
 * with the container, destroy on unmount, and keep the hover readout out of
 * React entirely — the chart calls a hook, the hook writes a div. Nothing
 * re-renders on mouse move.
 *
 * The long tail folds into one "other" row past `topN`, so a share of one
 * per cent does not get a slice the eye cannot find and a legend entry that
 * pushes the head off screen. The legend is real markup under the canvas,
 * as it was under the recharts donut it replaces, so names and values are
 * selectable and screen-readable — the canvas is the picture, not the data.
 */

export interface Share {
  name: string;
  /** Shown on hover and as the title, when the name is an abbreviation. */
  fullName?: string;
  value: number;
  color: string;
}

export function Donut({
  data, format, height = 160, topN = 8, inner = 0.55, center = true, className = '',
}: {
  data: Share[];
  format: (v: number) => string;
  height?: number;
  topN?: number;
  /** Hole size as a fraction of the radius; 0 is a pie. */
  inner?: number;
  /** Draw the total in the hole. */
  center?: boolean;
  className?: string;
}) {
  const boxRef = useRef<HTMLDivElement>(null);
  const readoutRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<DonutChart | null>(null);

  const sorted = [...data].filter((d) => d.value > 0).sort((a, b) => b.value - a.value);
  const head = sorted.slice(0, topN);
  const tail = sorted.slice(topN);
  const rows: Share[] = tail.length
    ? [...head, { name: `other (${tail.length})`, fullName: `${tail.length} smaller`, value: tail.reduce((s, d) => s + d.value, 0), color: '#71717a' }]
    : head;
  const total = rows.reduce((s, d) => s + d.value, 0);

  // One string the effect can compare, so data that is equal but not the
  // same array does not tear the chart down and build it again.
  const key = JSON.stringify(rows.map((r) => [r.name, r.value, r.color]));

  useEffect(() => {
    const el = boxRef.current;
    if (!el || rows.length === 0) return;
    const size = () => Math.max(40, Math.min(el.clientWidth || height, height));
    const chart = new DonutChart({
      width: size(), height: size(), inner, lift: 4, padAngle: 0.02,
      center: center ? () => [format(total), 'total'] : undefined,
      hooks: {
        setCursor: [(d) => {
          const box = readoutRef.current;
          if (!box) return;
          if (d.cursor.idx == null) { box.style.opacity = '0'; return; }
          const r = rows[d.cursor.idx];
          const pct = total > 0 ? (r.value / total) * 100 : 0;
          box.innerHTML = `<span style="color:${r.color}">●</span> <b>${r.fullName ?? r.name}</b><br>${format(r.value)} · ${pct < 1 ? '<1' : Math.round(pct)}%`;
          box.style.opacity = '1';
          box.style.left = `${d.cursor.left + 12}px`;
          box.style.top = `${d.cursor.top + 12}px`;
        }],
      },
    }, { values: rows.map((r) => r.value), colors: rows.map((r) => r.color), labels: rows.map((r) => r.name) }, el);
    chartRef.current = chart;

    const ro = new ResizeObserver(() => { const s = size(); chart.setSize({ width: s, height: s }); });
    ro.observe(el);
    return () => { ro.disconnect(); chart.destroy(); chartRef.current = null; };
    // `key` stands in for rows; the rest are stable per call site.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, height, inner, center]);

  if (rows.length === 0) {
    return <div className={`text-sm text-[var(--color-muted)] ${className}`}>nothing yet</div>;
  }

  return (
    <div className={className}>
      <div className="relative flex justify-center">
        <div ref={boxRef} className="w-full flex justify-center" style={{ height }} />
        <div ref={readoutRef} className="absolute pointer-events-none opacity-0 rounded border border-[var(--color-border)] bg-[var(--color-surface)] px-2 py-1 text-xs leading-snug whitespace-nowrap transition-opacity" style={{ left: 0, top: 0 }} />
      </div>
      <ul className="mt-2 max-h-24 overflow-y-auto text-sm space-y-1 pr-1">
        {rows.map((r) => (
          <li key={r.name} className="flex items-center gap-1.5" title={r.fullName ?? r.name}>
            <span className="inline-block w-2.5 h-2.5 rounded-sm shrink-0" style={{ background: r.color }} />
            <span className="truncate">{r.name}</span>
            <span className="ml-auto shrink-0 text-[var(--color-muted)] tabular-nums">{format(r.value)}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}
