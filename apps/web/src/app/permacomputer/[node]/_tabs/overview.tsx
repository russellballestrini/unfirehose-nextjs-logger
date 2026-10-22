'use client';

import React from 'react';
import { TimeRangeSelect } from '@unturf/unfirehose-ui/TimeRangeSelect';
import { UPlotTimeChart, type UPlotSeries } from '@/components/UPlotTimeChart';
import { ThermalPanel } from '@/components/ThermalPanel';
import { GaugeTrack } from '@unturf/unfirehose-ui/Gauge';
import { KV } from '@unturf/unfirehose-ui/KV';
// uplot CSS is bundled by UPlotTimeChart's import
import { humanDelta } from '@unturf/unfirehose/ago';
import { formatBytes } from '@unturf/unfirehose/format';
import { Section, containerStatus, type TabProps } from './shared';

/* eslint-disable @typescript-eslint/no-explicit-any */

/** The Overview tab: system, memory, disks and the node charts. */
export function OverviewTab(props: TabProps) {
  const {
    applyZoom,
    chartData,
    chartDataRef,
    closestRangeForZoom,
    host,
    hoverTimerRef,
    liveDataMinMaxRef,
    loadPerCore,
    mem,
    memPct,
    node,
    probe,
    probeLoading,
    range,
    rangeRef,
    setHoverInfo,
    setRange,
    setZoomDomain,
    sys,
    viewMaxRef,
    viewMinRef,
    zoomDomain,
    zoomDrivenRangeRef,
  } = props;

  // The native mouse listener (attached at the document in the page) maps
  // pixel x -> time by reading these refs. They must track the current view,
  // but a ref write belongs in an effect, not in render. The listener only
  // fires on pointer events, long after paint, so a one-frame lag is
  // invisible; what matters is that the values are the latest committed ones.
  const chartHasData = Array.isArray(chartData) && chartData.length > 0;
  const chartDataMin = chartHasData ? chartData[0].tsMs : 0;
  const chartDataMax = chartHasData ? chartData[chartData.length - 1].tsMs : 0;
  const [viewMinEff, viewMaxEff] = zoomDomain ?? [chartDataMin, chartDataMax];
  React.useEffect(() => {
    if (!chartHasData) return;
    viewMinRef.current = viewMinEff;
    viewMaxRef.current = viewMaxEff;
    chartDataRef.current = chartData;
  }, [chartHasData, viewMinEff, viewMaxEff, chartData, viewMinRef, viewMaxRef, chartDataRef]);

  return (
    <div className="space-y-6">
      {/* min-w-0 on both tracks: a grid item defaults to min-width:auto, so
          long unbreakable content (a node's IPv6 address list, a compute
          process path) props the column open and pushes our whole page
          into horizontal overflow rather than wrapping inside its card. */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <div className="space-y-6 min-w-0">
          <Section title="System">
            {sys ? (
              <div className="grid grid-cols-2 gap-x-6 gap-y-2 text-sm">
                <KV label="CPU" value={sys.cpuModel?.replace(/\(R\)|\(TM\)/g, '').replace(/CPU\s+/i, '').trim()} />
                <KV label="Cores" value={`${sys.cpuCores}${sys.cpuMhz ? ` @ ${Math.round(sys.cpuMhz)}MHz` : ''}`} />
                <KV label="Architecture" value={sys.arch} />
                <KV label="Kernel" value={sys.kernel} />
                <KV label="OS" value={sys.os} />
                <KV label="Cache" value={sys.cpuCache} />
                {node?.cpuModel && <KV label="TDP" value={node.cpuTdpWatts ? `${node.cpuTdpWatts}W` : 'unknown'} />}
              </div>
            ) : probeLoading ? (
              <div className="text-sm text-[var(--color-muted)] animate-pulse">Probing...</div>
            ) : (
              <div className="text-sm text-[var(--color-error)]">{probe?.error ?? 'Probe failed'}</div>
            )}
          </Section>

          {probe?.loadAvg && (
            <Section title="CPU Load">
              <div className="space-y-2">
                <div className="flex justify-between text-sm text-[var(--color-muted)]">
                  <span>Load: {probe.loadAvg[0].toFixed(2)} / {probe.loadAvg[1].toFixed(2)} / {probe.loadAvg[2].toFixed(2)}</span>
                  <span>{probe.runnable}</span>
                </div>
                <GaugeTrack height="h-2" pct={Math.min(loadPerCore * 100, 100)} color={loadPerCore > 2 ? 'var(--color-error)' : '#f97316'} />
                <div className="text-xs text-[var(--color-muted)]">
                  {(loadPerCore * 100).toFixed(0)}% per-core utilization
                </div>
              </div>
            </Section>
          )}

          {mem && (
            <Section title="Memory">
              <div className="space-y-2">
                <div className="flex justify-between text-sm text-[var(--color-muted)]">
                  <span>{mem.usedGB.toFixed(1)}GB / {mem.totalGB.toFixed(1)}GB ({memPct.toFixed(0)}%)</span>
                  <span>{mem.availableGB.toFixed(1)}G available</span>
                </div>
                <GaugeTrack height="h-2" pct={memPct} color={memPct > 85 ? 'var(--color-error)' : '#60a5fa'} />
                <div className="flex gap-4 text-xs text-[var(--color-muted)] flex-wrap">
                  <span>buffers: {mem.buffersGB}G</span>
                  <span>cached: {mem.cachedGB}G</span>
                  <span>shmem: {mem.shmemGB}G</span>
                  {mem.dirtyMB > 0 && <span className="text-[var(--color-error)]">dirty: {mem.dirtyMB}MB</span>}
                </div>
                {mem.swapTotalGB > 0 && (
                  <div className="text-xs text-[var(--color-muted)]">
                    Swap: {mem.swapUsedGB}GB / {mem.swapTotalGB}GB
                    {mem.swapUsedGB > 0.1 && (
                      <span className="text-[var(--color-error)]"> ({((mem.swapUsedGB / mem.swapTotalGB) * 100).toFixed(0)}%)</span>
                    )}
                  </div>
                )}
              </div>
            </Section>
          )}

          {probe?.network?.interfaces?.length > 0 && (
            <Section title="Network">
              <div className="space-y-1">
                {probe.network.interfaces
                  .filter((i: any) => i.state === 'UP' && !i.name.startsWith('lo') && !i.name.startsWith('veth'))
                  .map((iface: any) => (
                  <div key={iface.name} className="flex items-start gap-3 text-sm">
                    <span className="w-2 h-2 rounded-full bg-green-500 shrink-0 mt-1.5" />
                    <span className="font-mono shrink-0">{iface.name}</span>
                    {/* A dual-stack interface carries a v4, a secondary v4
                        and a v6 on one line. Left unbreakable it props the
                        whole column open — break-all keeps it inside its
                        card instead of widening our page. */}
                    <span className="text-[var(--color-muted)] text-xs min-w-0 break-all">
                      {iface.addrs}
                    </span>
                  </div>
                ))}
              </div>
            </Section>
          )}

        </div>

        <div className="space-y-6 min-w-0">
          {probe?.disk?.length > 0 && (
            <Section title="Disk">
              <div className="space-y-2">
                {probe.disk.filter((d: any) => !d.device.startsWith('tmpfs')).map((d: any) => (
                  <div key={d.mount} className="space-y-1">
                    <div className="flex justify-between text-xs text-[var(--color-muted)]">
                      <span className="font-mono">{d.device}</span>
                      <span>{d.mount} &middot; {d.used}/{d.size} ({d.usePct}%)</span>
                    </div>
                    <GaugeTrack height="h-2" pct={d.usePct} color={d.usePct > 90 ? 'var(--color-error)' : d.usePct > 75 ? '#f97316' : '#22c55e'} />
                  </div>
                ))}
              </div>
            </Section>
          )}

          {probe?.gpu?.hasGpu && (
            <Section title="GPU">
              <div className="space-y-4">
                {probe.gpu.nvidia?.map((g: any, i: number) => {
                  // Field names here must track parseNvidiaGpu exactly. They
                  // did not: this block read g.temp/g.utilization/g.memUsed/
                  // g.power against a parser emitting tempC/gpuUtil/
                  // memUsedMB/powerDrawW, so every number rendered as
                  // undefined and only the card name survived.
                  const memPct = g.memTotalMB ? (g.memUsedMB / g.memTotalMB) * 100 : 0;
                  const powerPct = g.powerLimitW ? (g.powerDrawW / g.powerLimitW) * 100 : 0;
                  // nvidia-smi exposes no crit in our query. Consumer cards
                  // throttle around 83-88C, so grade against a nominal 85
                  // and mark it assumed rather than invent precision.
                  const tempPct = (g.tempC / 85) * 100;
                  const heat = tempPct >= 95 ? 'var(--color-error)' : tempPct >= 80 ? '#f97316' : '#22c55e';
                  return (
                    <div key={i} className="space-y-2">
                      <div className="flex justify-between items-baseline gap-2">
                        <span className="font-bold text-sm">{g.name}</span>
                        {g.pstate && (
                          <span className="text-xs text-[var(--color-muted)] font-mono" title="Performance state reported by nvidia-smi. P0 is maximum clocks, higher numbers step down; P8 is idle.">
                            {g.pstate}
                          </span>
                        )}
                      </div>

                      <div className="flex flex-wrap gap-4 text-sm">
                        <span title={`GPU die temperature. Graded against a nominal 85°C throttle point — nvidia-smi does not report this card's limit in our query.`}>
                          <span className="font-bold" style={{ color: heat }}>{g.tempC}°C</span>
                        </span>
                        {g.fanPct > 0 && (
                          <span className="text-[#22d3ee]" title="The card's own fan, as a percentage of maximum. Passive datacenter cards report 0 here and are cooled by chassis fans instead.">
                            {g.fanPct}% fan
                          </span>
                        )}
                        <span className="text-[var(--color-muted)]" title={`Power draw against this card's ${g.powerLimitW}W limit.`}>
                          {g.powerDrawW}W / {g.powerLimitW}W
                        </span>
                      </div>

                      <div className="space-y-1">
                        <div className="flex justify-between text-xs text-[var(--color-muted)]">
                          <span>VRAM</span>
                          <span>{(g.memUsedMB / 1024).toFixed(1)} / {(g.memTotalMB / 1024).toFixed(1)} GB ({memPct.toFixed(0)}%)</span>
                        </div>
                        <GaugeTrack height="h-2" pct={memPct} color={memPct > 90 ? 'var(--color-error)' : '#22c55e'} />
                      </div>

                      <div className="space-y-1">
                        <div className="flex justify-between text-xs text-[var(--color-muted)]">
                          <span>Utilization</span>
                          <span>{g.gpuUtil}% core &middot; {g.memUtil}% mem bus</span>
                        </div>
                        <GaugeTrack height="h-2" pct={g.gpuUtil} color="#22c55e" />
                      </div>

                      <div className="space-y-1">
                        <div className="flex justify-between text-xs text-[var(--color-muted)]">
                          <span>Power</span>
                          <span>{powerPct.toFixed(0)}% of limit</span>
                        </div>
                        <GaugeTrack height="h-2" pct={powerPct} color={powerPct > 90 ? '#f97316' : '#a78bfa'} />
                      </div>
                    </div>
                  );
                })}

                {probe.gpu.nvidiaProcesses?.length > 0 && (
                  <div className="pt-2 border-t border-[var(--color-border)]">
                    <div className="text-xs text-[var(--color-muted)] mb-2">
                      Compute processes ({probe.gpu.nvidiaProcesses.length})
                    </div>
                    <div className="space-y-1">
                      {probe.gpu.nvidiaProcesses.map((p: any) => (
                        <div key={p.pid} className="flex justify-between gap-2 text-xs">
                          <span className="font-mono truncate" title={p.name}>
                            {p.name?.split('/').pop() || p.name}
                          </span>
                          <span className="text-[var(--color-muted)] whitespace-nowrap">
                            {(p.memMB / 1024).toFixed(1)}G
                            <span className="ml-2 opacity-60">{p.pid}</span>
                          </span>
                        </div>
                      ))}
                    </div>
                  </div>
                )}
              </div>
            </Section>
          )}

          {probe?.containers?.length > 0 && (
            <Section title={
              <span className="flex items-center justify-between gap-3">
                <span>Containers ({probe.containers.length})</span>
                <a href="#Containers" className="text-xs font-normal normal-case tracking-normal text-[var(--color-accent)] hover:underline">details →</a>
              </span>
            }>
              <div className="space-y-2">
                {[...probe.containers]
                  .sort((a: any, b: any) => (b.resources?.cpuPct ?? -1) - (a.resources?.cpuPct ?? -1))
                  .slice(0, 6)
                  .map((c: any) => {
                  const { label, title } = containerStatus(c);
                  const r = c.resources;
                  return (
                  <div key={c.id} className="text-sm">
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className="font-bold">{c.name}</span>
                      {c.runtime && c.runtime !== 'docker' && (
                        <span className="text-[10px] font-mono px-1 rounded bg-[#60a5fa]/15 text-[#60a5fa]" title={`runtime: ${c.runtime}`}>{c.runtime}</span>
                      )}
                      <span className="text-xs text-[var(--color-muted)]" title={title}>{label}</span>
                      {r && (
                        <span className="text-xs font-mono text-[var(--color-muted)]">
                          {r.cpuPct != null && <span className={parseFloat(r.cpuPct) > 90 ? 'text-[var(--color-error)]' : ''}>{r.cpuPct}% cpu</span>}
                          {r.memUsed != null && <span> · {formatBytes(r.memUsed)}</span>}
                          {r.tasks != null && <span> · {r.tasks} tasks</span>}
                        </span>
                      )}
                    </div>
                    <div className="text-xs text-[var(--color-muted)] font-mono">
                      {[
                        c.image || (c.rootComm ? `runs ${c.rootComm}` : ''),
                        c.id ? String(c.id).slice(0, 12) : '',
                      ].filter(Boolean).join(' · ')}
                      {c.viaCgroup && <span title="Found via the cgroup filesystem — the docker socket was not granted, so name/image/ports are unavailable"> · via cgroup</span>}
                    </div>
                    {c.ports && <div className="text-xs text-[var(--color-muted)] font-mono">{c.ports}</div>}
                  </div>
                  );
                })}
                {probe.containers.length > 6 && (
                  <a href="#Containers" className="block text-xs font-mono text-[var(--color-accent)] hover:underline pt-1">
                    and {probe.containers.length - 6} more — see Containers tab →
                  </a>
                )}
              </div>
            </Section>
          )}
        </div>
      </div>

      {/* Thermal & cooling — full width: sensor bars plus temp/fan/clock charts */}
      <ThermalPanel
        host={host}
        temps={probe?.sensors?.temps ?? []}
        fans={probe?.sensors?.fans ?? []}
        throttle={probe?.throttle ?? null}
        gpus={probe?.gpu?.nvidia ?? []}
        topology={probe?.cpuTopology ?? null}
      />

      {/* Time-Series Charts */}
      {chartData.length > 0 && (() => {
        const tooltipStyle = { background: '#18181b', border: '1px solid #3f3f46', borderRadius: 4 };
        // Tooltip pinned at top-left so it never covers the data line.
        // No magnetic flip: that required a state update mid-mousemove, which
        // forced a parent re-render of all 8 charts — the source of chop.
        const tooltipPosition = { x: 60, y: 0 };
        const fmtLabel = (v: any) => {
          const n = typeof v === 'number' ? v : Number(v);
          if (!Number.isFinite(n)) return String(v);
          return new Date(n).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false });
        };
        const xAxisProps = {
          dataKey: 'tsMs',
          type: 'number' as const,
          scale: 'time' as const,
          domain: (zoomDomain ?? ['dataMin', 'dataMax']) as [number | string, number | string],
          tick: { fill: '#71717a', fontSize: 12 },
          tickFormatter: (ms: number) => new Date(ms).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false }),
          allowDataOverflow: true,
        };
        // recharts' built-in cursor and ReferenceArea are disabled — we render
        // our own DOM overlay so neither requires React re-renders during drag.

        const last = chartData[chartData.length - 1];

        const dataMin: number = chartData[0].tsMs;
        const dataMax: number = chartData[chartData.length - 1].tsMs;
        const [viewMin, viewMax] = zoomDomain ?? [dataMin, dataMax];
        // The refs the native mouse listener reads (viewMin/Max, chartData)
        // are written in an effect at the top of this component, not here —
        // a ref write during render is what the linter rightly objects to.
        const viewSpanMs = viewMax - viewMin;
        // The zoom window's width: "1d, 6h", never "1.3d".
        const fmtSpan = (ms: number) => humanDelta(ms, { abbreviate: true, smallest: 'second' });
        const zoomBy = (factor: number) => {
          const mid = (viewMin + viewMax) / 2;
          const half = (viewSpanMs * factor) / 2;
          let a = mid - half, b = mid + half;
          if (a <= dataMin && b >= dataMax) { setZoomDomain(null); return; }
          a = Math.max(dataMin, a);
          b = Math.min(dataMax, b);
          if (b - a < 1000) return;
          applyZoom(a, b);
        };
        const zoomIn = () => zoomBy(0.5);
        const zoomOut = () => zoomBy(2);
        const resetZoom = () => setZoomDomain(null);
        // Pan: shift visible window by ½ span. Uses functional setState
        // so rapid clicks chain correctly (React batching otherwise gives
        // every click the same starting zoom).
        //
        // Crucially: when pan-left would push the view past dataMin, we
        // BUMP the range dropdown up to the next option whose ms covers
        // [newMin, dataMax]. SWR refetches with the wider window, the
        // chart fills in. So pressing < repeatedly cascades through the
        // ranges (1h → 3h → 6h → 12h → 24h → 7d → 14d → 28d → lifetime)
        // until reaching the absolute oldest data.
        const panBy = (fraction: number) => {
          setZoomDomain((prev: any) => {
            if (!prev) {
              const half = (dataMax - dataMin) / 2;
              if (fraction < 0) return [dataMin, dataMin + half];
              return [dataMax - half, dataMax];
            }
            const [curMin, curMax] = prev;
            const span = curMax - curMin;
            if (span <= 0) return prev;
            const delta = span * fraction;
            let a = curMin + delta, b = curMax + delta;
            // Use LIVE data bounds (not deferred chartData's) so we don't
            // falsely think we ran out of data just because deferred
            // timeline hasn't caught up to SWR yet.
            const liveMin = liveDataMinMaxRef.current.min || dataMin;
            const liveMax = liveDataMinMaxRef.current.max || dataMax;
            // Right clamp — never pan into future data that doesn't exist.
            if (b > liveMax) { a -= b - liveMax; b = liveMax; }
            // Left underflow: bump range only when we're REALLY out of data.
            if (a < liveMin) {
              if (rangeRef.current !== 'all') {
                const next = closestRangeForZoom(liveMax - a);
                if (next !== rangeRef.current) {
                  zoomDrivenRangeRef.current = true;
                  setRange(next);
                }
                // Keep the requested bounds; uPlot fills in when SWR returns.
                return [a, b];
              }
              // At lifetime — clamp at the oldest data we have.
              b += liveMin - a;
              a = liveMin;
            }
            if (a < liveMin) a = liveMin;
            if (b - a < 1000) return prev;
            if (a === liveMin && b === liveMax) return null;
            return [a, b];
          });
        };
        const panLeft = () => panBy(-0.5);
        const panRight = () => panBy(0.5);
        // Left disabled only when we've already exhausted history: range
        // is lifetime AND the zoom (if any) already sits at dataMin. Any
        // other case can still navigate.
        const atOldestEdge = range === 'all' && zoomDomain != null && zoomDomain[0] <= dataMin + 1000;
        const canPanLeft = chartData.length > 0 && !atOldestEdge;
        // Right disabled when forecast is already visible (no zoom, OR
        // zoom's right edge already at dataMax).
        const canPanRight = zoomDomain != null && zoomDomain[1] < dataMax;

        const tz = typeof window !== 'undefined' ? Intl.DateTimeFormat().resolvedOptions().timeZone : 'UTC';
        return (
        <div className="mt-8 space-y-4">
          <div className="flex items-center justify-between flex-wrap gap-2">
            <h2 className="text-lg font-bold">
              History <span className="text-xs font-normal text-[var(--color-muted)] opacity-60 ml-1">{tz}</span>
              <span className="text-xs font-normal text-[var(--color-muted)] ml-2">
                showing {fmtSpan(viewSpanMs)}{zoomDomain && ' (zoomed)'}
              </span>
            </h2>
            <div className="flex items-center gap-2">
              <div className="flex items-center border border-[var(--color-border)] rounded overflow-hidden text-xs">
                <button onClick={panLeft} disabled={!canPanLeft} title="Pan left ½ screen"
                  className="px-2 py-1 hover:bg-[var(--color-surface)] cursor-pointer font-bold disabled:opacity-40 disabled:cursor-not-allowed">‹</button>
                <button onClick={zoomOut} title="Zoom out 2×"
                  className="px-2 py-1 hover:bg-[var(--color-surface)] cursor-pointer border-l border-[var(--color-border)] font-bold">−</button>
                <button onClick={zoomIn} title="Zoom in 2×"
                  className="px-2 py-1 hover:bg-[var(--color-surface)] cursor-pointer border-l border-[var(--color-border)] font-bold">+</button>
                <button onClick={panRight} disabled={!canPanRight} title="Pan right ½ screen"
                  className="px-2 py-1 hover:bg-[var(--color-surface)] cursor-pointer border-l border-[var(--color-border)] font-bold disabled:opacity-40 disabled:cursor-not-allowed">›</button>
                <button onClick={resetZoom} disabled={!zoomDomain}
                  title="Reset zoom to full range"
                  className="px-2 py-1 hover:bg-[var(--color-surface)] cursor-pointer border-l border-[var(--color-border)] disabled:opacity-40 disabled:cursor-not-allowed">
                  reset
                </button>
              </div>
              <TimeRangeSelect value={range} onChange={setRange} />
            </div>
          </div>
          <p className="text-xs text-[var(--color-muted)] -mt-2">
            Drag horizontally across any chart to zoom into that window. Use −/+ to step, reset to restore.
          </p>

          {/* Per-chart inline horizontal value lines (drawn by uPlot's
              setCursor hook) replace the shared hover row — updates are
              DOM-direct so values appear with the cursor, no React work. */}

          {(() => {
            // uPlot chart engine — canvas, no React reconciliation per data tick.
            const SYNC = 'mesh-node-detail';
            const handleZoom = (range: [number, number]) => {
              applyZoom(range[0], range[1]);
            };
            const handleCursor = (idx: number | null) => {
              if (idx == null) {
                if (hoverTimerRef.current) clearTimeout(hoverTimerRef.current);
                setHoverInfo(null);
                return;
              }
              if (hoverTimerRef.current) clearTimeout(hoverTimerRef.current);
              hoverTimerRef.current = setTimeout(() => {
                const row = chartDataRef.current[idx];
                if (row) setHoverInfo(row);
              }, 80);
            };
            const cardCls = 'bg-[var(--color-surface)] rounded border border-[var(--color-border)] p-4';
            const titleCls = 'text-base font-bold mb-3 text-[var(--color-muted)]';
            const hasGpuUtil = chartData.some((t: any) => t.gpuUtil > 0 || t.gpuWatts > 0);
            const hasGpuMem = chartData.some((t: any) => t.gpuMemTotalGB > 0);
            const hasGpuPower = chartData.some((t: any) => t.gpuWatts > 0);
            return (
              <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
                <div className={cardCls}>
                  <h3 className={titleCls}>CPU Load <span className="text-xs font-normal ml-2">{last.load.toFixed(1)} / {last.cores} cores</span></h3>
                  <UPlotTimeChart data={chartData} height={180} syncKey={SYNC} domain={zoomDomain} onZoom={handleZoom} onCursor={handleCursor}
                    series={[
                      { key: 'cores', label: 'Total Cores', stroke: '#52525b', fill: 'rgba(82,82,91,0.18)', watermark: true },
                      { key: 'load', label: 'Load Average', stroke: '#f97316', fill: 'rgba(249,115,22,0.25)' },
                    ]} />
                </div>

                <div className={cardCls}>
                  <h3 className={titleCls}>Memory Usage <span className="text-xs font-normal ml-2">{last.memUsedGB} / {last.memCapGB || last.memTotalGB || '?'} GB</span></h3>
                  <UPlotTimeChart data={chartData} height={180} syncKey={SYNC} domain={zoomDomain} onZoom={handleZoom} onCursor={handleCursor} yUnit="GB"
                    yMin={0}
                    series={[
                      { key: 'memCapGB', label: 'Cap', stroke: '#52525b', fill: 'rgba(82,82,91,0.18)', watermark: true },
                      { key: 'memUsedGB', label: 'Used', stroke: '#60a5fa', fill: 'rgba(96,165,250,0.28)' },
                    ]} />
                </div>

                {hasGpuUtil && (
                  <div className={cardCls}>
                    <h3 className={titleCls}>GPU Utilization <span className="text-xs font-normal ml-2">{last.gpuUtil}%</span></h3>
                    <UPlotTimeChart data={chartData} height={180} syncKey={SYNC} domain={zoomDomain} onZoom={handleZoom} onCursor={handleCursor} yUnit="%" yMin={0} yMax={100}
                      series={[{ key: 'gpuUtil', label: 'GPU Util', stroke: '#22c55e', fill: 'rgba(34,197,94,0.28)' }]} />
                  </div>
                )}

                {hasGpuMem && (
                  <div className={cardCls}>
                    <h3 className={titleCls}>GPU Memory <span className="text-xs font-normal ml-2">{last.gpuMemUsedGB} / {last.gpuMemTotalGB} GB</span></h3>
                    <UPlotTimeChart data={chartData} height={180} syncKey={SYNC} domain={zoomDomain} onZoom={handleZoom} onCursor={handleCursor} yUnit="GB"
                      series={[
                        { key: 'gpuMemTotalGB', label: 'Total', stroke: '#52525b', fill: 'rgba(82,82,91,0.18)', watermark: true },
                        { key: 'gpuMemUsedGB', label: 'Used', stroke: '#22c55e', fill: 'rgba(34,197,94,0.28)' },
                      ]} />
                  </div>
                )}

                {hasGpuPower && (
                  <div className={cardCls}>
                    <h3 className={titleCls}>GPU Power <span className="text-xs font-normal ml-2">{last.gpuWatts}W</span></h3>
                    <UPlotTimeChart data={chartData} height={180} syncKey={SYNC} domain={zoomDomain} onZoom={handleZoom} onCursor={handleCursor} yUnit="W"
                      series={[{ key: 'gpuWatts', label: 'GPU Power', stroke: '#a78bfa', fill: 'rgba(167,139,250,0.25)' }]} />
                  </div>
                )}

                <div className={cardCls}>
                  <h3 className={titleCls}>Electricity Cost <span className="text-xs font-normal ml-2">${last.elecCostPerHour.toFixed(3)}/hr · ~${(last.elecCostPerHour * 24 * 30).toFixed(0)}/mo</span></h3>
                  <UPlotTimeChart data={chartData} height={140} syncKey={SYNC} domain={zoomDomain} onZoom={handleZoom} onCursor={handleCursor}
                    series={[{ key: 'elecCostPerHour', label: '$/hr', stroke: '#facc15', fill: 'rgba(250,204,21,0.20)' }]} />
                </div>

                <div className={cardCls}>
                  <h3 className={titleCls}>Compute Wattage <span className="text-xs font-normal ml-2">{last.watts}W current</span></h3>
                  <UPlotTimeChart data={chartData} height={180} syncKey={SYNC} domain={zoomDomain} onZoom={handleZoom} onCursor={handleCursor} yUnit="W"
                    series={[
                      { key: 'watts', label: 'Total', stroke: '#d40000', width: 2 },
                      { key: 'cpuWatts', label: 'CPU', stroke: '#f97316', width: 1.5 },
                      ...(hasGpuPower ? [{ key: 'gpuWatts', label: 'GPU', stroke: '#a78bfa', width: 1.5 } as UPlotSeries] : []),
                    ]} />
                </div>

                <div className={cardCls}>
                  <h3 className={titleCls}>Active Agents <span className="text-xs font-normal ml-2">{last.agents ?? last.claudes} current</span></h3>
                  <UPlotTimeChart data={chartData} height={140} syncKey={SYNC} domain={zoomDomain} onZoom={handleZoom} onCursor={handleCursor}
                    series={[{ key: 'agents', label: 'Agents', stroke: '#d40000', fill: 'rgba(212,0,0,0.20)', step: true }]} />
                </div>
              </div>
            );
          })()}

        </div>
        );
      })()}
    </div>
  );
}
