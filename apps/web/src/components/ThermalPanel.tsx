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
import type { MergedTemp, SensorFan, ThrottleInfo } from '@/lib/sensors';

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

function useSensorHistory(host: string, temps: SensorTemp[], fans: SensorFan[], throttle: ThrottleInfo | null) {
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
      `clk=${throttle?.curMhz ?? ''}`,
      `thr=${throttle?.packageCount ?? ''}`,
    ].join(',');
    if (sig === lastSigRef.current) return;
    lastSigRef.current = sig;

    const row: HistRow = { tsMs: Date.now() };
    for (const t of temps) row[`t_${slug(t.name)}`] = t.tempC;
    for (const f of fans) row[`f_${slug(f.chip + '_' + f.key)}`] = f.rpm;
    if (throttle?.curMhz != null) row.clockMhz = throttle.curMhz;
    if (throttle?.maxMhz != null) row.clockMaxMhz = throttle.maxMhz;
    if (throttle?.packageCount != null) row.throttleCount = throttle.packageCount;

    sensorHistory.push(host, row);
  }, [temps, fans, throttle, host]);

  return rows;
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
  host, temps, fans, throttle,
}: {
  host: string;
  temps: SensorTemp[];
  fans: SensorFan[];
  throttle: ThrottleInfo | null;
}) {
  const history = useSensorHistory(host, temps, fans, throttle);

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
    return [...temps]
      .sort((a, b) => b.tempC / limitOf(b).limit - a.tempC / limitOf(a).limit)
      .slice(0, 8)
      .map((t, i) => ({
        key: `t_${slug(t.name)}`,
        label: t.name,
        stroke: STROKES[i % STROKES.length],
        width: 1.5,
      }));
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

  if (!temps.length && !fans.length && !throttle) return null;

  const byChip = temps.reduce<Record<string, SensorTemp[]>>((acc, t) => {
    (acc[t.chip] ??= []).push(t);
    return acc;
  }, {});

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
          {throttlingNow && (
            <span
              className="text-[10px] font-bold px-2 py-0.5 rounded bg-[var(--color-error)] text-white animate-pulse"
              title="Our package throttle counter rose between the last two polls — this machine is clamping its own clock right now to stay under its thermal limit. This is what a stuttering mouse and glitching audio feel like."
            >
              THROTTLING NOW
            </span>
          )}
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
            <div title={`Current CPU clock averaged across cores, against the rated maximum from cpuinfo_max_freq. Sustained time well under 100% while temperatures are high means our thermal limit — not our workload — is setting our speed.`}>
              <div
                className="text-2xl font-bold tabular-nums"
                style={{ color: throttle.clockPct < 70 ? '#ef4444' : throttle.clockPct < 90 ? '#f97316' : '#22c55e' }}
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
              {list.map(t => <SensorBar key={t.chip + t.key} t={t} />)}
            </div>
          ))}
        </div>
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
                Gap between our rated-max band and our clock line is thermal
                headroom we paid for and cannot use.
              </p>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
