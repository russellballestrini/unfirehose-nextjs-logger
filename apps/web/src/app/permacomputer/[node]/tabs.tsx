'use client';



import Link from 'next/link';
import React from 'react';
import { TimeRangeSelect } from '@unturf/unfirehose-ui/TimeRangeSelect';
import { UPlotTimeChart, type UPlotSeries } from '@/components/UPlotTimeChart';
import { ThermalPanel } from '@/components/ThermalPanel';
import { ansiToHtml } from '@unturf/unfirehose-ui/ansi';
import { GaugeTrack, UTILISATION } from '@unturf/unfirehose-ui/Gauge';
import { KV } from '@unturf/unfirehose-ui/KV';
// uplot CSS is bundled by UPlotTimeChart's import
import { harnessesFor } from '@/lib/harnesses';
import { HarnessPicker } from '@/components/HarnessPicker';
import { human, humanDelta } from '@unturf/unfirehose/ago';
import { formatBytes } from '@unturf/unfirehose/format';
import { Donut } from '@/components/Donut';

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

/** How the Processes tab lays out the table. Tree is `ps -ejH`. */
type ProcessView = 'tree' | 'top';

/** The Processes tab. Defaults to the `ps -ejH` hierarchy. */
export function ProcessesTab(props: TabProps) {
  const { probe } = props;
  const [view, setView] = React.useState<ProcessView>('tree');
  const tree: any[] = Array.isArray(probe?.processTree) ? probe.processTree : [];
  const top: any[] = Array.isArray(probe?.processes) ? probe.processes : [];

  // `ps -ejH` carries no cpu/mem; the CPU-sorted list does, for the top 50.
  // Join by pid so a hot process reads hot in the tree too.
  const usageByPid = React.useMemo(() => {
    const m = new Map<number, any>();
    for (const p of top) m.set(p.pid, p);
    return m;
  }, [top]);
  // Agent harness pids get a marker — the tree exists to show which shell
  // under which tmux server owns which agent.
  const agentPids = React.useMemo(() => {
    const procs: any[] = Array.isArray(probe?.harnessProcesses)
      ? probe.harnessProcesses
      : Array.isArray(probe?.claudeProcesses) ? probe.claudeProcesses : [];
    return new Set<number>(procs.map((p: any) => p.pid));
  }, [probe]);

  const agentCount = Array.isArray(probe?.harnessProcesses)
    ? probe.harnessProcesses.length
    : Array.isArray(probe?.claudeProcesses) ? probe.claudeProcesses.length : probe?.claudeProcesses ?? 0;

  // A probe from before PS_TREE shipped has only the top list; show that
  // rather than an empty tree.
  const effectiveView: ProcessView = view === 'tree' && tree.length === 0 && top.length > 0 ? 'top' : view;
  const hasAny = tree.length > 0 || top.length > 0;

  const toggle = (
    <span className="flex items-center gap-1 text-xs font-normal normal-case tracking-normal">
      {(['tree', 'top'] as ProcessView[]).map(v => (
        <button
          key={v}
          type="button"
          onClick={() => setView(v)}
          disabled={v === 'tree' ? tree.length === 0 : top.length === 0}
          className={`px-2 py-0.5 rounded border font-mono ${
            effectiveView === v
              ? 'border-[var(--color-accent)] text-[var(--color-accent)]'
              : 'border-[var(--color-border)] text-[var(--color-muted)] hover:text-[var(--color-foreground)] disabled:opacity-40'
          }`}
        >
          {v === 'tree' ? 'ps -ejH' : 'ps aux --sort=-%cpu'}
        </button>
      ))}
    </span>
  );

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

        {!hasAny ? (
          <div className="text-sm text-[var(--color-muted)]">No process data available.</div>
        ) : effectiveView === 'tree' ? (
          <Section title={<span className="flex items-center justify-between gap-3"><span>Process Tree ({tree.length} processes, {agentCount} agents)</span>{toggle}</span>}>
            <div className="overflow-x-auto">
              <table className="w-full text-xs font-mono whitespace-nowrap">
                <thead>
                  <tr className="text-[var(--color-muted)] text-left">
                    <th className="pb-1 pr-3 text-right">PID</th>
                    <th className="pb-1 pr-3 text-right">PGID</th>
                    <th className="pb-1 pr-3 text-right">SID</th>
                    <th className="pb-1 pr-3">TTY</th>
                    <th className="pb-1 pr-3 text-right">TIME</th>
                    <th className="pb-1 pr-3 text-right">CPU%</th>
                    <th className="pb-1 pr-3 text-right">MEM%</th>
                    <th className="pb-1">CMD</th>
                  </tr>
                </thead>
                <tbody>
                  {tree.map((p: any) => {
                    const u = usageByPid.get(p.pid);
                    const agent = agentPids.has(p.pid);
                    return (
                      <tr key={p.pid} className={`border-t border-[var(--color-border)] ${agent ? 'text-[var(--color-tool)]' : ''}`}>
                        <td className="py-0.5 pr-3 text-right">{p.pid}</td>
                        <td className="py-0.5 pr-3 text-right text-[var(--color-muted)]">{p.pgid}</td>
                        <td className="py-0.5 pr-3 text-right text-[var(--color-muted)]">{p.sid}</td>
                        <td className="py-0.5 pr-3 text-[var(--color-muted)]">{p.tty}</td>
                        <td className="py-0.5 pr-3 text-right text-[var(--color-muted)]">{p.time}</td>
                        <td className={`py-0.5 pr-3 text-right ${u && parseFloat(u.cpu) > 50 ? 'text-[var(--color-error)]' : ''}`}>{u ? u.cpu : ''}</td>
                        <td className="py-0.5 pr-3 text-right">{u ? u.mem : ''}</td>
                        <td className="py-0.5" style={{ paddingLeft: `${p.depth * 1.25}rem` }}>
                          {p.depth > 0 && <span className="text-[var(--color-muted)]">└ </span>}
                          {p.cmd}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </Section>
        ) : (
          <Section title={<span className="flex items-center justify-between gap-3"><span>Processes ({top.length}, {agentCount} agents)</span>{toggle}</span>}>
            <div className="overflow-x-auto">
              <table className="w-full text-xs whitespace-nowrap">
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
                  {top.map((p: any, i: number) => (
                    <tr key={i} className="border-t border-[var(--color-border)]">
                      <td className="py-0.5 pr-3 text-[var(--color-muted)]">{p.user}</td>
                      <td className={`py-0.5 pr-3 text-right ${parseFloat(p.cpu) > 50 ? 'text-[var(--color-error)]' : ''}`}>{p.cpu}</td>
                      <td className="py-0.5 pr-3 text-right">{p.mem}</td>
                      <td className="py-0.5 pr-3 text-right text-[var(--color-muted)]">{p.rss}</td>
                      <td className="py-0.5 font-mono">{p.command}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Section>
        )}
      </div>
  );
}

/**
 * What a container's status line says, and what its hover says.
 *
 * `docker ps` rounds to one unit: "Up 4 weeks" is anywhere from 28 to 34
 * days, and "Exited (0) 2 days ago" hides the hour. With the inspect
 * instants the label reads two units — "up 20 days, 3 hours" — and the
 * hover holds the wall-clock moment it happened, in the viewer's zone.
 * A probe without inspect data (older worker, docker socket refused) falls
 * back to the ps Status verbatim.
 */
export function containerStatus(c: {
  status?: string; state?: string; startedAt?: string | null; finishedAt?: string | null; exitCode?: number | null;
}): { label: string; title?: string } {
  const at = (iso: string) => new Date(iso).toLocaleString([], {
    year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
  });
  // "(healthy)" / "(unhealthy)" / "(health: starting)" ride along on the ps line.
  const status = c.status ?? '';
  const health = status.match(/\((healthy|unhealthy|health: [^)]+)\)/)?.[0];
  // Whole seconds: two units of "3 hours, 573 milliseconds" is what ago
  // says when the minutes happen to be zero, and nobody wants it.
  if (c.state === 'running' && c.startedAt) {
    const up = human(c.startedAt, { pastTense: 'up {}', zero: 'up just now', smallest: 'second' });
    return { label: health ? `${up} ${health}` : up, title: `started ${at(c.startedAt)}` };
  }
  if ((c.state === 'exited' || c.state === 'dead') && c.finishedAt) {
    const code = c.exitCode != null ? ` (${c.exitCode})` : '';
    return { label: `${c.state}${code} ${human(c.finishedAt, { smallest: 'second' })}`, title: `stopped ${at(c.finishedAt)}` };
  }
  return { label: status || c.state || '', title: c.startedAt ? `started ${at(c.startedAt)}` : undefined };
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
    tailPath,
    setTailPath,
    tailContent,
    tailReady,
    tailRef,
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
        // The JSONL this process is writing, tied host-side by the probe.
        // Present for an agent whose session file we could see; absent for
        // one in a container namespace, or an older probe.
        session: p.session ?? null,
        cwd: p.cwd ?? null,
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
                {bareEntries.map(p => {
                  const path = p.session?.path ?? null;
                  const isActive = path != null && tailPath === path;
                  const clickable = path != null;
                  return (
                  <div
                    key={p.pid}
                    onClick={clickable ? () => setTailPath(isActive ? null : path) : undefined}
                    className={`bg-[var(--color-surface)] rounded border p-3 transition-colors ${
                      isActive ? 'border-[var(--color-accent)]' :
                      clickable ? 'border-[var(--color-border)] hover:border-[var(--color-accent)]/50 cursor-pointer' :
                      'border-[var(--color-border)]'
                    }`}
                  >
                    <div className="flex items-center justify-between gap-3">
                      <div className="flex items-center gap-2 min-w-0">
                        <span className="w-2 h-2 rounded-full bg-yellow-400 animate-pulse shrink-0" />
                        <span className="font-bold font-mono text-sm shrink-0">{p.name}</span>
                        {p.session && (
                          <span
                            className="text-xs font-mono text-[var(--color-muted)] truncate"
                            title={`${p.session.harness} · ${p.session.sessionId}${p.session.matched === 'nearest' ? ' (best guess — nothing written since it started)' : ''}`}
                          >
                            {p.session.sessionId.slice(0, 8)}{p.session.matched === 'nearest' ? '?' : ''}
                          </span>
                        )}
                      </div>
                      <div className="flex items-center gap-3 text-xs text-[var(--color-muted)] shrink-0">
                        {p.tty && <span>TTY {p.tty}</span>}
                        <span>CPU {p.cpu}%</span>
                        <span>MEM {p.mem}%</span>
                        {clickable && (
                          <span className="text-[var(--color-accent)] font-bold">{isActive ? 'Hide tail' : 'Tail ▸'}</span>
                        )}
                      </div>
                    </div>
                    {p.command && (
                      <div className="mt-1 text-xs font-mono text-[var(--color-muted)] truncate">{p.command}</div>
                    )}
                    {isActive && (
                      <pre
                        ref={tailRef}
                        onClick={(e) => e.stopPropagation()}
                        className="mt-3 bg-[#0d0d0d] rounded border border-[var(--color-border)] p-3 overflow-auto max-h-[60vh] font-mono text-xs leading-relaxed text-[#d4d4d4] whitespace-pre-wrap break-words"
                      >{!tailReady ? 'Connecting…' : (tailContent || 'No output in this session yet.')}</pre>
                    )}
                  </div>
                  );
                })}
              </div>
            </div>
          )}

          {allEntries.length > 0 && (
            <p className="text-xs text-[var(--color-muted)]">
              {tmuxEntries.length > 0 && <>Click a tmux session to preview live output. {isLocal ? 'Full View' : 'Watch'} opens the interactive terminal viewer. </>}
              {bareEntries.length > 0 && <>Yellow dots are agents running outside tmux. Click one with a session id to tail the JSONL it is writing.</>}
            </p>
          )}
        </div>
      );
}

/**
 * One colour per container, by its position in the probe. The list is the
 * tokens page's tool palette: plain colours, because a canvas cannot read a
 * custom property.
 */
const CONTAINER_COLORS = [
  '#10b981', '#a78bfa', '#60a5fa', '#fbbf24', '#f472b6',
  '#34d399', '#818cf8', '#38bdf8', '#fb923c', '#e879f9',
  '#2dd4bf', '#f87171', '#84cc16', '#22d3ee', '#facc15',
];

/** How a container state reads on the donut. Docker's own words, its own order. */
const STATE_COLORS: Record<string, string> = {
  running: '#10b981', paused: '#fbbf24', restarting: '#fb923c',
  created: '#60a5fa', exited: '#71717a', dead: '#f87171', removing: '#71717a',
};

/**
 * Running first, hottest first among them; the stopped ones after, most
 * recently stopped first. A page of containers is read top-down for what
 * is burning, then for what died.
 */
export function orderContainers<C extends { state?: string; resources?: { cpuPct: number | null } | null; finishedAt?: string | null }>(cs: C[]): C[] {
  const rank = (c: C) => c.state === 'running' ? 0 : c.state === 'paused' || c.state === 'restarting' ? 1 : 2;
  return [...cs].sort((a, b) => {
    const r = rank(a) - rank(b);
    if (r !== 0) return r;
    if (rank(a) === 0) return (b.resources?.cpuPct ?? -1) - (a.resources?.cpuPct ?? -1);
    return Date.parse(b.finishedAt ?? '') - Date.parse(a.finishedAt ?? '') || 0;
  });
}

/** "2 cores", "0.5 core", or "cores" with the count unknown. */
function cores(n: number | null | undefined): string {
  if (n == null) return '';
  return `${n} ${n === 1 ? 'core' : 'cores'}`;
}

/** A small filled pill: a state, a verdict, a count. */
function Badge({ children, color, title }: { children: React.ReactNode; color: string; title?: string }) {
  return (
    <span
      className="inline-block px-1.5 py-px rounded text-[10px] font-mono leading-4"
      style={{ backgroundColor: `${color}22`, color, border: `1px solid ${color}55` }}
      title={title}
    >
      {children}
    </span>
  );
}

/**
 * A resource bar with its reading beside it and what it is measured
 * against under it. The bar goes as far as the ceiling allows: a
 * container's quota, its memory limit, or the whole host when unbounded.
 */
function ResourceBar({ label, pct, value, ceiling, thresholds }: {
  label: string; pct: number | null; value: string; ceiling: string; thresholds?: { warn: number; danger: number };
}) {
  return (
    <div>
      <div className="flex items-baseline justify-between text-xs">
        <span className="text-[var(--color-muted)]">{label}</span>
        <span className="font-mono">{value}</span>
      </div>
      <GaugeTrack pct={pct ?? 0} thresholds={thresholds} className="mt-1" />
      <div className="text-[10px] text-[var(--color-muted)] mt-0.5">{ceiling}</div>
    </div>
  );
}

/**
 * PSI: the share of the last ten seconds some task in the cgroup spent
 * waiting on a resource. Zero is the normal reading and stays quiet;
 * anything else is coloured, because a container at 20% cpu pressure is
 * a container whose quota is too small, whatever its cpu bar says.
 */
function Pressure({ psi }: { psi: { cpu: number | null; memory: number | null; io: number | null } }) {
  const cell = (k: 'cpu' | 'memory' | 'io') => {
    const v = psi[k];
    const color = v == null ? 'var(--color-muted)' : v >= 25 ? '#ef4444' : v >= 5 ? '#eab308' : 'var(--color-foreground)';
    return (
      <span key={k} className="font-mono" style={{ color }} title={`${k} pressure, some avg10`}>
        {k} {v == null ? '—' : `${v.toFixed(2)}%`}
      </span>
    );
  };
  return <div className="flex gap-3 text-xs">{(['cpu', 'memory', 'io'] as const).map(cell)}</div>;
}

/**
 * The Containers tab: every container the runtime lists, what our host
 * kernel says each is spending, and its process tree in host pids.
 *
 * The figures come from cgroups, not from `docker stats`: the same bytes
 * and ticks the runtime would report, read from where the runtime reads
 * them, minus the two seconds it spends doing so. A probe from a worker
 * that predates that section lists the containers and says the rest is
 * missing rather than drawing empty bars.
 */
export function ContainersTab(props: TabProps) {
  const { probe, sys, mem } = props;
  const raw = probe?.containers;
  const all: any[] = React.useMemo(() => Array.isArray(raw) ? raw : [], [raw]);
  const containers = React.useMemo(() => orderContainers(all), [all]);
  // A node can run hundreds of containers (cammy: ~395 LXD guests). Rows are
  // collapsed by default -- opening one shows its bars, pressure, io and
  // process tree. A search, a runtime filter and a sort keep the list
  // navigable, and only a bounded slice renders until "show all" is asked.
  const [expanded, setExpanded] = React.useState<Set<string>>(() => new Set());
  const [query, setQuery] = React.useState('');
  const [runtimeFilter, setRuntimeFilter] = React.useState('all');
  const [sort, setSort] = React.useState<'cpu' | 'mem' | 'tasks' | 'name'>('cpu');
  const toggle = (id: string) => setExpanded((prev) => {
    const next = new Set(prev);
    if (next.has(id)) next.delete(id); else next.add(id);
    return next;
  });

  const hostCores: number = sys?.cpuCores > 0 ? sys.cpuCores : 0;
  const hostMemBytes: number = mem?.totalGB > 0 ? mem.totalGB * 1_073_741_824 : 0;
  const hasResources = all.some((c) => c.resources);
  const running = containers.filter((c) => c.state === 'running');

  // Runtimes present, for the filter chips. docker is the unlabelled default.
  const runtimeCounts = React.useMemo(() => {
    const m = new Map<string, number>();
    for (const c of all) { const k = c.runtime || 'docker'; m.set(k, (m.get(k) ?? 0) + 1); }
    return m;
  }, [all]);

  // Filter by runtime and free text, then sort -- running first always, then
  // by the chosen key (cpu/mem/tasks desc, name asc). A container without live
  // stats sorts below one that has them.
  const filtered = React.useMemo(() => {
    const q = query.trim().toLowerCase();
    let list = containers;
    if (runtimeFilter !== 'all') list = list.filter((c) => (c.runtime || 'docker') === runtimeFilter);
    if (q) list = list.filter((c) =>
      (c.name || '').toLowerCase().includes(q) ||
      String(c.id).toLowerCase().includes(q) ||
      (c.image || '').toLowerCase().includes(q) ||
      (c.rootComm || '').toLowerCase().includes(q));
    const val = (c: any) => sort === 'mem' ? (c.resources?.memUsed ?? -1)
      : sort === 'tasks' ? (c.resources?.tasks ?? -1)
      : (c.resources?.cpuPct ?? -1);
    const rank = (c: any) => c.state === 'running' ? 0 : 1;
    return [...list].sort((a, b) =>
      rank(a) - rank(b) ||
      (sort === 'name' ? String(a.name).localeCompare(String(b.name)) : val(b) - val(a)));
  }, [containers, runtimeFilter, query, sort]);

  if (all.length === 0) {
    return (
      <div className="text-sm text-[var(--color-muted)]">
        {probe ? 'No containers on this node.' : 'No probe data available.'}
      </div>
    );
  }

  // Totals across the running set, for the strip and the share donuts.
  const totalCpu = running.reduce((s, c) => s + (c.resources?.cpuPct ?? 0), 0);
  const totalMem = running.reduce((s, c) => s + (c.resources?.memUsed ?? 0), 0);
  const totalTasks = running.reduce((s, c) => s + (c.resources?.tasks ?? 0), 0);
  const totalProcs = running.reduce((s, c) => s + (c.processes?.length ?? 0), 0);
  const colorOf = new Map<string, string>(all.map((c, i) => [c.id, CONTAINER_COLORS[i % CONTAINER_COLORS.length]]));

  const stateCounts = new Map<string, number>();
  for (const c of all) {
    const k = c.state ?? (/^Up\b/.test(c.status ?? '') ? 'running' : 'other');
    stateCounts.set(k, (stateCounts.get(k) ?? 0) + 1);
  }
  const stateShares = [...stateCounts].map(([name, value]) => ({ name, value, color: STATE_COLORS[name] ?? '#71717a' }));
  const cpuShares = running.map((c) => ({ name: c.name, value: c.resources?.cpuPct ?? 0, color: colorOf.get(c.id)! }));
  const memShares = running.map((c) => ({ name: c.name, value: c.resources?.memUsed ?? 0, color: colorOf.get(c.id)! }));

  const openCount = filtered.reduce((n, c) => n + (expanded.has(c.id) ? 1 : 0), 0);
  const anyOpen = openCount > 0;

  const tile = (label: string, value: string, sub?: string) => (
    <div key={label} className="bg-[var(--color-surface)] rounded border border-[var(--color-border)] px-3 py-2">
      <div className="text-[10px] uppercase tracking-wide text-[var(--color-muted)]">{label}</div>
      <div className="text-lg font-mono leading-tight">{value}</div>
      {sub && <div className="text-[10px] text-[var(--color-muted)]">{sub}</div>}
    </div>
  );

  return (
    <div className="space-y-6">
      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-2">
        {tile('Containers', String(all.length), [...stateCounts].map(([k, v]) => `${v} ${k}`).join(' · '))}
        {tile('CPU', hasResources ? `${totalCpu.toFixed(1)}%` : '—',
          hostCores ? `${(totalCpu / hostCores).toFixed(1)}% of ${cores(hostCores)}` : 'of one core = 100%')}
        {tile('Memory', hasResources ? formatBytes(totalMem) : '—',
          hostMemBytes ? `${(totalMem / hostMemBytes * 100).toFixed(1)}% of ${formatBytes(hostMemBytes)}` : undefined)}
        {tile('Tasks', hasResources ? String(totalTasks) : '—', 'threads and processes')}
        {tile('Processes', hasResources ? String(totalProcs) : '—', 'as our host lists them')}
        {tile('Restarts', String(all.reduce((s, c) => s + (c.restartCount ?? 0), 0)),
          all.some((c) => c.oomKilled) ? 'OOM killed: ' + all.filter((c) => c.oomKilled).map((c) => c.name).join(', ') : 'no OOM kills')}
      </div>

      {!hasResources && (
        <div className="text-xs text-[var(--color-muted)] border border-[var(--color-border)] rounded px-3 py-2">
          Kernel-side resources are missing from this probe — it predates the cgroup section, or this host keeps its cgroups somewhere our probe did not look. States and images still come from the runtime.
        </div>
      )}

      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        <Section title="State">
          <Donut data={stateShares} format={(v) => `${v}`} height={150} inner={0.6} />
        </Section>
        <Section title="CPU share">
          {cpuShares.some((s) => s.value > 0)
            ? <Donut data={cpuShares} format={(v) => `${v.toFixed(1)}%`} height={150} inner={0.6} />
            : <div className="text-xs text-[var(--color-muted)]">Nothing running is using cpu.</div>}
        </Section>
        <Section title="Memory share">
          {memShares.some((s) => s.value > 0)
            ? <Donut data={memShares} format={formatBytes} height={150} inner={0.6} />
            : <div className="text-xs text-[var(--color-muted)]">Nothing running holds memory.</div>}
        </Section>
      </div>

      {/* Filter bar: search, runtime chips, sort. */}
      <div className="flex flex-wrap items-center gap-2">
        <input
          type="text"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder={`Search ${all.length} containers…`}
          className="flex-1 min-w-[180px] bg-[var(--color-background)] border border-[var(--color-border)] rounded px-2 py-1 text-sm font-mono focus:border-[var(--color-accent)] outline-none"
        />
        <div className="flex items-center gap-1 text-xs font-mono">
          {['all', ...runtimeCounts.keys()].map((rt) => (
            <button
              key={rt}
              type="button"
              onClick={() => setRuntimeFilter(rt)}
              className={`px-2 py-1 rounded border ${runtimeFilter === rt
                ? 'border-[var(--color-accent)] text-[var(--color-accent)]'
                : 'border-[var(--color-border)] text-[var(--color-muted)] hover:text-[var(--color-foreground)]'}`}
            >
              {rt}{rt !== 'all' && ` ${runtimeCounts.get(rt)}`}
            </button>
          ))}
        </div>
        <select
          value={sort}
          onChange={(e) => setSort(e.target.value as typeof sort)}
          className="bg-[var(--color-background)] border border-[var(--color-border)] rounded px-2 py-1 text-xs font-mono outline-none"
          title="Sort running containers by"
        >
          <option value="cpu">sort: CPU</option>
          <option value="mem">sort: memory</option>
          <option value="tasks">sort: tasks</option>
          <option value="name">sort: name</option>
        </select>
        {/* One toggle: opens every row the filter shows, or closes every open
            row. A node with hundreds of containers is otherwise a click per
            row each way. */}
        <button
          type="button"
          onClick={() => setExpanded(anyOpen ? new Set() : new Set(filtered.map((c) => c.id)))}
          className="px-2 py-1 rounded border border-[var(--color-border)] text-xs font-mono text-[var(--color-muted)] hover:text-[var(--color-foreground)]"
          title={anyOpen ? `Close ${openCount} open row${openCount === 1 ? '' : 's'}` : `Open all ${filtered.length} shown`}
        >
          {anyOpen ? `close all (${openCount})` : `open all (${filtered.length})`}
        </button>
      </div>

      {/* Compact table. A row expands to its bars, pressure, io and process tree.
          Fixed layout on purpose: an expanded row's process tree shows every
          command whole, and in an auto-layout table that width leaks up into
          the cell, the table, and the wrapper -- the whole table then scrolls
          sideways and the CPU bar leaves the screen. With fixed columns the
          tree scrolls inside its own box and the bars stay put; a long
          container name wraps instead of pushing them. */}
      <div className="bg-[var(--color-surface)] rounded border border-[var(--color-border)]">
        <table className="w-full table-fixed text-sm">
          <thead>
            <tr className="text-[10px] uppercase tracking-wide text-[var(--color-muted)] text-left border-b border-[var(--color-border)]">
              <th className="py-1.5 pl-3 pr-2 w-5"></th>
              <th className="py-1.5 pr-3">Container</th>
              <th className="py-1.5 pr-3 w-24 hidden sm:table-cell">State</th>
              <th className="py-1.5 pr-3 w-28 sm:w-40">CPU</th>
              <th className="py-1.5 pr-3 w-32 sm:w-40">Memory</th>
              <th className="py-1.5 pr-3 w-16 text-right hidden md:table-cell">Tasks</th>
            </tr>
          </thead>
          <tbody>
            {filtered.map((c) => {
              const r = c.resources ?? null;
              const { label, title } = containerStatus(c);
              const color = colorOf.get(c.id)!;
              const procs: any[] = Array.isArray(c.processes) ? c.processes : [];
              const isRunning = c.state === 'running';
              const cpuCap = r?.cpuQuota ?? c.cpuLimit ?? null;
              const cpuMaxPct = cpuCap ? cpuCap * 100 : hostCores ? hostCores * 100 : 100;
              const memCap = r?.memLimit ?? c.memLimit ?? null;
              const memMax = memCap ?? hostMemBytes ?? 0;
              const taskCap = r?.tasksMax ?? c.pidsLimit ?? null;
              const open = expanded.has(c.id);
              const hurt = c.oomKilled || (r?.oomKills ?? 0) > 0 || (r?.cpuThrottled ?? 0) > 0;
              return (
                <React.Fragment key={c.id}>
                  <tr
                    onClick={() => toggle(c.id)}
                    className="border-b border-[var(--color-border)] cursor-pointer hover:bg-[var(--color-background)]/40"
                    style={{ borderLeft: `3px solid ${isRunning ? color : 'transparent'}` }}
                  >
                    <td className="py-1.5 pl-3 pr-2 text-[var(--color-muted)] font-mono">{open ? '▾' : '▸'}</td>
                    <td className="py-1.5 pr-3 [overflow-wrap:anywhere]">
                      <div className="flex items-center gap-2 flex-wrap">
                        <span className="font-bold">{c.name}</span>
                        {c.runtime && c.runtime !== 'docker' && <Badge color="#60a5fa" title={`runtime: ${c.runtime}`}>{c.runtime}</Badge>}
                        {c.health && <Badge color={c.health === 'healthy' ? '#10b981' : c.health === 'unhealthy' ? '#ef4444' : '#eab308'}>{c.health}</Badge>}
                        {hurt && <Badge color="#ef4444" title="OOM killed, out-of-memory kills inside, or cpu throttling — expand for detail">!</Badge>}
                        <span className="text-[10px] font-mono text-[var(--color-muted)]" title={c.image || (c.rootComm ? `runs ${c.rootComm}` : '')}>
                          {c.image || (c.rootComm ? `runs ${c.rootComm}` : String(c.id).slice(0, 12))}
                        </span>
                      </div>
                    </td>
                    <td className="py-1.5 pr-3 hidden sm:table-cell text-xs text-[var(--color-muted)]" title={title}>{label}</td>
                    <td className="py-1.5 pr-3">
                      {isRunning && r?.cpuPct != null ? (
                        <div className="flex items-center gap-2">
                          <GaugeTrack pct={r.cpuPct / cpuMaxPct * 100} thresholds={UTILISATION} className="flex-1 min-w-[40px]" />
                          <span className="font-mono text-xs w-12 text-right shrink-0">{r.cpuPct.toFixed(1)}%</span>
                        </div>
                      ) : <span className="text-xs text-[var(--color-muted)]">—</span>}
                    </td>
                    <td className="py-1.5 pr-3">
                      {isRunning && r?.memUsed != null ? (
                        <div className="flex items-center gap-2">
                          <GaugeTrack pct={memMax ? r.memUsed / memMax * 100 : 0} thresholds={UTILISATION} className="flex-1 min-w-[40px]" />
                          <span className="font-mono text-xs w-16 text-right shrink-0">{formatBytes(r.memUsed)}</span>
                        </div>
                      ) : <span className="text-xs text-[var(--color-muted)]">—</span>}
                    </td>
                    <td className="py-1.5 pr-3 text-right font-mono text-xs hidden md:table-cell">{r?.tasks ?? (isRunning ? '' : '—')}</td>
                  </tr>
                  {open && (
                    <tr className="border-b border-[var(--color-border)] bg-[var(--color-background)]/30">
                      <td></td>
                      <td colSpan={5} className="py-3 pr-4 [overflow-wrap:anywhere]">
                        <div className="flex flex-wrap gap-x-4 gap-y-0.5 text-xs text-[var(--color-muted)] font-mono mb-3">
                          <span title="container id">{String(c.id).slice(0, 12)}</span>
                          {c.pid ? <span title="the container's init, as our host numbers it">host pid {c.pid}</span> : null}
                          {c.viaCgroup && <span title="Found through the cgroup filesystem, not the docker socket — name, image, ports, health and uptime are unavailable. Resources and processes are read straight from the kernel.">via cgroup</span>}
                          {c.ports && <span>{c.ports}</span>}
                          {(r?.cpuset ?? c.cpuset) && <span title="cpuset.cpus.effective">cpus {r?.cpuset ?? c.cpuset}</span>}
                          {c.oomKilled && <span className="text-[var(--color-error)]">OOM killed</span>}
                          {c.restartCount > 0 && <span className="text-[#fb923c]">{c.restartCount} restart{c.restartCount === 1 ? '' : 's'}</span>}
                          {r?.oomKills != null && r.oomKills > 0 && <span className="text-[var(--color-error)]" title="memory.events oom_kill">{r.oomKills} oom kill{r.oomKills === 1 ? '' : 's'}</span>}
                          {r?.cpuThrottled != null && r.cpuThrottled > 0 && <span className="text-[#eab308]" title={`cpu.stat: ${r.cpuThrottled} periods throttled, ${humanDelta((r.cpuThrottledUsec ?? 0) / 1000, { abbreviate: true })} in all`}>throttled ×{r.cpuThrottled}</span>}
                          {!isRunning && c.exitCode != null && c.exitCode !== 0 && <span className="text-[var(--color-error)]">exit code {c.exitCode}</span>}
                        </div>

                        {isRunning && r ? (
                          <>
                            <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
                              <ResourceBar label="CPU" pct={r.cpuPct == null ? null : r.cpuPct / cpuMaxPct * 100}
                                value={r.cpuPct == null ? '—' : `${r.cpuPct.toFixed(1)}%`}
                                ceiling={cpuCap ? `of ${cores(cpuCap)} (quota)` : hostCores ? `of ${cores(hostCores)}, no quota` : 'no quota'} thresholds={UTILISATION} />
                              <ResourceBar label="Memory" pct={r.memUsed == null || !memMax ? null : r.memUsed / memMax * 100}
                                value={r.memUsed == null ? '—' : formatBytes(r.memUsed)}
                                ceiling={[
                                  memCap ? `of ${formatBytes(memCap)} limit` : hostMemBytes ? `of ${formatBytes(hostMemBytes)} host, no limit` : 'no limit',
                                  r.memPeak != null ? `peak ${formatBytes(r.memPeak)}` : '',
                                  r.swapUsed ? `swap ${formatBytes(r.swapUsed)}` : '',
                                ].filter(Boolean).join(' · ')} thresholds={UTILISATION} />
                              <ResourceBar label="Tasks" pct={r.tasks == null || !taskCap ? null : r.tasks / taskCap * 100}
                                value={r.tasks == null ? '—' : `${r.tasks}`}
                                ceiling={taskCap ? `of ${taskCap} pids.max` : `${procs.length} processes, no pids limit`} thresholds={UTILISATION} />
                            </div>
                            <div className="flex flex-wrap gap-x-6 gap-y-1 items-center mt-2">
                              <Pressure psi={r.psi} />
                              <span className="text-xs font-mono text-[var(--color-muted)]" title="io.stat, since the container started">
                                io {r.ioRead == null ? '—' : `${formatBytes(r.ioRead)} read`} / {r.ioWrite == null ? '—' : `${formatBytes(r.ioWrite)} written`}
                              </span>
                              {r.memAnon != null && r.memFile != null && (
                                <span className="text-xs font-mono text-[var(--color-muted)]" title="memory.stat anon / file">anon {formatBytes(r.memAnon)} · file {formatBytes(r.memFile)}</span>
                              )}
                            </div>
                            <div className="overflow-x-auto mt-3">
                              <div className="text-[10px] uppercase tracking-wide text-[var(--color-muted)] mb-1">{procs.length} process{procs.length === 1 ? '' : 'es'} · host pids</div>
                              {procs.length > 0 ? (
                                <table className="w-full text-xs font-mono whitespace-nowrap">
                                  <thead>
                                    <tr className="text-[var(--color-muted)] text-left">
                                      <th className="pb-1 pr-3 text-right">PID</th>
                                      <th className="pb-1 pr-3 text-right">PPID</th>
                                      <th className="pb-1 pr-3">USER</th>
                                      <th className="pb-1 pr-3 text-right">CPU%</th>
                                      <th className="pb-1 pr-3 text-right">MEM%</th>
                                      <th className="pb-1 pr-3 text-right">RSS</th>
                                      <th className="pb-1 pr-3 text-right">AGE</th>
                                      <th className="pb-1">CMD</th>
                                    </tr>
                                  </thead>
                                  <tbody>
                                    {procs.map((p: any) => (
                                      <tr key={p.pid} className="border-t border-[var(--color-border)]">
                                        <td className="py-0.5 pr-3 text-right">{p.pid}</td>
                                        <td className="py-0.5 pr-3 text-right text-[var(--color-muted)]">{p.ppid}</td>
                                        <td className="py-0.5 pr-3 text-[var(--color-muted)]">{p.user}</td>
                                        <td className={`py-0.5 pr-3 text-right ${p.cpu > 50 ? 'text-[var(--color-error)]' : ''}`}>{p.cpu.toFixed(1)}</td>
                                        <td className="py-0.5 pr-3 text-right">{p.mem.toFixed(1)}</td>
                                        <td className="py-0.5 pr-3 text-right text-[var(--color-muted)]">{formatBytes(p.rss * 1024)}</td>
                                        <td className="py-0.5 pr-3 text-right text-[var(--color-muted)]">{p.elapsed == null ? '' : humanDelta(p.elapsed * 1000, { abbreviate: true, smallest: 'second' })}</td>
                                        <td className="py-0.5" style={{ paddingLeft: `${p.depth * 1.25}rem` }}>
                                          {p.depth > 0 && <span className="text-[var(--color-muted)]">└ </span>}
                                          <span>{p.cmd}</span>
                                        </td>
                                      </tr>
                                    ))}
                                  </tbody>
                                </table>
                              ) : <div className="text-xs text-[var(--color-muted)]">The cgroup lists no host pids ps could find.</div>}
                            </div>
                          </>
                        ) : isRunning && hasResources ? (
                          <div className="text-xs text-[var(--color-muted)]">Live resources were not computed for this container (beyond the per-probe stats cap). Its state, runtime and id are above.</div>
                        ) : null}
                      </td>
                    </tr>
                  )}
                </React.Fragment>
              );
            })}
          </tbody>
        </table>
      </div>

      <div className="text-center text-xs text-[var(--color-muted)] font-mono">
        {filtered.length === all.length ? `${filtered.length} containers` : `${filtered.length} of ${all.length} match`}
      </div>
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
