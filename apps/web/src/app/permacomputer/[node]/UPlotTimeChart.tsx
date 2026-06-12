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
  stroke: string;       // line color (any CSS color)
  fill?: string;        // area fill color (rgba recommended)
  width?: number;
  step?: boolean;       // step-after (for the claudes chart)
  dash?: number[];      // dashed line
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

    const opts: uPlot.Options = {
      width: el.clientWidth || 600,
      height,
      padding: [8, 12, 0, 0],
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
      },
      axes: [
        {
          stroke: '#a1a1aa',
          grid: { stroke: 'rgba(63, 63, 70, 0.4)', width: 1 },
          ticks: { stroke: 'rgba(63, 63, 70, 0.6)', size: 4 },
          font: '11px ui-sans-serif, system-ui, sans-serif',
          size: 30,
        },
        {
          stroke: '#a1a1aa',
          grid: { stroke: 'rgba(63, 63, 70, 0.4)', width: 1 },
          ticks: { stroke: 'rgba(63, 63, 70, 0.6)', size: 4 },
          font: '11px ui-sans-serif, system-ui, sans-serif',
          size: 44,
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
          if (idx == null) {
            onCursorRef.current?.(null, null);
            return;
          }
          const xSec = u.data[0]?.[idx];
          onCursorRef.current?.(idx, typeof xSec === 'number' ? xSec * 1000 : null);
        }],
      },
    };

    const u = new uPlot(opts, buildData(data, series), el);
    uRef.current = u;

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
