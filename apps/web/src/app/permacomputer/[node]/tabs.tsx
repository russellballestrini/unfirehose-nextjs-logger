'use client';



import Link from 'next/link';
import React from 'react';
import { TimeRangeSelect } from '@unturf/unfirehose-ui/TimeRangeSelect';
import { UPlotTimeChart, type UPlotSeries } from '@/components/UPlotTimeChart';
import { ThermalPanel } from '@/components/ThermalPanel';
import { AXIS_TICK_SM } from '@unturf/unfirehose-ui/chart-theme';
import { ansiToHtml } from '@unturf/unfirehose-ui/ansi';
import { GaugeTrack } from '@unturf/unfirehose-ui/Gauge';
import { KV } from '@unturf/unfirehose-ui/KV';
// uplot CSS is bundled by UPlotTimeChart's import
import { harnessesFor } from '@/lib/harnesses';
import { HarnessPicker } from '@/components/HarnessPicker';

const HARNESSES = harnessesFor('node');


/* eslint-disable @typescript-eslint/no-explicit-any */



/** The Settings tab. */

/**
 * What every tab on this page is handed.
 *
 * All five destructured the same names regardless of which they used, so
 * the list appeared five times and had to be kept in step by hand. Each
 * tab now names what it reads, which is the only record of what it
 * depends on.
 */
interface TabProps {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  [key: string]: any;
}

export function SettingsTab(props: TabProps) {
  const {
    diskOverride,
    host,
    ispCost,
    kwhRate,
    node,
    saveSetting,
    saveSshHost,
    setDiskOverride,
    setIspCost,
    setKwhRate,
    setSshEditing,
    setSshForm,
    setWattsOverride,
    sshEditing,
    sshForm,
    sshSaving,
    wattsOverride,
  } = props;
  return (
      <div className="max-w-lg">
        <Section title="Cost Tunables">
          <div className="space-y-3">
            <TunableRow label="Electricity rate" unit="$/kWh" step={0.01}
              value={kwhRate}
              onChange={(v) => { setKwhRate(v); saveSetting(`electricity_rate_${host}`, String(v)); }}
            />
            <TunableRow label="ISP cost" unit="$/mo" step={1}
              value={ispCost}
              onChange={(v) => { setIspCost(v); saveSetting(`isp_cost_${host}`, String(v)); }}
            />
            <TunableRow label="Spinning disks" unit="HDDs" step={1}
              value={diskOverride ?? ''}
              placeholder={String(node?.spinningDisks ?? 0)}
              onChange={(v) => { setDiskOverride(v || undefined); saveSetting(`disk_override_${host}`, String(v)); }}
            />
            <TunableRow label="Watts override" unit="W" step={1}
              value={wattsOverride ?? ''}
              placeholder="auto"
              onChange={(v) => { setWattsOverride(v || undefined); saveSetting(`watts_override_${host}`, String(v)); }}
            />
            <div className="text-xs text-[var(--color-muted)] pt-1">
              Auto-detected: {node?.spinningDisks ?? '?'} HDDs, {node?.ssdCount ?? '?'} SSDs via lsblk
              {node?.cpuTdpWatts && <> &middot; {node.cpuTdpWatts}W CPU TDP</>}
            </div>
          </div>
        </Section>

        <Section title="SSH Configuration">
          {!sshEditing ? (
            <div className="space-y-2">
              <div className="grid grid-cols-2 gap-x-6 gap-y-1 text-sm">
                <KV label="Host" value={sshForm.name} />
                <KV label="Hostname" value={sshForm.hostname || host} />
                <KV label="Port" value={sshForm.port || '22'} />
                <KV label="User" value={sshForm.user || '(default)'} />
                <KV label="Identity File" value={sshForm.identityFile || '(default)'} />
                <KV label="Forward Agent" value={sshForm.forwardAgent || 'no'} />
              </div>
              <button
                onClick={() => setSshEditing(true)}
                className="text-xs text-[var(--color-accent)] hover:underline cursor-pointer mt-2"
              >
                Edit SSH Config
              </button>
            </div>
          ) : (
            <div className="space-y-3">
              <SshField label="Host (alias)" value={sshForm.name}
                onChange={(v) => setSshForm((f: any) => ({ ...f, name: v }))} />
              <SshField label="Hostname" value={sshForm.hostname ?? ''} placeholder={host}
                onChange={(v) => setSshForm((f: any) => ({ ...f, hostname: v || undefined }))} />
              <SshField label="Port" value={sshForm.port ?? ''} placeholder="22"
                onChange={(v) => setSshForm((f: any) => ({ ...f, port: v || undefined }))} />
              <SshField label="User" value={sshForm.user ?? ''} placeholder="(default)"
                onChange={(v) => setSshForm((f: any) => ({ ...f, user: v || undefined }))} />
              <SshField label="Identity File" value={sshForm.identityFile ?? ''} placeholder="~/.ssh/id_rsa"
                onChange={(v) => setSshForm((f: any) => ({ ...f, identityFile: v || undefined }))} />
              <div className="flex items-center gap-2">
                <span className="text-sm text-[var(--color-muted)] w-32">Forward Agent</span>
                <label className="flex items-center gap-2 text-sm cursor-pointer">
                  <input
                    type="checkbox"
                    checked={sshForm.forwardAgent === 'yes'}
                    onChange={(e) => setSshForm((f: any) => ({ ...f, forwardAgent: e.target.checked ? 'yes' : undefined }))}
                    className="accent-[var(--color-accent)]"
                  />
                  <span className="text-[var(--color-muted)]">yes</span>
                </label>
              </div>
              <div className="flex gap-2 pt-1">
                <button
                  onClick={saveSshHost}
                  disabled={sshSaving || !sshForm.name.trim()}
                  className="px-4 py-1.5 text-sm font-bold bg-[var(--color-accent)] text-[var(--color-background)] rounded hover:opacity-90 disabled:opacity-40 cursor-pointer"
                >
                  {sshSaving ? 'Saving...' : 'Save'}
                </button>
                <button
                  onClick={() => setSshEditing(false)}
                  className="px-4 py-1.5 text-sm text-[var(--color-muted)] hover:text-[var(--color-foreground)] cursor-pointer"
                >
                  Cancel
                </button>
              </div>
            </div>
          )}
        </Section>
      </div>
  );
}

/** The Bootstrap tab. */
export function BootstrapTab(props: TabProps) {
  const { bootFilter, bootHarness, bootHost, bootStatuses, isLocal, setBootFilter } = props;
  return (
    <HarnessPicker
      harnesses={HARNESSES}
      filter={bootFilter}
      setFilter={setBootFilter}
      statuses={bootStatuses}
      onBoot={bootHarness}
      header={
        <span className="text-sm text-[var(--color-muted)]">
          target: <span className="font-mono text-[var(--color-foreground)]">{bootHost}</span>
        </span>
      }
      footer={
        <>
          Installs and verifies harnesses on {bootHost}. For claude-code, also syncs OAuth credentials.
          {!isLocal && ' Requires SSH key access.'}
        </>
      }
    />
  );
}

/** The Processes tab. */
export function ProcessesTab(props: TabProps) {
  const { mem, probe } = props;
  return (
      <div className="space-y-6">
        {(probe?.sessions?.tmux?.length > 0 || probe?.sessions?.screen?.length > 0) && (
          <Section title="Sessions">
            {probe.sessions.tmux?.map((s: any) => (
              <div key={s.name} className="text-sm">
                <span className="font-mono">tmux: {s.name}</span>
                <span className="text-xs text-[var(--color-muted)]"> ({s.windows} windows)</span>
              </div>
            ))}
            {probe.sessions.screen?.map((s: any) => (
              <div key={s.name} className="text-sm">
                <span className="font-mono">screen: {s.name}</span>
              </div>
            ))}
          </Section>
        )}

        {probe?.processes?.length > 0 ? (
          <Section title={`Top Processes (${Array.isArray(probe.harnessProcesses) ? probe.harnessProcesses.length : Array.isArray(probe.claudeProcesses) ? probe.claudeProcesses.length : probe.claudeProcesses ?? 0} agents)`}>
            <div className="overflow-x-auto">
              <table className="w-full text-xs">
                <thead>
                  <tr className="text-[var(--color-muted)] text-left">
                    <th className="pb-1 pr-3">USER</th>
                    <th className="pb-1 pr-3 text-right">CPU%</th>
                    <th className="pb-1 pr-3 text-right">MEM%</th>
                    <th className="pb-1 pr-3 text-right">RSS</th>
                    <th className="pb-1">COMMAND</th>
                  </tr>
                </thead>
                <tbody>
                  {probe.processes.slice(0, 40).map((p: any, i: number) => (
                    <tr key={i} className="border-t border-[var(--color-border)]">
                      <td className="py-0.5 pr-3 text-[var(--color-muted)]">{p.user}</td>
                      <td className={`py-0.5 pr-3 text-right ${parseFloat(p.cpu) > 50 ? 'text-[var(--color-error)]' : ''}`}>{p.cpu}</td>
                      <td className="py-0.5 pr-3 text-right">{p.mem}</td>
                      <td className="py-0.5 pr-3 text-right text-[var(--color-muted)]">{p.rss}</td>
                      <td className="py-0.5 font-mono truncate max-w-[500px]">{p.command}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Section>
        ) : (
          <div className="text-sm text-[var(--color-muted)]">No process data available.</div>
        )}
      </div>
  );
}


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
            <Section title={`Containers (${probe.containers.length})`}>
              <div className="space-y-2">
                {probe.containers.map((c: any) => (
                  <div key={c.id} className="text-sm">
                    <div className="flex items-center gap-2">
                      <span className="font-bold">{c.name}</span>
                      <span className="text-xs text-[var(--color-muted)]">{c.status}</span>
                    </div>
                    <div className="text-xs text-[var(--color-muted)]">{c.image}</div>
                    {c.ports && <div className="text-xs text-[var(--color-muted)] font-mono">{c.ports}</div>}
                  </div>
                ))}
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
        // Refs that the native mouse listener (outside this IIFE) reads to
        // map pixel x → time and look up the nearest data point for the
        // hover-details row. Mutating refs during render is safe.
        viewMinRef.current = viewMin;
        viewMaxRef.current = viewMax;
        chartDataRef.current = chartData;
        const viewSpanMs = viewMax - viewMin;
        const fmtSpan = (ms: number) => {
          if (ms < 60_000) return `${Math.round(ms / 1000)}s`;
          if (ms < 3_600_000) return `${Math.round(ms / 60_000)}m`;
          if (ms < 86_400_000) return `${(ms / 3_600_000).toFixed(1)}h`;
          return `${(ms / 86_400_000).toFixed(1)}d`;
        };
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

/** The Harnesses tab: tmux sessions and bare agent processes. */
export function HarnessesTab(props: TabProps) {
  const {
    host,
    isLocal,
    mem,
    node,
    previewContent,
    previewRef,
    previewSession,
    probe,
    setPreviewSession,
    tmuxData,
  } = props;
      // tmuxData comes from /api/tmux/stream (with host param for remote)
      const sessions: string[] = tmuxData?.sessions ?? [];
      const tmuxEntries = sessions.map((s: string) => ({ name: s, type: 'tmux' as const }));

      // Bare agent processes (not in tmux) from probe data. Was
      // claudeProcesses only, so a node running five uncloseai-cli agents
      // showed "Bare Processes (0)" — uncloseai-cli runs as python3 and never
      // matched. harnessProcesses carries every harness; fall back for probes
      // captured before it existed.
      const claudeProcs: any[] = Array.isArray(probe?.harnessProcesses)
        ? probe.harnessProcesses
        : Array.isArray(probe?.claudeProcesses) ? probe.claudeProcesses : [];
      const bareEntries = claudeProcs.map((p: any) => ({
        name: `${p.harness ?? 'claude'} (PID ${p.pid})`,
        type: 'process' as const,
        pid: p.pid,
        tty: p.tty,
        cpu: p.cpu,
        mem: p.mem,
        start: p.start,
        command: (p.command ?? '').slice(0, 120),
      }));

      const allEntries = [...tmuxEntries, ...bareEntries];

      return (
        <div className="space-y-4">
          {allEntries.length === 0 && (
            <div className="text-sm text-[var(--color-muted)] text-center py-8 bg-[var(--color-surface)] rounded border border-[var(--color-border)]">
              No harnesses running on {host}.
            </div>
          )}

          {tmuxEntries.length > 0 && (
            <div className="grid grid-cols-1 gap-3">
              <h3 className="text-xs font-bold text-[var(--color-muted)] uppercase tracking-wide">Tmux Sessions ({tmuxEntries.length})</h3>
              {tmuxEntries.map(s => {
                const isActive = previewSession === s.name;

                return (
                  <div
                    key={s.name}
                    onClick={() => setPreviewSession(isActive ? null : s.name)}
                    className={`bg-[var(--color-surface)] rounded border p-4 transition-colors cursor-pointer ${
                      isActive ? 'border-[var(--color-accent)]' :
                      'border-[var(--color-border)] hover:border-[var(--color-accent)]/50'
                    }`}
                  >
                    <div className="flex items-center justify-between">
                      <div className="flex items-center gap-2">
                        <span className="w-2 h-2 rounded-full bg-green-400 animate-pulse" />
                        <span className="font-bold font-mono text-sm">{s.name}</span>
                      </div>
                      <div className="flex items-center gap-2" onClick={(e) => e.stopPropagation()}>
                        {isLocal && (
                          <Link
                            href={`/tmux/${encodeURIComponent(s.name)}`}
                            className="text-xs px-2 py-1 rounded bg-[var(--color-accent)] text-[var(--color-background)] font-bold hover:opacity-90 transition-opacity"
                          >
                            Full View
                          </Link>
                        )}
                        {!isLocal && (
                          <>
                            <Link
                              href={`/tmux/${encodeURIComponent(s.name)}?host=${encodeURIComponent(host)}`}
                              className="text-xs px-2 py-1 rounded bg-[var(--color-accent)] text-[var(--color-background)] font-bold hover:opacity-90 transition-opacity"
                            >
                              Watch
                            </Link>
                            <span className="text-xs text-[var(--color-muted)] font-mono">
                              ssh {host} -t tmux attach -t {s.name}
                            </span>
                          </>
                        )}
                      </div>
                    </div>

                    {/* Inline preview — shown when card is clicked */}
                    {isActive && (
                      <pre
                        ref={previewRef}
                        onClick={(e) => e.stopPropagation()}
                        className="mt-3 bg-[#0d0d0d] rounded border border-[var(--color-border)] p-3 overflow-auto max-h-[60vh] font-mono text-xs leading-relaxed text-[#d4d4d4] whitespace-pre"
                        dangerouslySetInnerHTML={{ __html: previewContent ? ansiToHtml(previewContent) : 'Connecting...' }}
                      />
                    )}
                  </div>
                );
              })}
            </div>
          )}

          {bareEntries.length > 0 && (
            <div className="space-y-3">
              <h3 className="text-xs font-bold text-[var(--color-muted)] uppercase tracking-wide">Bare Processes ({bareEntries.length})</h3>
              <div className="grid grid-cols-1 gap-2">
                {bareEntries.map(p => (
                  <div
                    key={p.pid}
                    className="bg-[var(--color-surface)] rounded border border-[var(--color-border)] p-3"
                  >
                    <div className="flex items-center justify-between">
                      <div className="flex items-center gap-2">
                        <span className="w-2 h-2 rounded-full bg-yellow-400 animate-pulse" />
                        <span className="font-bold font-mono text-sm">{p.name}</span>
                      </div>
                      <div className="flex items-center gap-3 text-xs text-[var(--color-muted)]">
                        {p.tty && <span>TTY {p.tty}</span>}
                        <span>CPU {p.cpu}%</span>
                        <span>MEM {p.mem}%</span>
                        {p.start && <span>started {p.start}</span>}
                      </div>
                    </div>
                    {p.command && (
                      <div className="mt-1 text-xs font-mono text-[var(--color-muted)] truncate">{p.command}</div>
                    )}
                  </div>
                ))}
              </div>
            </div>
          )}

          {allEntries.length > 0 && (
            <p className="text-xs text-[var(--color-muted)]">
              {tmuxEntries.length > 0 && <>Click a tmux session to preview live output. {isLocal ? 'Full View' : 'Watch'} opens the interactive terminal viewer. </>}
              {bareEntries.length > 0 && <>Yellow dots indicate agent processes running outside tmux.</>}
            </p>
          )}
        </div>
      );
}

export const NULL_TOOLTIP = () => null;
export const HIDDEN_WRAPPER_STYLE: React.CSSProperties = { display: 'none' };
export function Section({ title, children }: { title: string | React.ReactNode; children: React.ReactNode }) {
  return (
    <div className="bg-[var(--color-surface)] rounded border border-[var(--color-border)] p-4">
      <h3 className="text-sm font-bold text-[var(--color-muted)] mb-3">{title}</h3>
      {children}
    </div>
  );
}

function SshField({ label, value, placeholder, onChange }: {
  label: string;
  value: string;
  placeholder?: string;
  onChange: (v: string) => void;
}) {
  return (
    <div className="flex items-center gap-2">
      <span className="text-sm text-[var(--color-muted)] w-32 shrink-0">{label}</span>
      <input
        type="text"
        value={value}
        placeholder={placeholder}
        onChange={(e) => onChange(e.target.value)}
        className="flex-1 text-sm bg-[var(--color-background)] border border-[var(--color-border)] rounded px-2 py-1 font-mono"
      />
    </div>
  );
}

function TunableRow({ label, unit, step, value, placeholder, onChange }: {
  label: string;
  unit: string;
  step: number;
  value: number | string;
  placeholder?: string;
  onChange: (v: number) => void;
}) {
  return (
    <div className="flex items-center justify-between gap-4">
      <span className="text-sm text-[var(--color-muted)]">{label}</span>
      <div className="flex items-center gap-1">
        <input
          type="number"
          step={step}
          min={0}
          value={value}
          placeholder={placeholder}
          onChange={(e) => onChange(parseFloat(e.target.value) || 0)}
          className="w-20 text-sm bg-[var(--color-background)] border border-[var(--color-border)] rounded px-2 py-1 font-mono text-right"
        />
        <span className="text-xs text-[var(--color-muted)] w-12">{unit}</span>
      </div>
    </div>
  );
}

const CHART_CURSOR_STYLE: React.CSSProperties = {
  position: 'absolute', top: 0, bottom: 0, left: 0, width: 1,
  background: 'rgba(255,255,255,0.85)',
  boxShadow: '0 0 3px rgba(255,255,255,0.5)',
  opacity: 0,
  transform: 'translate3d(-1px,0,0)',
  willChange: 'transform, opacity',
  pointerEvents: 'none',
};
const CHART_DRAG_STYLE: React.CSSProperties = {
  position: 'absolute', top: 0, bottom: 0, left: 0, width: 0,
  background: 'rgba(212,0,0,0.18)',
  borderLeft: '1px solid rgba(212,0,0,0.55)',
  borderRight: '1px solid rgba(212,0,0,0.55)',
  opacity: 0,
  transform: 'translate3d(0,0,0)',
  willChange: 'transform, width, opacity',
  pointerEvents: 'none',
};
const CHART_OVERLAY_WRAP_STYLE: React.CSSProperties = {
  position: 'absolute', inset: 0, pointerEvents: 'none', overflow: 'hidden',
};
// Per-chart Tooltip is hidden (shared hover row replaces it) but kept mounted
// so recharts still updates its activeIndex on hover, which drives activeDot.
const ChartOverlay = React.memo(function ChartOverlay() {
  return (
    <div style={CHART_OVERLAY_WRAP_STYLE}>
      <div data-chart-cursor="node-detail" style={CHART_CURSOR_STYLE} />
      <div data-chart-drag="node-detail" style={CHART_DRAG_STYLE} />
    </div>
  );
});
ChartOverlay.displayName = 'ChartOverlay';
