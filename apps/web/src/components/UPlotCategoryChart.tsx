'use client';

import { useEffect, useRef } from 'react';
import uPlot from 'uplot';
import 'uplot/dist/uPlot.min.css';

/**
 * Bars or lines over a labelled axis, on uPlot.
 *
 * UPlotTimeChart draws time series. This draws everything else we used
 * recharts for: messages per day, activity by hour, counts by weekday, tool
 * calls by name — an axis of labels rather than of time. Same library, same
 * canvas, same 49KB already on the page, where recharts was 326KB to draw
 * the same shapes in SVG.
 *
 * Colours are plain CSS colours, not variables: this paints to a canvas and
 * a canvas cannot resolve `var(--color-accent)`. Callers pass the resolved
 * value, which is what they were already passing to recharts.
 */

export interface CategorySeries {
  /** Field in each row that holds this series' value. */
  key: string;
  label: string;
  /** One colour for the series, or one per bar in row order. */
  color: string | string[];
  /** Area fill under a line; ignored for bars. */
  fill?: string;
  /** Draw this one series as a line over the bars (or bars under the lines). */
  kind?: 'bars' | 'lines';
  /** Plot against a second y axis on the right — a running total beside a daily figure. */
  axis?: 'left' | 'right';
}

export interface UPlotCategoryChartProps {
  data: Array<Record<string, unknown>>;
  /** Field in each row that holds the label for the x axis. */
  labelKey: string;
  series: CategorySeries[];
  kind?: 'bars' | 'lines';
  height: number;
  /** Bars drawn left-to-right instead of bottom-to-top, for long labels. */
  horizontal?: boolean;
  /**
   * Stack the bar series. uPlot has no stacking of its own: each series is
   * summed onto the ones before it and drawn back-to-front, so the total sits
   * behind and every segment shows as its own height. The hover readout
   * shows the real, un-summed value.
   */
  stacked?: boolean;
  /** Format for the right-hand axis, when a series uses it. */
  formatRight?: (v: number) => string;
  /** Horizontal guide lines — a budget, an actual — drawn on the canvas with a label. */
  refLines?: Array<{ value: number; color: string; label?: string; axis?: 'left' | 'right' }>;
  /** A row of swatches under the chart naming each series. */
  legend?: boolean;
  /** Format a value for the axis and the hover readout. */
  format?: (v: number) => string;
  /** Turn a row's label into the axis text; defaults to the label itself. */
  tick?: (label: string, index: number) => string;
  /** Extra lines for the hover readout, e.g. a second timezone. */
  hover?: (row: Record<string, unknown>, index: number) => string;
}

const AXIS_STROKE = '#a1a1aa';
const GRID = { stroke: 'rgba(63, 63, 70, 0.4)', width: 1 };
const TICKS = { stroke: 'rgba(63, 63, 70, 0.6)', size: 4 };
const FONT = '11px ui-sans-serif, system-ui, sans-serif';

const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : 0);

export function UPlotCategoryChart({
  data, labelKey, series, kind = 'bars', height, horizontal = false, stacked = false, format, formatRight, tick, hover, refLines, legend = false,
}: UPlotCategoryChartProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const uRef = useRef<uPlot | null>(null);
  const readoutRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const el = containerRef.current;
    if (!el || data.length === 0) return;

    const labels = data.map((r) => String(r[labelKey] ?? ''));
    const hasRight = series.some((s) => s.axis === 'right');
    // Stacked bars: each series carries the sum of itself and the bar series
    // before it, and the list is reversed so the tallest total is drawn first
    // and every later, shorter one sits in front. Lines are left alone.
    const columns = series.map((s) => data.map((r) => num(r[s.key])));
    if (stacked) {
      let acc: number[] | null = null;
      series.forEach((s, i) => {
        if ((s.kind ?? kind) !== 'bars') return;
        if (acc) columns[i] = columns[i].map((v, j) => v + acc![j]);
        acc = columns[i];
      });
    }
    const order = stacked ? [...series.keys()].reverse() : [...series.keys()];
    const drawn = order.map((i) => series[i]);
    const drawnColumns = order.map((i) => columns[i]);
    const fmt = format ?? ((v: number) => (Math.abs(v) >= 1000 ? `${(v / 1000).toFixed(1)}k` : String(Math.round(v))));
    const bars = kind === 'bars';
    // Bars need room between them; lines want the points on the tick.
    const barPaths = uPlot.paths.bars?.({ size: [0.6, Infinity], align: 0 });

    const opts: uPlot.Options = {
      width: el.clientWidth || 600,
      height,
      padding: [10, 12, 4, 6],
      legend: { show: false },
      scales: {
        x: { time: false, range: bars ? [-0.5, labels.length - 0.5] : [0, Math.max(0, labels.length - 1)] },
        y: { auto: true, range: (_u, _min, max) => [0, Math.max(max * 1.08, 1)] },
        ...(hasRight ? { r: { auto: true, range: (_u, _min, max) => [0, Math.max(max * 1.08, 1)] } } : {}),
      },
      cursor: {
        drag: { x: false, y: false, setScale: false },
        points: { show: !bars },
        x: !bars, y: false,
      },
      axes: [
        {
          stroke: AXIS_STROKE, grid: { show: false }, ticks: TICKS, font: FONT,
          // One tick per label. uPlot would otherwise pick "nice" numbers
          // like 0, 5, 10 and label every fifth bar.
          splits: () => labels.map((_, i) => i),
          values: (_u, splits) => splits.map((i) => (tick ? tick(labels[i], i) : labels[i]) ?? ''),
          size: 28,
          gap: 4,
          rotate: labels.length > 16 && !horizontal ? -45 : 0,
        },
        {
          stroke: AXIS_STROKE, grid: GRID, ticks: TICKS, font: FONT,
          values: (_u, vals) => vals.map(fmt),
          size: 44,
        },
        ...(hasRight ? [{
          scale: 'r', side: 1, stroke: AXIS_STROKE, grid: { show: false }, ticks: TICKS, font: FONT,
          values: (_u: uPlot, vals: number[]) => vals.map(formatRight ?? fmt),
          size: 44,
        } as uPlot.Axis] : []),
      ],
      series: [
        { label: labelKey },
        ...drawn.map<uPlot.Series>((s) => {
          const perBar = Array.isArray(s.color);
          const asBars = (s.kind ?? kind) === 'bars';
          return {
            label: s.label,
            scale: s.axis === 'right' ? 'r' : 'y',
            stroke: perBar ? undefined : (s.color as string),
            fill: asBars ? (perBar ? undefined : (s.color as string)) : s.fill,
            width: asBars ? 0 : 1.5,
            paths: asBars ? barPaths : undefined,
            points: { show: false },
            // uPlot colours bars per point through `disp`, not `fill`.
            ...(asBars && perBar ? { fill: undefined, disp: { fill: { unit: 3, values: () => s.color as string[] } } } : {}),
          } as uPlot.Series;
        }),
      ],
      hooks: {
        // Guide lines go straight onto the canvas after the series, in
        // canvas pixels, so they scroll and rescale with the plot.
        draw: refLines?.length ? [(u) => {
          const ctx = u.ctx;
          ctx.save();
          for (const r of refLines) {
            const scale = r.axis === 'right' ? 'r' : 'y';
            const y = u.valToPos(r.value, scale, true);
            if (!Number.isFinite(y)) continue;
            ctx.strokeStyle = r.color; ctx.lineWidth = 1; ctx.setLineDash([4, 3]);
            ctx.beginPath(); ctx.moveTo(u.bbox.left, y); ctx.lineTo(u.bbox.left + u.bbox.width, y); ctx.stroke();
            if (r.label) {
              ctx.setLineDash([]); ctx.fillStyle = r.color; ctx.font = `${12 * (uPlot.pxRatio || 1)}px ui-sans-serif, system-ui, sans-serif`;
              ctx.textAlign = 'right'; ctx.textBaseline = 'bottom';
              ctx.fillText(r.label, u.bbox.left + u.bbox.width - 4, y - 3);
            }
          }
          ctx.restore();
        }] : [],
        setCursor: [(u) => {
          const box = readoutRef.current;
          if (!box) return;
          const idx = u.cursor.idx;
          if (idx == null || idx < 0 || idx >= data.length) { box.style.opacity = '0'; return; }
          const row = data[idx];
          const lines = [
            `<b>${labels[idx]}</b>`,
            ...series.map((s) => `<span style="color:${Array.isArray(s.color) ? s.color[idx] : s.color}">●</span> ${s.label}: ${(s.axis === 'right' ? (formatRight ?? fmt) : fmt)(num(row[s.key]))}`),
          ];
          if (hover) lines.push(hover(row, idx));
          box.innerHTML = lines.join('<br>');
          box.style.opacity = '1';
          const left = u.cursor.left ?? 0;
          const flip = left > (u.over.clientWidth || 0) * 0.6;
          box.style.left = flip ? 'auto' : `${left + 12}px`;
          box.style.right = flip ? `${(u.over.clientWidth || 0) - left + 12}px` : 'auto';
        }],
      },
    };
    if (horizontal) {
      // uPlot's orientation switch: x becomes the vertical axis.
      opts.axes![0].side = 3; opts.axes![1].side = 0;
      opts.scales!.x!.ori = 1; opts.scales!.y!.ori = 0;
      opts.scales!.x!.dir = -1;
    }

    const aligned: uPlot.AlignedData = [labels.map((_, i) => i), ...drawnColumns];
    const u = new uPlot(opts, aligned, el);
    uRef.current = u;

    const box = document.createElement('div');
    box.style.cssText = 'position:absolute;top:8px;pointer-events:none;opacity:0;background:rgba(24,24,27,0.95);border:1px solid #3f3f46;border-radius:4px;padding:4px 8px;font-size:12px;line-height:1.4;color:#fafafa;white-space:nowrap;transition:opacity .1s;';
    u.over.appendChild(box);
    readoutRef.current = box;

    const ro = new ResizeObserver((entries) => {
      const w = entries[0]?.contentRect.width;
      if (w && uRef.current) uRef.current.setSize({ width: w, height });
    });
    ro.observe(el);

    return () => { ro.disconnect(); u.destroy(); uRef.current = null; readoutRef.current = null; };
    // Rebuilding on any change is the simple, correct thing: these charts
    // redraw on a range change, not on a live tick.
  }, [data, labelKey, series, kind, height, horizontal, stacked, format, formatRight, tick, hover, refLines]);

  return (
    <div>
      <div ref={containerRef} className="relative w-full" style={{ height }} />
      {legend && (
        <div className="flex flex-wrap gap-x-3 gap-y-1 mt-1 text-xs text-[var(--color-muted)]" role="list" aria-label="series">
          {series.map((s) => (
            <span key={s.key} role="listitem" className="inline-flex items-center gap-1">
              <span className="inline-block w-2 h-2 rounded-sm" style={{ background: Array.isArray(s.color) ? s.color[0] : s.color }} />
              {s.label}
            </span>
          ))}
        </div>
      )}
    </div>
  );
}
