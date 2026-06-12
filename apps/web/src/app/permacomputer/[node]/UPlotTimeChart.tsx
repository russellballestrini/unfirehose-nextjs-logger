'use client';

/**
 * Canvas-based time series chart, no React reconciliation in the hot path.
 * uPlot mounts once via useEffect, gets new data via setData, and renders
 * straight to canvas. cursor.sync keeps every chart's crosshair locked
 * together. Drag-to-zoom is built in.
 *
 * Per chart render: ~1ms for ~300 points. 8 charts = ~8ms total, well
 * within a 16ms frame budget — mouse never sees a hitch.
 */

import uPlot from 'uplot';
import 'uplot/dist/uPlot.min.css';
import { useEffect, useRef } from 'react';

export interface UPlotSeries {
  key: string;          // field in `data` rows
  label: string;
  stroke: string;       // line color (any CSS color — NOT a CSS var: canvas
                        //   can't resolve var(--…), use a literal hex/rgba)
  fill?: string;        // area fill color (rgba recommended)
  width?: number;
  step?: boolean;       // step-after (for the claudes chart)
  dash?: number[];      // dashed line
  watermark?: boolean;  // visual reference only — no active dot, doesn't
                        //   trigger cursor focus dimming on neighbors
}

export interface UPlotTimeChartProps {
  data: Array<Record<string, number>>;
  series: UPlotSeries[];
  height: number;
  syncKey: string;
  domain: [number, number] | null;   // tsMs window, null = full range
  onZoom?: (rangeMs: [number, number]) => void;
  onCursor?: (idx: number | null, xMs: number | null) => void;
  yUnit?: string;
  yMin?: number;
  yMax?: number;
}

function buildData(rows: UPlotTimeChartProps['data'], series: UPlotSeries[]): uPlot.AlignedData {
  if (rows.length === 0) {
    return [[], ...series.map(() => [])] as unknown as uPlot.AlignedData;
  }
  const xs = new Array<number>(rows.length);
  for (let i = 0; i < rows.length; i++) xs[i] = rows[i].tsMs / 1000; // uPlot wants seconds
  const cols: (number | null)[][] = series.map(() => new Array(rows.length));
  for (let i = 0; i < rows.length; i++) {
    for (let s = 0; s < series.length; s++) {
      const v = rows[i][series[s].key];
      cols[s][i] = typeof v === 'number' ? v : null;
    }
  }
  return [xs, ...cols] as unknown as uPlot.AlignedData;
}

export function UPlotTimeChart({
  data, series, height, syncKey, domain, onZoom, onCursor, yUnit, yMin, yMax,
}: UPlotTimeChartProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const uRef = useRef<uPlot | null>(null);
  // Inline horizontal value lines + labels, mutated via DOM in setCursor.
  const valueLayerRef = useRef<HTMLDivElement | null>(null);
  const valueItemsRef = useRef<HTMLDivElement[]>([]);
  // Latest refs so the option hooks (created once at mount) see current values.
  const dataRef = useRef(data);
  dataRef.current = data;
  const seriesRef = useRef(series);
  seriesRef.current = series;
  const onZoomRef = useRef(onZoom);
  onZoomRef.current = onZoom;
  const onCursorRef = useRef(onCursor);
  onCursorRef.current = onCursor;
  // Mirror the domain so the data effect can decide whether to reset uPlot's
  // scale on a polling update (no zoom → fit new data; zoom active → keep it).
  const domainRef = useRef(domain);
  domainRef.current = domain;

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;

    // Only count data (non-watermark) series toward focus — single-data
    // charts shouldn't dim anything on hover even if a watermark is present.
    const dataSeriesCount = series.filter(s => !s.watermark).length;
    const opts: uPlot.Options = {
      width: el.clientWidth || 600,
      height,
      // [top, right, bottom, left] — generous right + bottom so the last
      // x-axis date label and the first/last y-axis tick don't get clipped.
      padding: [10, 20, 4, 6],
      scales: {
        x: { time: true },
        y: { auto: yMin == null && yMax == null, range: yMin != null || yMax != null ? [yMin ?? 0, yMax ?? 100] : undefined },
      },
      legend: { show: false },
      cursor: {
        sync: { key: syncKey, scales: ['x', null] },
        drag: { x: true, y: false, setScale: false },
        points: {
          size: 7,
          width: 1,
          stroke: () => '#ffffff',
          fill: () => '#ffffff',
        },
        x: true,
        y: false,
        // Series focus only matters when there's more than one *data* line.
        // Watermark series are visual reference (ceilings / max), not data.
        ...(dataSeriesCount > 1 ? { focus: { prox: 30 } } : {}),
      },
      axes: [
        {
          stroke: '#a1a1aa',
          grid: { stroke: 'rgba(63, 63, 70, 0.4)', width: 1 },
          ticks: { stroke: 'rgba(63, 63, 70, 0.6)', size: 4 },
          font: '11px ui-sans-serif, system-ui, sans-serif',
          // X-axis allotment — taller so the date string + tick has room
          // and the first/last labels aren't clipped against the edge.
          size: 36,
        },
        {
          stroke: '#a1a1aa',
          grid: { stroke: 'rgba(63, 63, 70, 0.4)', width: 1 },
          ticks: { stroke: 'rgba(63, 63, 70, 0.6)', size: 4 },
          font: '11px ui-sans-serif, system-ui, sans-serif',
          size: 48,
          values: yUnit ? (_u, vals) => vals.map(v => `${v}${yUnit}`) : undefined,
        },
      ],
      series: [
        { label: 'time' },
        ...series.map<uPlot.Series>(s => ({
          label: s.label,
          stroke: s.stroke,
          fill: s.fill,
          width: s.width ?? 1.5,
          dash: s.dash,
          paths: s.step ? uPlot.paths.stepped?.({ align: 1 }) : undefined,
          // Suppress dots drawn at every data sample (we only want the
          // cursor active dot, which is configured at the cursor level).
          points: { show: false },
        })),
      ],
      hooks: {
        setSelect: [(u) => {
          if (u.select.width > 3) {
            const minSec = u.posToVal(u.select.left, 'x');
            const maxSec = u.posToVal(u.select.left + u.select.width, 'x');
            onZoomRef.current?.([minSec * 1000, maxSec * 1000]);
            // Clear the visual selection — actual zoom is applied by parent
            // via the `domain` prop on the next render.
            u.setSelect({ left: 0, top: 0, width: 0, height: 0 }, false);
          }
        }],
        setCursor: [(u) => {
          const idx = u.cursor.idx;
          const layer = valueLayerRef.current;
          const items = valueItemsRef.current;
          if (idx == null) {
            onCursorRef.current?.(null, null);
            if (layer) layer.style.opacity = '0';
            return;
          }
          const xSec = u.data[0]?.[idx];
          onCursorRef.current?.(idx, typeof xSec === 'number' ? xSec * 1000 : null);
          // Inline horizontal value lines per data series. Position +
          // label updated via direct DOM — instant, no React re-render.
          if (!layer) return;
          layer.style.opacity = '1';
          const plotH = u.over.clientHeight || 0;
          for (let i = 0; i < items.length; i++) {
            const item = items[i];
            if (!item) continue;
            const sIdx = i + 1;
            const val = u.data[sIdx]?.[idx];
            if (val == null || typeof val !== 'number') {
              item.style.opacity = '0';
              continue;
            }
            const yPx = u.valToPos(val, 'y');
            item.style.opacity = '1';
            item.style.transform = `translate3d(0,${yPx}px,0)`;
            const label = item.firstChild?.nextSibling as HTMLElement | null;
            if (label) {
              const fmtVal = Math.abs(val) >= 100 ? val.toFixed(0)
                : Math.abs(val) >= 10 ? val.toFixed(1)
                : val.toFixed(2);
              label.textContent = `${fmtVal}${yUnit ?? ''}`;
              // Edge-flip: at top edge → label below the line.
              // At bottom edge → label above the line. Otherwise above.
              if (yPx < 18) {
                label.style.top = '6px';
                label.style.bottom = 'auto';
              } else if (yPx > plotH - 18) {
                label.style.top = 'auto';
                label.style.bottom = '6px';
              } else {
                label.style.top = 'auto';
                label.style.bottom = '6px';
              }
            }
          }
        }],
      },
    };

    const u = new uPlot(opts, buildData(data, series), el);
    uRef.current = u;

    // ────────────────────────────────────────────────────────────
    // Inline horizontal value lines per data series. Each non-
    // watermark series gets a dotted white line at its current
    // value + a color-matched label. Lives inside u.over (sized to
    // the plot area, so u.valToPos coords align). All updates are
    // direct DOM mutations in the setCursor hook — never React.
    // ────────────────────────────────────────────────────────────
    const valueLayer = document.createElement('div');
    valueLayer.style.cssText = 'position:absolute;inset:0;pointer-events:none;opacity:0;';
    const valueItems: HTMLDivElement[] = [];
    for (let i = 0; i < series.length; i++) {
      const s = series[i];
      if (s.watermark) { valueItems.push(null as unknown as HTMLDivElement); continue; }
      const item = document.createElement('div');
      // 1-based uPlot series index (series[0] is x-axis)
      item.dataset.sidx = String(i + 1);
      item.style.cssText = 'position:absolute;left:0;right:0;height:0;opacity:0;will-change:transform,opacity;';
      const line = document.createElement('div');
      line.style.cssText = 'position:absolute;left:0;right:0;top:-1px;height:0;border-top:1px dotted rgba(255,255,255,0.9);';
      item.appendChild(line);
      const label = document.createElement('span');
      label.dataset.role = 'lbl';
      label.style.cssText = `position:absolute;left:6px;padding:1px 5px;background:rgba(0,0,0,0.7);color:${s.stroke};font-size:11px;font-family:ui-monospace,monospace;border-radius:2px;white-space:nowrap;line-height:1.2;`;
      label.textContent = '—';
      item.appendChild(label);
      valueLayer.appendChild(item);
      valueItems.push(item);
    }
    u.over.appendChild(valueLayer);
    valueLayerRef.current = valueLayer;
    valueItemsRef.current = valueItems;

    const ro = new ResizeObserver(entries => {
      const w = entries[0]?.contentRect.width;
      if (w && uRef.current) {
        uRef.current.setSize({ width: Math.floor(w), height });
      }
    });
    ro.observe(el);

    return () => {
      ro.disconnect();
      u.destroy();
      uRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [height, syncKey, yUnit, yMin, yMax, series.length]);

  // Update data when rows change — uPlot.setData is canvas-only, no React.
  // Pass `false` to preserve scales when a zoom is active so polling new data
  // doesn't snap the view back to the full range and flicker.
  useEffect(() => {
    if (uRef.current) {
      uRef.current.setData(buildData(data, series), !domainRef.current);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data]);

  // Apply / clear zoom domain.
  useEffect(() => {
    const u = uRef.current;
    if (!u) return;
    if (domain) {
      u.setScale('x', { min: domain[0] / 1000, max: domain[1] / 1000 });
    } else {
      const xs = u.data[0];
      if (xs && xs.length > 0) {
        u.setScale('x', { min: xs[0] as number, max: xs[xs.length - 1] as number });
      }
    }
  }, [domain]);

  return <div ref={containerRef} style={{ width: '100%', height }} />;
}
