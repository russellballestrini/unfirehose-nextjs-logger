'use client';

/**
 * A proportion, shown as a filled track.
 *
 * Six variations of this lived across three pages — MiniGauge, GaugeBar,
 * GaugeCard, GaugePill and two components both called Bar — and every one
 * rebuilt the same two divs and re-decided when a number turns yellow and
 * when it turns red. Four of them wrote out `pct > 85 ? red : pct > 60 ?
 * yellow : accent` in full, so changing what counts as alarming meant
 * finding all four.
 *
 * What differs between them is arrangement — a tight row, a labelled block,
 * a card, a pill — and that is a real difference worth keeping. The track,
 * the fill and the thresholds are not.
 */

export interface GaugeThresholds {
  /** Above this, yellow. */
  warn: number;
  /** Above this, red. */
  danger: number;
}

/** Utilisation: most of a disk or a memory bank is fine until it is not. */
export const UTILISATION: GaugeThresholds = { warn: 60, danger: 85 };

/**
 * Load average per core, where the alarm sounds far earlier — a machine at
 * 50% of its cores committed is already queueing work.
 */
export const SATURATION: GaugeThresholds = { warn: 20, danger: 50 };

/**
 * Note that the resting colour is the accent, which is our brand red. So a
 * gauge is red at both ends: what marks the difference is the yellow band
 * between them and the distinctly brighter red above. Worth knowing before
 * reading a wall of these as "everything is on fire".
 */
export function gaugeColor(pct: number, t: GaugeThresholds = UTILISATION): string {
  if (pct > t.danger) return '#ef4444';
  if (pct > t.warn) return '#eab308';
  return 'var(--color-accent)';
}

export interface GaugeTrackProps {
  pct: number;
  /** Overrides the threshold colour, for a series that carries its own. */
  color?: string;
  thresholds?: GaugeThresholds;
  /** Tailwind height, e.g. `h-1`, `h-1.5`, `h-2`, `h-2.5`. */
  height?: string;
  /** The groove behind the fill: background inside a surface, surface inside a page. */
  track?: string;
  className?: string;
}

/** The bar itself, with nothing around it. */
export function GaugeTrack({
  pct, color, thresholds, height = 'h-1.5',
  track = 'bg-[var(--color-background)]', className = '',
}: GaugeTrackProps) {
  return (
    <div className={`${height} ${track} rounded-full overflow-hidden ${className}`}>
      <div
        className="h-full rounded-full transition-all"
        // Clamped: a percentage computed from a stale or zero denominator
        // can exceed 100, and a fill wider than its track spills the row.
        style={{
          width: `${Math.max(0, Math.min(100, pct))}%`,
          backgroundColor: color ?? gaugeColor(pct, thresholds),
        }}
      />
    </div>
  );
}

/** Label, bar, value — one line. For dense lists of measurements. */
export function GaugeRow({ label, value, pct }: { label: string; value: string; pct: number }) {
  return (
    <div className="flex items-center gap-2">
      <span className="text-xs text-[var(--color-muted)] w-10 shrink-0">{label}</span>
      <GaugeTrack pct={pct} className="flex-1" />
      <span className="text-xs font-mono w-24 text-right shrink-0 whitespace-nowrap">{value}</span>
    </div>
  );
}

/** Label and value above the bar, with room for a caption under it. */
export function GaugeBlock({
  label, pct, value, sub, warn,
}: { label: string; pct: number; value: string; sub?: string; warn?: boolean }) {
  return (
    <div>
      <div className="flex items-center justify-between mb-1">
        <span className="text-xs font-bold">{label}</span>
        <span className="text-xs font-mono">{value}</span>
      </div>
      <GaugeTrack
        pct={pct}
        height="h-2.5"
        track="bg-[var(--color-surface)]"
        color={warn ? '#ef4444' : undefined}
      />
      {sub && <div className="text-xs text-[var(--color-muted)] mt-0.5">{sub}</div>}
    </div>
  );
}

/** The percentage as the headline, on its own ground. */
export function GaugeCard({ label, pct, value }: { label: string; pct: number; value: string }) {
  const color = gaugeColor(pct);
  return (
    <div className="bg-[var(--color-surface)] rounded p-3">
      <div className="text-xs text-[var(--color-muted)] mb-1">{label}</div>
      <div className="text-lg font-mono font-bold mb-1" style={{ color }}>{pct}%</div>
      <GaugeTrack pct={pct} color={color} />
      <div className="text-xs text-[var(--color-muted)] mt-1">{value}</div>
    </div>
  );
}

/**
 * A fixed-width pill for a raw figure against a ceiling — load average
 * against core count, where the number matters more than the proportion.
 */
export function GaugePill({ label, value, max }: { label: string; value: number; max: number }) {
  const pct = max > 0 ? Math.min(100, Math.round((value / max) * 100)) : 0;
  const color = gaugeColor(pct, SATURATION);
  return (
    <div className="flex items-center gap-1 w-20">
      <span className="text-xs text-[var(--color-muted)]">{label}</span>
      <GaugeTrack pct={pct} color={color} height="h-1" className="flex-1" />
      <span className="text-xs font-mono" style={{ color }}>{value.toFixed(1)}</span>
    </div>
  );
}
