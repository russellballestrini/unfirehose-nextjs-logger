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
  // Fraction of the visible time span to leave as empty future space on
  // the right edge. Defaults to 5% — visual breathing room AND a slot for
  // forecasting overlays. Ignored when a zoom domain is explicitly set.
  futurePadFraction?: number;
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
  futurePadFraction = 0.05,
}: UPlotTimeChartProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const uRef = useRef<uPlot | null>(null);
  // Inline horizontal value lines + labels, mutated via DOM in setCursor.
  const valueLayerRef = useRef<HTMLDivElement | null>(null);
  const valueItemsRef = useRef<HTMLDivElement[]>([]);
  // Vertical reference lines: "now" at the edge of real data, and the
  // sliding forecast-window edge at scaleMax.
  const nowLineRef = useRef<HTMLDivElement | null>(null);
  const forecastEdgeRef = useRef<HTMLDivElement | null>(null);
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
          // Denser ticks than uPlot's default ~50px. At ~680px chart width
          // this means ~17 tick slots which lands at 5m / 15m / 30m / 1h /
          // 2h / 12h for the 1h / 3h / 6h / 12h / 24h / 7d windows.
          space: 40,
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

    // Inline-style uPlot's drag-zoom selection rectangle to translucent
    // purple. Inline beats any CSS specificity, so this is the bulletproof
    // way to win the cascade regardless of how Next.js orders the
    // uPlot.min.css and globals.css bundles.
    const selectEl = el.querySelector<HTMLElement>('.u-select');
    if (selectEl) {
      selectEl.style.background = 'rgba(167, 139, 250, 0.22)';
      selectEl.style.border = '1px solid rgba(167, 139, 250, 0.55)';
    }

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

    // ─── "now" line at edge of real data + forecast-window edge ───
    const nowLine = document.createElement('div');
    nowLine.style.cssText = 'position:absolute;top:0;bottom:0;left:0;width:0;border-left:1px dashed rgba(252,211,77,0.55);transform:translate3d(-1px,0,0);will-change:transform;pointer-events:none;';
    const nowLabel = document.createElement('span');
    nowLabel.textContent = 'now';
    nowLabel.style.cssText = 'position:absolute;top:4px;left:4px;font-size:10px;font-family:ui-monospace,monospace;color:rgba(252,211,77,0.9);background:rgba(0,0,0,0.6);padding:1px 4px;border-radius:2px;white-space:nowrap;';
    nowLine.appendChild(nowLabel);
    u.over.appendChild(nowLine);
    nowLineRef.current = nowLine;

    const forecastEdge = document.createElement('div');
    forecastEdge.style.cssText = 'position:absolute;top:0;bottom:0;left:0;width:0;border-left:1px dotted rgba(167,139,250,0.4);transform:translate3d(-1px,0,0);will-change:transform;pointer-events:none;';
    u.over.appendChild(forecastEdge);
    forecastEdgeRef.current = forecastEdge;

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
  // Pass `false` so uPlot never auto-fits the scale; the effect below owns
  // scale (and adds the future-pad on the right when no zoom is active).
  useEffect(() => {
    if (uRef.current) {
      uRef.current.setData(buildData(data, series), false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data]);

  // Apply zoom domain (or auto-fit) and always add a future-pad on the
  // right edge, snapped up to a nice time tick. Applies regardless of zoom
  // state — when panned, the new visible window still gets forecast space
  // and a labeled tick. The "now" line tracks the latest data point and
  // hides itself when scrolled out of view.
  useEffect(() => {
    const u = uRef.current;
    if (!u) return;
    const xs = u.data[0];
    if (!xs || xs.length === 0) return;
    const dataMin = xs[0] as number;
    const dataMax = xs[xs.length - 1] as number;

    let viewMin: number, viewMax: number;
    if (domain) {
      viewMin = domain[0] / 1000;
      viewMax = domain[1] / 1000;
    } else {
      viewMin = dataMin;
      viewMax = dataMax;
    }
    const rawPad = (viewMax - viewMin) * (futurePadFraction ?? 0);
    const targetMax = viewMax + rawPad;
    // Nice time increments (seconds). Snap up to the next boundary so a
    // tick label always lands in the forecast zone.
    const NICE_TIME_S = [60, 300, 600, 900, 1800, 3600, 7200, 14400, 21600, 43200, 86400, 172800, 604800];
    const viewSpan = targetMax - viewMin;
    const idealIncr = viewSpan / 10;
    let snapIncr = NICE_TIME_S[NICE_TIME_S.length - 1];
    for (const i of NICE_TIME_S) { if (i >= idealIncr) { snapIncr = i; break; } }
    const snappedMax = Math.ceil(targetMax / snapIncr) * snapIncr;
    u.setScale('x', { min: viewMin, max: snappedMax });

    // "now" line at dataMax. Hide when scrolled left of the visible window.
    const nowLine = nowLineRef.current;
    if (nowLine) {
      if (dataMax >= viewMin && dataMax <= snappedMax) {
        const xPx = u.valToPos(dataMax, 'x');
        nowLine.style.transform = `translate3d(${xPx}px,0,0)`;
        nowLine.style.opacity = '1';
      } else {
        nowLine.style.opacity = '0';
      }
    }
    // Forecast-window edge always at snappedMax.
    const forecastEdge = forecastEdgeRef.current;
    if (forecastEdge) {
      const xPx = u.valToPos(snappedMax, 'x');
      forecastEdge.style.transform = `translate3d(${xPx}px,0,0)`;
      forecastEdge.style.opacity = '1';
    }
  }, [domain, data, futurePadFraction]);

  return <div ref={containerRef} style={{ width: '100%', height }} />;
}
