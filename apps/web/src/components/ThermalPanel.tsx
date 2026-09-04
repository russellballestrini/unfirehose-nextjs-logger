'use client';

/**
 * Thermal + fan telemetry for a mesh node.
 *
 * Replaces a flat wrap of `zone 87°C` text. Three things it does that the
 * old section could not:
 *
 *   1. Grades each sensor against its OWN declared limit. hwmon publishes
 *      tempN_crit per sensor; 87°C on a die that crits at 100 is a different
 *      story from 87°C on an unbounded chassis zone, and painting both the
 *      same red taught us to ignore the color.
 *   2. Shows fans. This ThinkPad's fan runs at ~3950 RPM / 100% duty and no
 *      page on our permacomputer could see it.
 *   3. Shows what the heat COSTS — package throttle counters and current
 *      clock against rated max. A box parked at 61% of its rated clock is
 *      the stuttering mouse and glitching audio, quantified.
 *
 * History is a client-side rolling buffer persisted to localStorage, same
 * shape our training dashboard uses for its fan chart. Sensor readings are
 * not in mesh_snapshots yet (ticket 4005 open question b) — and no source
 * could backfill them anyway, so a client buffer loses nothing today.
 */

import { useEffect, useMemo, useRef, useSyncExternalStore } from 'react';
import { UPlotTimeChart, type UPlotSeries } from '@/components/UPlotTimeChart';
import type { MergedTemp, SensorFan, ThrottleInfo, CpuTopology, TopoCore } from '@/lib/sensors';

// Sensors lacking a declared crit still need a scale. Tjmax is ~100°C on
// essentially every x86 part we run, so grade against that and mark it
// assumed rather than either inventing alarm or showing none.
const ASSUMED_LIMIT_C = 100;

// 6s poll × 1200 = 2h of scrollback. Kept small enough that the JSON
// round-trip through localStorage stays under a millisecond.
const MAX_POINTS = 1200;

// Shapes come straight off /api/mesh/node — one declaration, in the module
// that parses them.
type SensorTemp = MergedTemp;

// `Core 12` from coretemp. Package/other labels deliberately excluded — the
// package sensor is the aggregate we want kept as a first-class series.
function coreIndexOf(t: { label: string }): number | null {
  const m = /^Core (\d+)$/.exec(t.label);
  return m ? parseInt(m[1]) : null;
}

// AMD's k10temp publishes NO per-core temperature at all — the finest
// granularity it exposes is one Tccd per chiplet. Those are still real
// physical units on the package, so a Ryzen gets a floorplan too, drawn at
// chiplet resolution instead of core resolution.
function chipletIndexOf(t: { label: string }): number | null {
  const m = /^Tccd(\d+)$/i.exec(t.label);
  return m ? parseInt(m[1]) : null;
}

// A core's identity is (socket, coreId) — every socket numbers from 0.
function coreKeyOf(t: { label: string; socket: number | null }): string | null {
  const i = coreIndexOf(t);
  return i == null ? null : `${t.socket ?? 0}/${i}`;
}

/**
 * Column count that renders `n` tiles as the squarest rectangle available.
 *
 * Prefers an exact divisor pair so a block comes out solid rather than with
 * a ragged last row — 8 becomes 4×2, 24 becomes 6×4, 16 becomes 4×4. Falls
 * back to a near-square ragged grid when n is prime or the best pair is too
 * elongated to read as a block (7 would otherwise be a 7×1 line).
 */
function bestCols(n: number): number {
  if (n <= 1) return 1;
  if (n <= 3) return n;
  let best = 0;
  for (let rows = 1; rows * rows <= n; rows++) {
    if (n % rows === 0) best = n / rows;   // widest-to-squarest exact pair
  }
  if (best && best / (n / best) <= 3) return best;
  return Math.ceil(Math.sqrt(n));
}

function slug(s: string) {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '');
}

function limitOf(t: SensorTemp): { limit: number; assumed: boolean } {
  const declared = t.critC ?? t.maxC;
  return declared ? { limit: declared, assumed: false } : { limit: ASSUMED_LIMIT_C, assumed: true };
}

// Bands are fractions of the sensor's own limit, not absolute degrees —
// that is the whole point of reading crit off the chip.
function heatColor(pct: number): string {
  if (pct >= 90) return '#ef4444';
  if (pct >= 75) return '#f97316';
  if (pct >= 60) return '#eab308';
  return '#22c55e';
}

// Distinct strokes for the temperature chart. Ordered so the hottest few
// sensors — which are drawn first — get the most separable hues.
const STROKES = [
  '#ef4444', '#f97316', '#eab308', '#22c55e', '#22d3ee',
  '#60a5fa', '#a78bfa', '#f472b6', '#94a3b8', '#2dd4bf',
];

type HistRow = Record<string, number>;

/**
 * Rolling sensor history, per host, backed by localStorage.
 *
 * This is a genuine external store rather than React state: the buffer
 * outlives any single mount, persists across reloads, and is appended to
 * from an effect. Holding it in useState meant calling setState inside that
 * effect, which cascades a second render on every 6s poll. Pushing into an
 * external store and reading it through useSyncExternalStore is the shape
 * React actually sanctions for this, and it renders once per sample.
 */
const sensorHistory = (() => {
  const buffers = new Map<string, HistRow[]>();
  const listeners = new Map<string, Set<() => void>>();
  const EMPTY: HistRow[] = [];

  function keyFor(host: string) {
    return `unfirehose-sensors-${host}`;
  }

  function load(host: string): HistRow[] {
    const cached = buffers.get(host);
    if (cached) return cached;
    let rows: HistRow[] = EMPTY;
    try {
      const raw = localStorage.getItem(keyFor(host));
      const parsed = raw ? JSON.parse(raw) : null;
      if (Array.isArray(parsed)) rows = parsed.slice(-MAX_POINTS);
    } catch {
      /* unreadable or malformed — start clean rather than throw at render */
    }
    buffers.set(host, rows);
    return rows;
  }

  return {
    // Stable reference between pushes — useSyncExternalStore loops forever
    // if getSnapshot returns a fresh array each call.
    snapshot(host: string): HistRow[] {
      return buffers.get(host) ?? EMPTY;
    },
    hydrate(host: string) {
      const before = buffers.get(host);
      const after = load(host);
      if (before !== after) emit(host);
    },
    push(host: string, row: HistRow) {
      const next = [...load(host), row].slice(-MAX_POINTS);
      buffers.set(host, next);
      try {
        localStorage.setItem(keyFor(host), JSON.stringify(next));
      } catch {
        /* quota — keep the in-memory series, drop persistence */
      }
      emit(host);
    },
    subscribe(host: string, cb: () => void) {
      let set = listeners.get(host);
      if (!set) listeners.set(host, (set = new Set()));
      set.add(cb);
      return () => { set!.delete(cb); };
    },
  };

  function emit(host: string) {
    listeners.get(host)?.forEach(cb => cb());
  }
})();

interface GpuInfo {
  index: number; name: string; tempC: number; gpuUtil: number; memUtil: number;
  memTotalMB: number; memUsedMB: number; powerDrawW: number; powerLimitW: number;
  fanPct: number; pstate: string;
  clockMhz?: number | null; clockMaxMhz?: number | null;
  throttle?: { mask: string; reasons: string[]; throttling: boolean; thermal: boolean } | null;
}

function gpuKey(g: GpuInfo, field: string) {
  return `g${g.index}_${field}`;
}

function useSensorHistory(
  host: string, temps: SensorTemp[], fans: SensorFan[],
  throttle: ThrottleInfo | null, gpus: GpuInfo[],
) {
  const rows = useSyncExternalStore(
    useMemo(() => (cb: () => void) => sensorHistory.subscribe(host, cb), [host]),
    () => sensorHistory.snapshot(host),
    () => [] as HistRow[],   // server render — localStorage does not exist
  );
  const lastSigRef = useRef<string>('');

  // Read persisted history after mount; touching localStorage during render
  // would desync hydration.
  useEffect(() => {
    lastSigRef.current = '';
    sensorHistory.hydrate(host);
  }, [host]);

  useEffect(() => {
    if (!temps.length && !fans.length && !throttle) return;

    // SWR revalidates on focus and interval, and hands back an identical
    // payload when the probe has not moved. Appending those would draw a
    // flat line that reads as real steady-state, so skip unchanged samples.
    const sig = [
      ...temps.map(t => `${t.chip}.${t.key}=${t.tempC}`),
      ...fans.map(f => `${f.chip}.${f.key}=${f.rpm}`),
      ...gpus.map(g => `g${g.index}=${g.tempC}/${g.gpuUtil}/${g.memUsedMB}/${g.powerDrawW}/${g.clockMhz}`),
      `clk=${throttle?.curMhz ?? ''}`,
      `thr=${throttle?.packageCount ?? ''}`,
    ].join(',');
    if (sig === lastSigRef.current) return;
    lastSigRef.current = sig;

    const row: HistRow = { tsMs: Date.now() };
    for (const t of temps) row[`t_${slug(t.name)}`] = t.tempC;

    // Envelope across CPU cores. Forty-eight individual lines is not a
    // chart; hottest-vs-coolest is, and it makes one pinned core visible as
    // a widening band instead of a line lost in a bundle.
    const coreTemps = temps.filter(t => coreIndexOf(t) !== null).map(t => t.tempC);
    if (coreTemps.length > 1) {
      row.coresMax = Math.max(...coreTemps);
      row.coresMin = Math.min(...coreTemps);
    }

    for (const f of fans) row[`f_${slug(f.chip + '_' + f.key)}`] = f.rpm;
    if (throttle?.curMhz != null) row.clockMhz = throttle.curMhz;
    if (throttle?.maxMhz != null) row.clockMaxMhz = throttle.maxMhz;
    if (throttle?.packageCount != null) row.throttleCount = throttle.packageCount;

    // Every GPU field we collect gets a series. Charting only temperature
    // meant we probed util, VRAM, power, fan and clocks on every poll and
    // then dropped them on the floor.
    for (const g of gpus) {
      row[gpuKey(g, 'temp')] = g.tempC;
      row[gpuKey(g, 'util')] = g.gpuUtil;
      row[gpuKey(g, 'memutil')] = g.memUtil;
      row[gpuKey(g, 'memgb')] = g.memUsedMB / 1024;
      row[gpuKey(g, 'memtotgb')] = g.memTotalMB / 1024;
      row[gpuKey(g, 'power')] = g.powerDrawW;
      row[gpuKey(g, 'powerlimit')] = g.powerLimitW;
      if (g.fanPct > 0) row[gpuKey(g, 'fan')] = g.fanPct;
      if (g.clockMhz != null) row[gpuKey(g, 'clock')] = g.clockMhz;
      if (g.clockMaxMhz != null) row[gpuKey(g, 'clockmax')] = g.clockMaxMhz;
    }

    sensorHistory.push(host, row);
  }, [temps, fans, throttle, gpus, host]);

  return rows;
}

function CoreTile({ t, topo, prefix = 'c' }: { t: SensorTemp; topo?: TopoCore; prefix?: string }) {
  const { limit } = limitOf(t);
  const pct = (t.tempC / limit) * 100;
  const color = heatColor(pct);
  const ghz = topo?.maxKhz ? (topo.maxKhz / 1_000_000).toFixed(1) : null;
  return (
    <div
      title={
        `${t.label} — ${t.tempC}°C, ${pct.toFixed(0)}% of its ${limit}°C limit.` +
        (ghz ? ` Rated ${ghz} GHz${topo?.tier ? ` (${topo.tier}-core)` : ''}.` : '') +
        (topo?.threads.length ? ` Threads: ${topo.threads.join(', ')}.` : '') +
        ' Numbering comes from coretemp and follows physical core IDs, which are sparse on many parts — 0, 4, 8, 12 is sorted, not shuffled.' +
        ' A single core well above its neighbours usually means one pinned thread, not a cooling fault.'
      }
      className="rounded text-center py-1 font-mono tabular-nums leading-tight border"
      style={{
        // Fill carries the heat so a block reads as a gradient at a glance;
        // the border keeps a cool core from vanishing entirely.
        //
        // Text stays a fixed near-white rather than the heat colour. Tinting
        // both meant an orange core printed orange on orange and a hot one
        // red on red — exactly where the number matters most, it disappeared.
        // Fill tops out at 80% so light text keeps its contrast at the red end.
        background: `color-mix(in srgb, ${color} ${Math.max(14, Math.min(pct * 0.8, 80))}%, transparent)`,
        borderColor: `color-mix(in srgb, ${color} 60%, transparent)`,
        color: '#fafafa',
      }}
    >
      <div className="text-[9px] opacity-55">{prefix}{coreIndexOf(t) ?? chipletIndexOf(t)}</div>
      <div className="text-[11px] font-bold">{t.tempC.toFixed(0)}°</div>
    </div>
  );
}

function CoreBlock({ list, topoBy, label, prefix = 'c' }: {
  list: SensorTemp[];
  topoBy: Map<string, TopoCore>;
  label?: string;
  prefix?: string;
}) {
  return (
    <div className="space-y-1">
      {label && (
        <div className="text-[9px] uppercase tracking-wide text-[var(--color-muted)]">{label}</div>
      )}
      <div
        className="grid gap-1"
        style={{ gridTemplateColumns: `repeat(${bestCols(list.length)}, minmax(0, 46px))` }}
      >
        {list.map(t => (
          <CoreTile key={t.instance + t.key} t={t} topo={topoBy.get(coreKeyOf(t) ?? '')} prefix={prefix} />
        ))}
      </div>
    </div>
  );
}

/**
 * Cores drawn as a die floorplan rather than one long line.
 *
 * Grouping comes from the machine's own topology: cores sharing a cluster
 * cache are drawn as one rectangle, because that is what they are on the
 * die. On an Intel hybrid part that yields four E-cores per shared-L2 quad
 * beside eight private-L2 P-cores; on AMD it yields a CCX per shared L3.
 * With no topology, or a homogeneous part, every core lands in one block
 * sized to the squarest rectangle that fits.
 */
function CoreFloorplan({ cores, topology, prefix = 'c' }: { cores: SensorTemp[]; topology: CpuTopology | null; prefix?: string }) {
  // A dual-socket box is two physical chips. Drawing their cores as one
  // block would be a floorplan of a package that does not exist, so each
  // socket gets its own die.
  const sockets = [...new Set(cores.map(c => c.socket ?? 0))].sort((a, b) => a - b);
  if (sockets.length > 1) {
    return (
      <div className="flex flex-wrap items-start gap-x-6 gap-y-3">
        {sockets.map(s => (
          <div key={s} className="space-y-1">
            <div className="text-[9px] uppercase tracking-wide text-[var(--color-muted)]">
              socket {s}
            </div>
            <div className="rounded border border-[var(--color-border)] p-1.5">
              <CoreFloorplanDie
                cores={cores.filter(c => (c.socket ?? 0) === s)}
                topology={topology}
                prefix={prefix}
              />
            </div>
          </div>
        ))}
      </div>
    );
  }
  return <CoreFloorplanDie cores={cores} topology={topology} prefix={prefix} />;
}

function CoreFloorplanDie({ cores, topology, prefix = 'c' }: { cores: SensorTemp[]; topology: CpuTopology | null; prefix?: string }) {
  // Keyed by socket/coreId, matching how sensors identify themselves. Core
  // IDs restart at 0 on every socket, so a bare coreId maps two different
  // physical cores onto one topology entry.
  const topoBy = new Map<string, TopoCore>();
  for (const c of topology?.cores ?? []) topoBy.set(`${c.pkg}/${c.coreId}`, c);

  // Cluster cores by the topology's own grouping. Cores the topology never
  // mentions still get drawn — a sensor without a matching core_id is worth
  // showing, just ungrouped.
  const groups = new Map<string, { cores: SensorTemp[]; topo?: TopoCore }>();
  for (const t of cores) {
    const ck = coreKeyOf(t);
    const topo = ck == null ? undefined : topoBy.get(ck);
    const key = topo?.clusterKey ?? 'ungrouped';
    const g = groups.get(key) ?? { cores: [], topo };
    g.cores.push(t);
    groups.set(key, g);
  }

  // Blocks: every private-cluster core (P-cores, or any homogeneous part)
  // merges into one rectangle; each multi-core cluster keeps its own.
  const singles: SensorTemp[] = [];
  const clusters: Array<{ key: string; cores: SensorTemp[]; topo?: TopoCore }> = [];
  for (const [key, g] of groups) {
    if (g.cores.length > 1) clusters.push({ key, cores: g.cores, topo: g.topo });
    else singles.push(...g.cores);
  }
  singles.sort((a, b) => (coreIndexOf(a)! - coreIndexOf(b)!));
  clusters.sort((a, b) => (coreIndexOf(a.cores[0])! - coreIndexOf(b.cores[0])!));

  const tierOf = (t: SensorTemp) => topoBy.get(coreKeyOf(t) ?? '')?.tier;
  const singlesTier = singles.length ? tierOf(singles[0]) : undefined;
  const clusterTier = clusters.length ? tierOf(clusters[0].cores[0]) : undefined;

  return (
    <div className="flex flex-wrap items-start gap-x-5 gap-y-3">
      {singles.length > 0 && (
        <CoreBlock
          list={singles}
          topoBy={topoBy}
          prefix={prefix}
          label={singlesTier === 'P' ? `${singles.length} P-cores` : undefined}
        />
      )}
      {clusters.length > 0 && (
        <div className="space-y-1">
          {clusterTier === 'E' && (
            <div className="text-[9px] uppercase tracking-wide text-[var(--color-muted)]">
              {clusters.reduce((n, c) => n + c.cores.length, 0)} E-cores
              <span className="ml-1 opacity-60">
                · {clusters.length} clusters sharing L{topology?.clusterLevel ?? 2}
              </span>
            </div>
          )}
          <div className="flex flex-wrap items-start gap-2">
            {clusters.map(c => (
              <div
                key={c.key}
                className="rounded border border-[var(--color-border)] p-1"
                title={`Cores ${c.cores.map(x => coreIndexOf(x)).join(', ')} share one L${topology?.clusterLevel ?? 2} cache — on the die they sit together as one cluster.`}
              >
                <div
                  className="grid gap-1"
                  style={{ gridTemplateColumns: `repeat(${bestCols(c.cores.length)}, minmax(0, 46px))` }}
                >
                  {c.cores
                    .sort((a, b) => (coreIndexOf(a)! - coreIndexOf(b)!))
                    .map(t => (
                      <CoreTile key={t.instance + t.key} t={t} topo={topoBy.get(coreKeyOf(t) ?? '')} prefix={prefix} />
                    ))}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

function SensorBar({ t }: { t: SensorTemp }) {
  const { limit, assumed } = limitOf(t);
  const pct = (t.tempC / limit) * 100;
  const color = heatColor(pct);
  return (
    <div
      className="space-y-1"
      title={
        `${t.name} — ${t.tempC}°C, ${pct.toFixed(0)}% of ${assumed ? 'an assumed' : 'its declared'} ${limit}°C limit.` +
        (assumed
          ? ' This sensor publishes no crit threshold, so we grade it against a nominal 100°C Tjmax.'
          : ` Chip ${t.chip} reports crit=${t.critC ?? '—'}°C.`)
      }
    >
      <div className="flex justify-between items-baseline text-xs">
        <span className="text-[var(--color-muted)] truncate mr-2">{t.name}</span>
        <span className="font-mono tabular-nums" style={{ color }}>
          {t.tempC.toFixed(1)}°
          <span className="text-[var(--color-muted)] ml-1 text-[10px]">
            /{limit}{assumed ? '?' : ''}
          </span>
        </span>
      </div>
      <div className="h-1.5 rounded bg-[var(--color-background)] overflow-hidden">
        <div
          className="h-full rounded transition-[width] duration-500"
          style={{ width: `${Math.min(pct, 100)}%`, background: color, opacity: assumed ? 0.55 : 1 }}
        />
      </div>
    </div>
  );
}

export function ThermalPanel({
  host, temps, fans, throttle, gpus = [], topology = null,
}: {
  host: string;
  temps: SensorTemp[];
  fans: SensorFan[];
  throttle: ThrottleInfo | null;
  gpus?: GpuInfo[];
  topology?: CpuTopology | null;
}) {
  const history = useSensorHistory(host, temps, fans, throttle, gpus);

  // Hottest by fraction-of-limit, with near-ties broken toward the sensor
  // whose limit the chip actually declared. Otherwise an ACPI alias of the
  // die (B0D4, acpitz) graded against our assumed 100°C wins the headline
  // over coretemp's `Package id 0` — same silicon, but only one of them
  // told us its real ceiling.
  const hottest = useMemo(() => {
    if (!temps.length) return null;
    return temps.reduce((a, b) => {
      const la = limitOf(a), lb = limitOf(b);
      const pa = (a.tempC / la.limit) * 100;
      const pb = (b.tempC / lb.limit) * 100;
      if (Math.abs(pa - pb) < 3 && la.assumed !== lb.assumed) return la.assumed ? b : a;
      return pb > pa ? b : a;
    });
  }, [temps]);

  // A throttle counter is monotonic since boot — 6.2M events on this box says
  // nothing about now. Only a rise BETWEEN two polls means it is throttling
  // as you read this.
  const throttlingNow = useMemo(() => {
    if (history.length < 2) return false;
    const a = history[history.length - 2]?.throttleCount;
    const b = history[history.length - 1]?.throttleCount;
    return typeof a === 'number' && typeof b === 'number' && b > a;
  }, [history]);

  // Chart the hottest sensors by headroom. Fourteen lines is unreadable;
  // the coolest ones are also the least interesting.
  const tempSeries: UPlotSeries[] = useMemo(() => {
    // Individual cores are collapsed to a hot/cool envelope. Left in, they
    // crowd out every other sensor on a many-core box — all eight "hottest"
    // slots go to cores that sit within a couple of degrees of each other.
    const coreCount = temps.filter(t => coreIndexOf(t) !== null).length;
    const envelope: UPlotSeries[] = coreCount > 1
      ? [
          { key: 'coresMax', label: `Hottest of ${coreCount} cores`, stroke: '#ef4444', fill: 'rgba(239,68,68,0.16)', width: 1.5 },
          { key: 'coresMin', label: 'Coolest core', stroke: '#60a5fa', width: 1 },
        ]
      : [];

    const rest = temps
      .filter(t => coreIndexOf(t) === null)
      .sort((a, b) => b.tempC / limitOf(b).limit - a.tempC / limitOf(a).limit)
      .slice(0, 8)
      .map((t, i) => ({
        key: `t_${slug(t.name)}`,
        label: t.name,
        stroke: STROKES[(i + envelope.length) % STROKES.length],
        width: 1.5,
      }));

    return [...envelope, ...rest];
  }, [temps]);

  const fanSeries: UPlotSeries[] = useMemo(
    () => fans.map((f, i) => ({
      key: `f_${slug(f.chip + '_' + f.key)}`,
      label: f.label || `${f.chip} ${f.key}`,
      stroke: STROKES[i % STROKES.length],
      fill: 'rgba(34,211,238,0.18)',
      width: 1.5,
    })),
    [fans],
  );

  const clockSeries: UPlotSeries[] = [
    { key: 'clockMaxMhz', label: 'Rated Max', stroke: '#52525b', fill: 'rgba(82,82,91,0.18)', watermark: true },
    { key: 'clockMhz', label: 'Current Clock', stroke: '#facc15', fill: 'rgba(250,204,21,0.22)', width: 1.5 },
  ];

  if (!temps.length && !fans.length && !throttle && !gpus.length) return null;

  // Individual CPU cores are the one sensor class that arrives in bulk — a
  // Threadripper hands us 48 of them. Rendered as bars they were 48 rows of
  // near-identical green stacked beside single-sensor chips, which is one
  // fact ("cores sit around 48°C") spent as 48 lines of vertical space.
  // Split them out for a compact grid; everything else keeps its bar.
  const cores = temps
    .filter(t => coreIndexOf(t) !== null)
    .sort((a, b) => (coreIndexOf(a)! - coreIndexOf(b)!));   // hwmon order is not core order

  // Only Intel's coretemp publishes per-core temperature. AMD's k10temp
  // stops at one Tccd per chiplet, so on a Ryzen the die units ARE the
  // chiplets. Anything with neither (a Pi's single SoC zone, a VM) simply
  // has no floorplan to draw and falls through to ordinary bars.
  const chiplets = cores.length
    ? []
    : temps
        .filter(t => chipletIndexOf(t) !== null)
        .sort((a, b) => (chipletIndexOf(a)! - chipletIndexOf(b)!));

  const dieUnits = cores.length ? cores : chiplets;
  const unitPrefix = cores.length ? 'c' : 'ccd';
  const unitNoun = cores.length
    ? `${cores.length} cpu cores`
    : `${chiplets.length} chiplet${chiplets.length === 1 ? '' : 's'}`;
  const unitSet = new Set(dieUnits);

  const byChip = temps.reduce<Record<string, SensorTemp[]>>((acc, t) => {
    if (unitSet.has(t)) return acc;
    (acc[t.chip] ??= []).push(t);
    return acc;
  }, {});

  const coreStats = dieUnits.length
    ? (() => {
        const vals = dieUnits.map(c => c.tempC).sort((a, b) => a - b);
        const hottest = dieUnits.reduce((a, b) => (b.tempC > a.tempC ? b : a));
        return {
          min: vals[0],
          max: vals[vals.length - 1],
          median: vals[Math.floor(vals.length / 2)],
          hottest,
          limit: limitOf(dieUnits[0]).limit,
        };
      })()
    : null;

  const SYNC = `thermal-${host}`;
  const cardCls = 'bg-[var(--color-surface)] rounded border border-[var(--color-border)] p-4';
  // uPlot needs at least two points before a line means anything.
  const showCharts = history.length >= 2;

  return (
    <div className="space-y-4">
      <div className={cardCls}>
        <div className="flex items-center justify-between flex-wrap gap-2 mb-3">
          <h3 className="text-sm font-bold text-[var(--color-muted)]">
            Thermal &amp; Cooling
          </h3>
          <div className="flex items-center gap-2 flex-wrap">
            {/* Scoped to CPU on purpose. On a GPU box an unqualified badge
                reads as a claim about the card, which is a different sensor
                with a different ground truth (NVML throttle reasons). */}
            {throttlingNow && (
              <span
                className="text-[10px] font-bold px-2 py-0.5 rounded bg-[var(--color-error)] text-white animate-pulse"
                title="Our CPU package throttle counter rose between the last two polls — this machine is clamping its own clock right now to stay under its thermal limit. This is what a stuttering mouse and glitching audio feel like."
              >
                CPU THROTTLING NOW
              </span>
            )}
            {gpus.filter(g => g.throttle?.throttling).map(g => (
              <span
                key={g.index}
                className="text-[10px] font-bold px-2 py-0.5 rounded bg-[var(--color-error)] text-white"
                title={`nvidia-smi reports active throttle reasons for this card: ${g.throttle!.reasons.join(', ')}. This comes from NVML's own bitmask, not inferred from a clock ratio.`}
              >
                GPU{gpus.length > 1 ? ` ${g.index}` : ''} {g.throttle!.thermal ? 'THERMAL' : 'POWER'} CAP
              </span>
            ))}
          </div>
        </div>

        {/* Headline: hottest sensor, clock held, fan */}
        <div className="flex flex-wrap gap-6 mb-4">
          {hottest && (() => {
            const { limit, assumed } = limitOf(hottest);
            const pct = (hottest.tempC / limit) * 100;
            return (
              <div title={`Hottest sensor relative to its own limit — not simply the highest number. ${hottest.name} sits at ${pct.toFixed(0)}% of ${assumed ? 'an assumed' : 'its declared'} ${limit}°C ceiling.`}>
                <div className="text-2xl font-bold tabular-nums" style={{ color: heatColor(pct) }}>
                  {hottest.tempC.toFixed(1)}°C
                </div>
                <div className="text-xs text-[var(--color-muted)]">
                  {hottest.name} · {pct.toFixed(0)}% of {limit}°{assumed ? ' (assumed)' : ''}
                </div>
              </div>
            );
          })()}

          {throttle?.clockPct != null && (
            <div title={`Current CPU clock averaged across cores, against the rated maximum from cpuinfo_max_freq. A low ratio on its own is NOT throttling — an idle CPU parks at its minimum P-state by design. Only a rising throttle counter proves our thermal limit is setting our speed, so this reads neutral unless that counter moves.`}>
              <div
                className="text-2xl font-bold tabular-nums"
                style={{ color: throttlingNow ? '#ef4444' : 'var(--color-foreground)' }}
              >
                {throttle.clockPct.toFixed(0)}%
              </div>
              <div className="text-xs text-[var(--color-muted)]">
                clock · {throttle.curMhz}/{throttle.maxMhz} MHz
              </div>
            </div>
          )}

          {fans.length > 0 ? (
            fans.map(f => (
              <div
                key={f.chip + f.key}
                title={`Fan speed from ${f.chip}/${f.key}${f.pwmPct != null ? `, driven at ${f.pwmPct.toFixed(0)}% duty` : ''}. A fan pinned at full duty with temperatures still climbing means we have run out of cooling headroom.`}
              >
                <div className="text-2xl font-bold tabular-nums text-[#22d3ee]">
                  {f.rpm.toLocaleString()}
                </div>
                <div className="text-xs text-[var(--color-muted)]">
                  RPM {f.label || f.key}
                  {f.pwmPct != null && ` · ${f.pwmPct.toFixed(0)}% duty`}
                </div>
              </div>
            ))
          ) : (
            <div title="This box exposes no fan telemetry through hwmon — either it is passively cooled, or its fan controller is not driven by a kernel driver that publishes RPM.">
              <div className="text-2xl font-bold text-[var(--color-muted)]">—</div>
              <div className="text-xs text-[var(--color-muted)]">no fan telemetry</div>
            </div>
          )}

          {gpus.map(g => (
            <div
              key={g.index}
              title={`${g.name} die temperature at ${g.gpuUtil}% utilization, drawing ${g.powerDrawW}W of a ${g.powerLimitW}W limit${g.clockMhz ? ` at ${g.clockMhz}/${g.clockMaxMhz} MHz` : ''}. Throttle state comes from NVML: ${g.throttle ? (g.throttle.reasons.length ? g.throttle.reasons.join(', ') : 'no active reasons') : 'not reported by this driver'}.`}
            >
              <div
                className="text-2xl font-bold tabular-nums"
                style={{ color: g.throttle?.thermal ? '#ef4444' : heatColor((g.tempC / 85) * 100) }}
              >
                {g.tempC}°C
              </div>
              <div className="text-xs text-[var(--color-muted)]">
                GPU{gpus.length > 1 ? ` ${g.index}` : ''} · {g.gpuUtil}% · {g.powerDrawW}W
                {g.fanPct > 0 && ` · ${g.fanPct}% fan`}
              </div>
            </div>
          ))}

          {throttle?.packageCount != null && (
            <div title={`Total package throttle events since boot, from /sys/devices/system/cpu/*/thermal_throttle/package_throttle_count. Cumulative — useful as a lifetime measure of how thermally constrained this machine has been, not as a reading of right now.${throttle.packageMs ? ` Total time spent throttled: ${(throttle.packageMs / 3_600_000).toFixed(1)} hours.` : ''}`}>
              <div className="text-2xl font-bold tabular-nums text-[var(--color-muted)]">
                {throttle.packageCount.toLocaleString()}
              </div>
              <div className="text-xs text-[var(--color-muted)]">
                throttle events since boot
                {throttle.packageMs ? ` · ${(throttle.packageMs / 3_600_000).toFixed(1)}h` : ''}
              </div>
            </div>
          )}
        </div>

        {/* Per-chip sensor bars */}
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-x-6 gap-y-4">
          {Object.entries(byChip).map(([chip, list]) => (
            <div key={chip} className="space-y-2">
              <div className="text-[10px] uppercase tracking-wide text-[var(--color-muted)] font-bold">
                {chip}
              </div>
              {list.map(t => <SensorBar key={t.instance + t.key} t={t} />)}
            </div>
          ))}
        </div>

        {/* CPU cores as a heat grid — the spread and any outlier is the
            signal here, not each core's individual number. */}
        {coreStats && (
          <div className="mt-4 space-y-2">
            <div className="flex items-baseline justify-between flex-wrap gap-x-4 gap-y-1">
              <span className="text-[10px] uppercase tracking-wide text-[var(--color-muted)] font-bold">
                {unitNoun}
              </span>
              <span className="text-xs text-[var(--color-muted)] tabular-nums">
                {coreStats.min.toFixed(0)}–{coreStats.max.toFixed(0)}°C
                &middot; median {coreStats.median.toFixed(0)}°
                &middot; hottest {coreStats.hottest.label}
                <span className="ml-1 opacity-60">/{coreStats.limit}°</span>
              </span>
            </div>
            <CoreFloorplan cores={dieUnits} topology={topology} prefix={unitPrefix} />
          </div>
        )}
      </div>

      {showCharts && (
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
          {tempSeries.length > 0 && (
            <div className={cardCls}>
              <h3 className="text-base font-bold mb-3 text-[var(--color-muted)]">
                Temperatures
                <span className="text-xs font-normal ml-2">
                  top {tempSeries.length} by headroom · °C
                </span>
              </h3>
              <UPlotTimeChart
                data={history} series={tempSeries} height={180}
                syncKey={SYNC} domain={null} yUnit="°C"
              />
            </div>
          )}

          {fanSeries.length > 0 && (
            <div className={cardCls}>
              <h3 className="text-base font-bold mb-3 text-[var(--color-muted)]">
                Fan Speed
                <span className="text-xs font-normal ml-2">
                  {fans.map(f => `${f.rpm.toLocaleString()} RPM`).join(' · ')}
                </span>
              </h3>
              <UPlotTimeChart
                data={history} series={fanSeries} height={180}
                syncKey={SYNC} domain={null} yUnit=" RPM" yMin={0}
              />
            </div>
          )}

          {throttle?.maxMhz != null && (
            <div className={cardCls}>
              <h3 className="text-base font-bold mb-3 text-[var(--color-muted)]">
                CPU Clock
                <span className="text-xs font-normal ml-2">
                  {throttle.curMhz} / {throttle.maxMhz} MHz
                </span>
              </h3>
              <UPlotTimeChart
                data={history} series={clockSeries} height={180}
                syncKey={SYNC} domain={null} yUnit=" MHz" yMin={0}
              />
              <p className="text-[11px] text-[var(--color-muted)] mt-2">
                A gap under our rated-max band is not automatically throttling —
                an idle CPU parks low by design. It only costs us when the
                throttle counter is climbing at the same time.
              </p>
            </div>
          )}

          {/* Every GPU field the probe collects, charted. */}
          {gpus.map(g => {
            const label = gpus.length > 1 ? `GPU ${g.index}` : 'GPU';
            const charts: Array<{ title: string; note: string; unit: string; max?: number; series: UPlotSeries[] }> = [
              {
                title: `${label} Temperature`, note: `${g.tempC}°C`, unit: '°C',
                series: [{ key: gpuKey(g, 'temp'), label: 'Die', stroke: '#ef4444', fill: 'rgba(239,68,68,0.22)', width: 1.5 }],
              },
              {
                title: `${label} Utilization`, note: `${g.gpuUtil}% core · ${g.memUtil}% mem bus`, unit: '%', max: 100,
                series: [
                  { key: gpuKey(g, 'util'), label: 'Core', stroke: '#22c55e', fill: 'rgba(34,197,94,0.22)', width: 1.5 },
                  { key: gpuKey(g, 'memutil'), label: 'Mem bus', stroke: '#22d3ee', width: 1.5 },
                ],
              },
              {
                title: `${label} VRAM`, note: `${(g.memUsedMB / 1024).toFixed(1)} / ${(g.memTotalMB / 1024).toFixed(1)} GB`, unit: 'GB',
                series: [
                  { key: gpuKey(g, 'memtotgb'), label: 'Total', stroke: '#52525b', fill: 'rgba(82,82,91,0.18)', watermark: true },
                  { key: gpuKey(g, 'memgb'), label: 'Used', stroke: '#22c55e', fill: 'rgba(34,197,94,0.25)', width: 1.5 },
                ],
              },
              {
                title: `${label} Power`, note: `${g.powerDrawW}W / ${g.powerLimitW}W`, unit: 'W',
                series: [
                  { key: gpuKey(g, 'powerlimit'), label: 'Limit', stroke: '#52525b', fill: 'rgba(82,82,91,0.18)', watermark: true },
                  { key: gpuKey(g, 'power'), label: 'Draw', stroke: '#a78bfa', fill: 'rgba(167,139,250,0.25)', width: 1.5 },
                ],
              },
            ];
            // A passive card reports 0% and means "no onboard fan", not
            // "stopped" — charting a flat zero would invent a dead fan.
            if (g.fanPct > 0) {
              charts.push({
                title: `${label} Fan`, note: `${g.fanPct}%`, unit: '%', max: 100,
                series: [{ key: gpuKey(g, 'fan'), label: 'Fan', stroke: '#22d3ee', fill: 'rgba(34,211,238,0.22)', width: 1.5 }],
              });
            }
            if (g.clockMhz != null) {
              charts.push({
                title: `${label} Clock`, note: `${g.clockMhz} / ${g.clockMaxMhz} MHz`, unit: ' MHz',
                series: [
                  ...(g.clockMaxMhz != null ? [{ key: gpuKey(g, 'clockmax'), label: 'Max', stroke: '#52525b', fill: 'rgba(82,82,91,0.18)', watermark: true } as UPlotSeries] : []),
                  { key: gpuKey(g, 'clock'), label: 'Current', stroke: '#facc15', fill: 'rgba(250,204,21,0.22)', width: 1.5 },
                ],
              });
            }
            return charts.map(c => (
              <div key={`${g.index}-${c.title}`} className={cardCls}>
                <h3 className="text-base font-bold mb-3 text-[var(--color-muted)]">
                  {c.title}
                  <span className="text-xs font-normal ml-2">{c.note}</span>
                </h3>
                <UPlotTimeChart
                  data={history} series={c.series} height={180}
                  syncKey={SYNC} domain={null} yUnit={c.unit} yMin={0} yMax={c.max}
                />
              </div>
            ));
          })}
        </div>
      )}
    </div>
  );
}
