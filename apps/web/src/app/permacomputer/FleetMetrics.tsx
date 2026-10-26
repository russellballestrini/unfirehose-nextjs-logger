'use client';

import { fetcher } from '@unturf/unfirehose-ui/fetcher';
import { useMemo } from 'react';
import useSWR from 'swr';
import { useStickyState } from '@unturf/unfirehose-ui/useStickyState';
import { EmptyState } from '@unturf/unfirehose-ui/EmptyState';
import { UPlotTimeChart, type UPlotSeries } from '@/components/UPlotTimeChart';
import { getKwhRate } from '@unturf/unfirehose/pricing';
import { fmtLocalDateTime } from '@/lib/local-time';
import { useMeshScore, type MeshScoreInputs } from './useMeshScore';

/* eslint-disable @typescript-eslint/no-explicit-any */

// ============================================================
// Fleet Metrics
// ============================================================

// Fleet-wide live metrics. Power & cost share the blended $/kWh derived in
// computeMeshScore so charts stay consistent with the headline numbers.
// Every chart overlays per-host lines on top of a bold fleet aggregate.
const HOST_COLORS = ['#f97316', '#a78bfa', '#60a5fa', '#22c55e', '#f43f5e', '#facc15', '#38bdf8', '#ec4899', '#84cc16', '#fb923c'];

export function FleetMetricsChart({ blendedKwhRate }: { blendedKwhRate: number }) {
  // The blended rate is derived from nodes that reported watts. Until one
  // does it is 0, which would draw the $/hr line flat at zero rather than
  // "unknown" — fall back to our one system-wide $/kWh instead.
  const kwhRate = blendedKwhRate > 0 ? blendedKwhRate : getKwhRate();
  // Remembered across refreshes — this was useState(24), so picking 6h and
  // reloading snapped back to 24h.
  const [hours, setHours] = useStickyState<number>('fleet_metrics_hours', 24);
  // 30s refresh — matches snapshot sample rate; per-minute aggregation means new
  // points land roughly every minute but the cadence keeps the tail "live".
  const { data } = useSWR(`/api/mesh/history?hours=${hours}&hostname=all`, fetcher, {
    refreshInterval: 6000,
    focusThrottleInterval: 6000,
    keepPreviousData: true,
  });

  const { chartData, hosts, hostsWithGpu } = useMemo(() => {
    const timeline: any[] = data?.timeline ?? [];
    const hostSet = new Set<string>();
    const gpuHostSet = new Set<string>();
    const rows = timeline.map((t) => {
      const row: any = {
        timestamp: t.timestamp,
        tsMs: new Date(String(t.timestamp).replace(' ', 'T') + 'Z').getTime(),
        watts: t.totalWatts ?? 0,
        cpuWatts: t.cpuWatts ?? 0,
        gpuWatts: t.gpuWatts ?? 0,
        cpuPct: Math.round((t.avgLoad ?? 0) * 100 * 10) / 10,
        memUsedGB: t.memUsedGB ?? 0,
        memTotalGB: t.memTotalGB ?? 0,
        memPct: t.memTotalGB > 0 ? Math.round((t.memUsedGB / t.memTotalGB) * 100 * 10) / 10 : 0,
        gpuUtil: t.gpuUtil ?? 0,
        gpuVramUsedGB: t.gpuMemUsedGB ?? 0,
        gpuVramTotalGB: t.gpuMemTotalGB ?? 0,
        gpuVramPct: t.gpuMemTotalGB > 0 ? Math.round((t.gpuMemUsedGB / t.gpuMemTotalGB) * 100 * 10) / 10 : 0,
        elecCostPerHour: Math.round(((t.totalWatts ?? 0) / 1000) * kwhRate * 100) / 100,
      };
      for (const [host, n] of Object.entries<any>(t.nodes ?? {})) {
        hostSet.add(host);
        const cores = n.cores || 1;
        row[`cpu:${host}`] = Math.round((n.load / cores) * 100 * 10) / 10;
        row[`mem:${host}`] = n.memTotal > 0 ? Math.round((n.memUsed / n.memTotal) * 100 * 10) / 10 : 0;
        row[`watts:${host}`] = Math.round((n.watts ?? 0) * 10) / 10;
        if (n.gpuMemTotalMB > 0 || (n.gpuUtil != null && n.gpuUtil > 0)) {
          gpuHostSet.add(host);
          row[`gpuUtil:${host}`] = n.gpuUtil ?? 0;
          row[`gpuVram:${host}`] = n.gpuMemTotalMB > 0
            ? Math.round(((n.gpuMemUsedMB ?? 0) / n.gpuMemTotalMB) * 100 * 10) / 10
            : 0;
        }
      }
      return row;
    });
    return {
      chartData: rows,
      hosts: [...hostSet].sort(),
      hostsWithGpu: [...gpuHostSet].sort(),
    };
  }, [data, kwhRate]);

  const hasData = chartData.length > 0;
  const last = hasData ? chartData[chartData.length - 1] : null;
  // While history is empty we don't know which hosts have GPUs — keep panels
  // visible so the user sees what's coming. Once data lands, hide if truly no GPU.
  const hasGpu = !hasData || hostsWithGpu.length > 0;
  // Per-host series builders for each chart. Fleet aggregate is rendered
  // first (accent red, thick line); per-host lines follow in their fleet
  // colors with thinner strokes. hostColor must be declared BEFORE the
  // series-builder consts that reference it (lexical TDZ).
  const hostColor = (host: string, list: string[]) => HOST_COLORS[list.indexOf(host) % HOST_COLORS.length];
  const SYNC = 'permacomputer-fleet';
  // CPU and GPU draw are collected separately (RAPL/TDP vs nvidia-smi) and
  // the ticket's question is how much of the fleet's power is GPU. Dashed so
  // they read as components of the fleet total, not as two more hosts.
  const fleetHasGpuWatts = chartData.some((r) => r.gpuWatts > 0);
  const wattsSeries: UPlotSeries[] = [
    { key: 'watts', label: 'Fleet', stroke: '#d40000', width: 2.5 },
    ...(fleetHasGpuWatts ? [
      { key: 'cpuWatts', label: 'CPU', stroke: '#fb923c', width: 1.5, dash: [6, 4] } as UPlotSeries,
      { key: 'gpuWatts', label: 'GPU', stroke: '#a78bfa', width: 1.5, dash: [6, 4] } as UPlotSeries,
    ] : []),
    ...hosts.map(h => ({ key: `watts:${h}`, label: h, stroke: hostColor(h, hosts), width: 1 } as UPlotSeries)),
  ];
  const cpuSeries: UPlotSeries[] = [
    { key: 'cpuPct', label: 'Fleet avg', stroke: '#d40000', width: 2.5 },
    ...hosts.map(h => ({ key: `cpu:${h}`, label: h, stroke: hostColor(h, hosts), width: 1 } as UPlotSeries)),
  ];
  const memSeries: UPlotSeries[] = [
    { key: 'memPct', label: 'Fleet', stroke: '#d40000', width: 2.5 },
    ...hosts.map(h => ({ key: `mem:${h}`, label: h, stroke: hostColor(h, hosts), width: 1 } as UPlotSeries)),
  ];
  const gpuUtilSeries: UPlotSeries[] = [
    { key: 'gpuUtil', label: 'GPU avg', stroke: '#d40000', width: 2.5 },
    ...hostsWithGpu.map(h => ({ key: `gpuUtil:${h}`, label: h, stroke: hostColor(h, hostsWithGpu), width: 1 } as UPlotSeries)),
  ];
  const gpuVramSeries: UPlotSeries[] = [
    { key: 'gpuVramPct', label: 'VRAM avg', stroke: '#d40000', width: 2.5 },
    ...hostsWithGpu.map(h => ({ key: `gpuVram:${h}`, label: h, stroke: hostColor(h, hostsWithGpu), width: 1 } as UPlotSeries)),
  ];
  const tipLabel = fmtLocalDateTime;
  const tz = typeof window !== 'undefined' ? Intl.DateTimeFormat().resolvedOptions().timeZone : 'UTC';
  const ranges: { label: string; h: number }[] = [
    { label: '6h', h: 6 }, { label: '24h', h: 24 }, { label: '7d', h: 168 },
  ];

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <h4 className="text-sm font-bold text-[var(--color-muted)]">
          Fleet Metrics <span className="font-normal text-[10px] opacity-60">{hosts.length} nodes &middot; 30s refresh &middot; {tz}</span>
        </h4>
        <div className="flex gap-1">
          {ranges.map((r) => (
            <button
              key={r.h}
              onClick={() => setHours(r.h)}
              className={`text-xs px-2 py-0.5 rounded ${hours === r.h ? 'bg-[var(--color-accent)] text-black' : 'text-[var(--color-muted)] hover:text-[var(--color-foreground)]'}`}
            >
              {r.label}
            </button>
          ))}
        </div>
      </div>
      {!hasData && (
        data?.hasAnySnapshots === false ? (
          <EmptyState
            what="Fleet power, CPU, memory and GPU history will appear here, one line per node."
            action="Keep this page open: a probe of every node is recorded every 30s and these charts fill as they land. Nodes come from our SSH config."
            command="~/.ssh/config"
          />
        ) : (
          <EmptyState
            kind="quiet"
            what="No mesh snapshots in the selected window."
            range={hours >= 24 && hours % 24 === 0 ? `${hours / 24}d` : `${hours}h`}
            action={hours < 168 ? undefined : 'Older probes roll up into 15-minute samples; fresh ones land every 30s while this page is open.'}
            onWiden={hours < 168 ? () => setHours(168) : undefined}
            widenLabel="Show 7 days"
          />
        )
      )}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">

        {/* Power — fleet total + per-host */}
        <div className="bg-[var(--color-background)] rounded border border-[var(--color-border)] p-3">
          <h5 className="text-xs font-bold mb-2 text-[var(--color-muted)]">
            Power <span className="font-normal ml-1">{hasData
              ? `${Math.round(last!.watts)}W now${last!.gpuWatts > 0 ? ` · ${Math.round(last!.gpuWatts)}W gpu` : ''}`
              : '— no data'}</span>
          </h5>
          <UPlotTimeChart data={chartData} height={180} syncKey={SYNC} domain={null} yUnit="W" series={wattsSeries} />
        </div>

        {/* Electricity cost — derived from blended fleet rate */}
        <div className="bg-[var(--color-background)] rounded border border-[var(--color-border)] p-3">
          <h5 className="text-xs font-bold mb-2 text-[var(--color-muted)]">
            Electricity Cost <span className="font-normal ml-1">{hasData ? `$${last!.elecCostPerHour}/hr now` : '— no data'}</span>
          </h5>
          <UPlotTimeChart data={chartData} height={180} syncKey={SYNC} domain={null}
            series={[{ key: 'elecCostPerHour', label: '$/hr', stroke: '#facc15', fill: 'rgba(250,204,21,0.20)' }]}
          />
        </div>

        {/* CPU % — load-as-percent per host + fleet avg */}
        <div className="bg-[var(--color-background)] rounded border border-[var(--color-border)] p-3">
          <h5 className="text-xs font-bold mb-2 text-[var(--color-muted)]">
            CPU % <span className="font-normal ml-1">{hasData ? `${last!.cpuPct}% fleet avg` : '— no data'}</span>
          </h5>
          <UPlotTimeChart data={chartData} height={180} syncKey={SYNC} domain={null} yUnit="%" yMin={0} series={cpuSeries} />
        </div>

        {/* Memory % — used/total per host + fleet aggregate */}
        <div className="bg-[var(--color-background)] rounded border border-[var(--color-border)] p-3">
          <h5 className="text-xs font-bold mb-2 text-[var(--color-muted)]">
            Memory % <span className="font-normal ml-1">{hasData ? `${last!.memPct}% · ${last!.memUsedGB}/${last!.memTotalGB} GB` : '— no data'}</span>
          </h5>
          <UPlotTimeChart data={chartData} height={180} syncKey={SYNC} domain={null} yUnit="%" yMin={0} yMax={100} series={memSeries} />
        </div>

        {/* GPU Util — per-host + cross-GPU-node avg */}
        {hasGpu && (
          <div className="bg-[var(--color-background)] rounded border border-[var(--color-border)] p-3">
            <h5 className="text-xs font-bold mb-2 text-[var(--color-muted)]">
              GPU Utilization <span className="font-normal ml-1">{hasData ? `${last!.gpuUtil}% avg · ${hostsWithGpu.length} gpu` : '— no data'}</span>
            </h5>
            <UPlotTimeChart data={chartData} height={180} syncKey={SYNC} domain={null} yUnit="%" yMin={0} yMax={100} series={gpuUtilSeries} />
          </div>
        )}

        {/* GPU VRAM — per-host VRAM% + cross-node avg */}
        {hasGpu && (
          <div className="bg-[var(--color-background)] rounded border border-[var(--color-border)] p-3">
            <h5 className="text-xs font-bold mb-2 text-[var(--color-muted)]">
              GPU VRAM <span className="font-normal ml-1">{hasData ? `${last!.gpuVramPct}% · ${last!.gpuVramUsedGB}/${last!.gpuVramTotalGB} GB` : '— no data'}</span>
            </h5>
            <UPlotTimeChart data={chartData} height={180} syncKey={SYNC} domain={null} yUnit="%" yMin={0} yMax={100} series={gpuVramSeries} />
          </div>
        )}

      </div>
      <FleetEnergyTable energy={data?.energy} />
    </div>
  );
}

const usd = (v: number) => (v < 10 ? `$${v.toFixed(2)}` : `$${v.toFixed(0)}`);

/**
 * Each node's draw over the chart's window, attributed (ticket 4004): its
 * standing cost (the idle draw it burns switched on, p10 of its trailing
 * week), what our own sessions on it explain, and other work. Built by our
 * sampler, read from /api/mesh/history. Renders nothing until a node has
 * been sampled, so it adds no empty state of its own.
 */
export function FleetEnergyTable({ energy }: { energy?: { hosts?: any[]; byProject?: any[]; byHarness?: any[]; byModel?: any[] } | null }) {
  const hosts = energy?.hosts ?? [];
  if (!hosts.length) return null;
  const top = (list: any[] | undefined) =>
    (list ?? []).filter((x) => x.usd > 0).slice(0, 5).map((x) => `${x.key} ${usd(x.usd)}`).join(' · ');
  const lines: [string, string][] = [
    ['By project', top(energy?.byProject)],
    ['By harness', top(energy?.byHarness)],
    ['By model', top(energy?.byModel)],
  ];
  return (
    <div className="bg-[var(--color-background)] rounded border border-[var(--color-border)] p-3" data-fleet-energy>
      <h5 className="text-xs font-bold mb-2 text-[var(--color-muted)]">
        Power, attributed{' '}
        <span className="font-normal ml-1" title="Idle is the 10th percentile of a node's whole draw over the seven days before each day: what it burns with nothing to do. Draw above that is split across our sessions on the node by GPU-seconds; what none of ours explains is other work.">
          standing = idle draw · above it, split by GPU-seconds
        </span>
      </h5>
      <div className="overflow-x-auto" data-scroll-x>
        <table className="w-full text-sm [&_th]:px-2 [&_td]:px-2 [&_th]:whitespace-nowrap [&_td]:whitespace-nowrap">
          <thead>
            <tr className="text-[var(--color-muted)] text-left">
              <th className="pb-1">Node</th>
              <th className="pb-1 text-right">Idle</th>
              <th className="pb-1 text-right" title="The idle draw held for a month at the node's $/kWh: what it costs to keep on.">Standing /mo</th>
              <th className="pb-1 text-right">Standing</th>
              <th className="pb-1 text-right">Our sessions</th>
              <th className="pb-1 text-right">Other work</th>
              <th className="pb-1 text-right">Total</th>
            </tr>
          </thead>
          <tbody>
            {hosts.map((h) => (
              <tr key={h.hostname} className="border-t border-[var(--color-border)]">
                <td className="py-1">
                  {h.hostname}
                  {/* Fidelity of this row's energy (ticket 4013): B is exact joules from the
                      RAPL and NVML counters; C is integrated watts estimates. */}
                  <span
                    className={`ml-2 text-[10px] font-mono px-1 rounded border ${h.grade === 'B' ? 'border-[var(--color-accent)] text-[var(--color-accent)]' : 'border-[var(--color-border)] text-[var(--color-muted)]'}`}
                    title={h.grade === 'B'
                      ? `grade B: ${Math.round((h.measuredCoverage ?? 0) * 100)}% of sampled time measured by energy counters${h.measuredKwh != null ? `, ${h.measuredKwh.toFixed(2)} kWh measured` : ''}`
                      : `grade C: integrated from 15 s watts samples; counters covered ${Math.round((h.measuredCoverage ?? 0) * 100)}% of sampled time`}
                  >{h.grade ?? 'C'}</span>
                </td>
                <td className="py-1 text-right" title={h.idleSource === 'measured' ? 'idle measured: mean draw while the engine reported an empty queue' : 'idle estimated: p10 of the draw over the trailing week'}>
                  {h.idleWatts != null ? `${Math.round(h.idleWatts)} W` : '—'}{h.idleSource === 'measured' ? '' : h.idleWatts != null ? ' ~' : ''}
                </td>
                <td className="py-1 text-right">{h.standingMonthlyUSD != null ? usd(h.standingMonthlyUSD) : '—'}</td>
                <td className="py-1 text-right">{usd(h.standingUSD)}</td>
                <td className="py-1 text-right">{usd(h.attributedUSD)}</td>
                <td className="py-1 text-right">{usd(h.unattributedUSD)}</td>
                <td className="py-1 text-right" title={`${h.totalKwh.toFixed(2)} kWh at $${h.rateKwh.toFixed(3)}/kWh`}>{usd(h.totalUSD)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {lines.filter(([, v]) => v).map(([k, v]) => (
        <p key={k} className="text-xs text-[var(--color-muted)] mt-1">
          <span className="font-bold">{k}:</span> {v}
        </p>
      ))}
    </div>
  );
}

/** Fleet charts in their own card, placed below the node grid. */
export function FleetMetricsPanel(inputs: MeshScoreInputs) {
  const { score } = useMeshScore(inputs);
  if (inputs.allNodes.length === 0) return null;
  return (
    <div className="bg-[var(--color-surface)] rounded border border-[var(--color-border)] p-4">
      <FleetMetricsChart blendedKwhRate={score.blendedKwhRate} />
    </div>
  );
}
