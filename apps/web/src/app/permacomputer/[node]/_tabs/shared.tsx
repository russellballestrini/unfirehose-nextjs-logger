'use client';

/** What the node page's tabs share: the props shape, the Section card, small readouts and chart overlay styles. */

import React from 'react';
import { GaugeTrack } from '@unturf/unfirehose-ui/Gauge';
import { human } from '@unturf/unfirehose/ago';
import { formatBytes } from '@unturf/unfirehose/format';

/* eslint-disable @typescript-eslint/no-explicit-any */

/**
 * What every tab on this page is handed.
 *
 * All five destructured the same names regardless of which they used, so
 * the list appeared five times and had to be kept in step by hand. Each
 * tab now names what it reads, which is the only record of what it
 * depends on.
 */
export interface TabProps {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  [key: string]: any;
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

/** "2 cores", "0.5 core", or "cores" with the count unknown. */
export function cores(n: number | null | undefined): string {
  if (n == null) return '';
  return `${n} ${n === 1 ? 'core' : 'cores'}`;
}

/** A small filled pill: a state, a verdict, a count. */
export function Badge({ children, color, title }: { children: React.ReactNode; color: string; title?: string }) {
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
export function ResourceBar({ label, pct, value, ceiling, thresholds }: {
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
export function Pressure({ psi }: { psi: { cpu: number | null; memory: number | null; io: number | null } }) {
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

/** One figure in a tab's summary row: a label, its value, a line under it. */
export function tile(label: string, value: string, sub?: string) {
  return (
    <div key={label} className="bg-[var(--color-surface)] rounded border border-[var(--color-border)] px-3 py-2">
      <div className="text-[10px] uppercase tracking-wide text-[var(--color-muted)]">{label}</div>
      <div className="text-lg font-mono leading-tight">{value}</div>
      {sub && <div className="text-[10px] text-[var(--color-muted)]">{sub}</div>}
    </div>
  );
}

/** "4096 MiB" reads as "4 GiB"; the guest's configured memory, not its use. */
export function vmMem(mb: number | null | undefined): string {
  if (mb == null) return '—';
  return formatBytes(mb * 1_048_576);
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

export function SshField({ label, value, placeholder, onChange }: {
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

export function TunableRow({ label, unit, step, value, placeholder, onChange }: {
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
