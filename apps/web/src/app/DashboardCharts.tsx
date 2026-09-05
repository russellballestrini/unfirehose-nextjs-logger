'use client';

/**
 * The dashboard's charts, loaded after the numbers.
 *
 * recharts is 326KB minified. It used to arrive with the page: the stats
 * cards a reader came for could not paint until the charting library had
 * parsed, and every reload paid that before showing anything. The five
 * charts live here now and page.tsx loads this module with next/dynamic and
 * ssr:false — the cards render from the first bundle, and the charts fill
 * in a moment later, below them, where the eye gets to second.
 *
 * ssr:false is not a shortcut: recharts measures its container to size
 * itself and renders nothing useful on the server anyway.
 */

import {
  AreaChart, Area, BarChart, Bar, Cell, PieChart, Pie,
  ResponsiveContainer, Tooltip, XAxis, YAxis,
} from 'recharts';
import { AXIS_TICK, TOOLTIP_STYLE } from '@unturf/unfirehose-ui/chart-theme';
import { getModelColor } from '@unturf/unfirehose-ui/modelColor';
import { formatTokens } from '@unturf/unfirehose/format';

/* eslint-disable @typescript-eslint/no-explicit-any */

const DAY_COLORS = [
  '#ef4444', // Sun - red
  '#f59e0b', // Mon - amber
  '#10b981', // Tue - emerald
  '#06b6d4', // Wed - cyan
  '#6366f1', // Thu - indigo
  '#a78bfa', // Fri - violet
  '#ec4899', // Sat - pink
];

export function DashboardCharts({ data, range }: { data: any; range: string }) {
  const sleepCenter = findSleepCenter(data.hourCounts ?? []);
  const rotatedHours = rotateHours(data.hourCounts ?? [], sleepCenter);
  const localOffset = getLocalOffsetHours();

  // Both hour charts share an axis: the same ticks, the same interval, the
  // same dual-timezone label. Recharts wants these as direct children of a
  // chart, so what is shared is the props rather than the elements.
  const hourAxis = {
    dataKey: 'hour',
    tick: <DualHourTick offset={localOffset} />,
    interval: 2,
    height: 40,
  };
  const hourTooltip = (h: unknown) => formatDualHourTooltip(h as number);

  const tzName = Intl.DateTimeFormat().resolvedOptions().timeZone;

  // Build day-of-week × hour curves for the heatmap
  const dowHourData = buildDowHourCurves(data.dowHourHeatmap ?? [], sleepCenter);

  return (
    <>
    {/* Charts row: activity + hour distribution */}
    <div className="grid grid-cols-2 gap-4">
      <div className="bg-[var(--color-surface)] rounded border border-[var(--color-border)] p-4">
        <h3 className="text-base font-bold mb-3 text-[var(--color-muted)]">
          Activity ({range})
        </h3>
        <ResponsiveContainer width="100%" height={200}>
          <BarChart data={data.dailyActivity}>
            <XAxis
              dataKey="date"
              tick={AXIS_TICK}
              tickFormatter={(d: string) => d.slice(5)}
            />
            <YAxis tick={AXIS_TICK} />
            <Tooltip
              contentStyle={TOOLTIP_STYLE}
            />
            <Bar dataKey="messageCount" fill="#10b981" radius={[2, 2, 0, 0]} />
          </BarChart>
        </ResponsiveContainer>
      </div>

      <div className="bg-[var(--color-surface)] rounded border border-[var(--color-border)] p-4">
        <h3 className="text-base font-bold mb-3 text-[var(--color-muted)]">
          Hour Distribution
          <span className="font-normal text-[var(--color-muted)] ml-2">
            UTC {localOffset >= 0 ? '+' : ''}{localOffset} ({tzName})
          </span>
        </h3>
        <ResponsiveContainer width="100%" height={220}>
          <BarChart data={rotatedHours} margin={{ bottom: 16 }}>
            <XAxis {...hourAxis} />
            <YAxis tick={AXIS_TICK} />
            <Tooltip contentStyle={TOOLTIP_STYLE} labelFormatter={hourTooltip} />
            <Bar dataKey="count" fill="#a78bfa" radius={[2, 2, 0, 0]} />
          </BarChart>
        </ResponsiveContainer>
      </div>
    </div>

    {/* Day of week charts row */}
    <div className="grid grid-cols-2 gap-4">
      {/* Day of week totals */}
      <div className="bg-[var(--color-surface)] rounded border border-[var(--color-border)] p-4">
        <h3 className="text-base font-bold mb-3 text-[var(--color-muted)]">
          Day of Week ({range})
        </h3>
        <ResponsiveContainer width="100%" height={200}>
          <BarChart data={data.dayOfWeekCounts}>
            <XAxis dataKey="day" tick={AXIS_TICK} />
            <YAxis tick={AXIS_TICK} />
            <Tooltip
              contentStyle={TOOLTIP_STYLE}
            />
            <Bar dataKey="count" radius={[2, 2, 0, 0]}>
              {(data.dayOfWeekCounts ?? []).map((d: any) => (
                <Cell key={d.day} fill={DAY_COLORS[d.dow]} />
              ))}
            </Bar>
          </BarChart>
        </ResponsiveContainer>
      </div>

      {/* Day × Hour hotspot curves */}
      <div className="bg-[var(--color-surface)] rounded border border-[var(--color-border)] p-4">
        <h3 className="text-base font-bold mb-3 text-[var(--color-muted)]">
          Hotspots by Day &times; Hour
          <span className="font-normal text-[var(--color-muted)] ml-2">
            UTC {localOffset >= 0 ? '+' : ''}{localOffset}
          </span>
        </h3>
        <ResponsiveContainer width="100%" height={220}>
          <AreaChart data={dowHourData} margin={{ bottom: 16 }}>
            <XAxis {...hourAxis} />
            <YAxis tick={AXIS_TICK} />
            <Tooltip contentStyle={TOOLTIP_STYLE} labelFormatter={hourTooltip} />
            {['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].map((day, i) => (
              <Area
                key={day}
                type="monotone"
                dataKey={day}
                stroke={DAY_COLORS[i]}
                fill={DAY_COLORS[i]}
                fillOpacity={0.1}
                strokeWidth={1.5}
              />
            ))}
          </AreaChart>
        </ResponsiveContainer>
      </div>
    </div>

    </>
  );
}

/** The token-share pie beside the model table. */
export function ModelUsagePie({ modelData }: { modelData: any[] }) {
  return (
    <ResponsiveContainer width={200} height={200}>
      <PieChart>
        <Pie
          data={modelData}
          dataKey="tokens"
          nameKey="name"
          cx="50%"
          cy="50%"
          innerRadius={40}
          outerRadius={80}
          strokeWidth={0}
        >
          {modelData.map((entry: any) => (
            <Cell
              key={entry.fullName}
              fill={getModelColor(entry.fullName)}
            />
          ))}
        </Pie>
        <Tooltip
          contentStyle={{
            background: '#18181b',
            border: '1px solid #3f3f46',
            borderRadius: 4,
            color: '#fafafa',
            fontSize: 16,
          }}
          formatter={(value: any, _n: any, entry: any) => {
            const p = entry?.payload ?? {};
            return [
              `${formatTokens(Number(value ?? 0))} (in ${formatTokens(p.inputTokens ?? 0)} · out ${formatTokens(p.outputTokens ?? 0)} · cache ${formatTokens((p.cacheReadTokens ?? 0) + (p.cacheWriteTokens ?? 0))})`,
              'tokens',
            ];
          }}
        />
      </PieChart>
    </ResponsiveContainer>
  );
}

function findSleepCenter(hourCounts: { hour: number; count: number }[]): number {
  const counts = new Array(24).fill(0);
  for (const h of hourCounts) counts[h.hour] = h.count;

  const windowSize = 6;
  let minSum = Infinity;
  let minStart = 0;

  for (let start = 0; start < 24; start++) {
    let sum = 0;
    for (let j = 0; j < windowSize; j++) {
      sum += counts[(start + j) % 24];
    }
    if (sum < minSum) {
      minSum = sum;
      minStart = start;
    }
  }

  // Center of the sleep window = start offset for the chart
  return (minStart + Math.floor(windowSize / 2)) % 24;
}

/** Rotate an array of 24 hourly items so that `startHour` is index 0 */
function rotateHours<T extends { hour: number }>(data: T[], startHour: number): T[] {
  // Fill sparse data into a full 24-hour array
  const full = new Array(24).fill(null).map((_, i) => {
    const existing = data.find((d) => d.hour === i);
    return existing ?? { hour: i, count: 0 } as unknown as T;
  });
  return [...full.slice(startHour), ...full.slice(0, startHour)];
}

/** Get the browser's UTC offset in hours (e.g., -5 for EST) */
function getLocalOffsetHours(): number {
  return -(new Date().getTimezoneOffset() / 60);
}

function formatDualHourTooltip(utcHour: number): string {
  const offset = getLocalOffsetHours();
  const localHour = ((utcHour + offset) % 24 + 24) % 24;
  return `${utcHour}:00 UTC / ${localHour}:00 local`;
}

/** Pivot dow×hour rows into {hour, Sun, Mon, Tue, ...} for area chart */
function buildDowHourCurves(heatmap: any[], startHour: number): any[] {
  const dayNames = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const rows: any[] = [];
  for (let h = 0; h < 24; h++) {
    const row: any = { hour: h };
    for (const day of dayNames) row[day] = 0;
    rows.push(row);
  }
  for (const entry of heatmap) {
    const day = dayNames[entry.dow];
    if (day && rows[entry.hour]) {
      rows[entry.hour][day] = entry.count;
    }
  }
  // Rotate to match the same sleep-centered ordering
  return [...rows.slice(startHour), ...rows.slice(0, startHour)];
}

/** Custom tick that renders UTC on top, local below */
function DualHourTick({ x, y, payload, offset }: any) {
  const utcH = payload.value;
  const localH = ((utcH + offset) % 24 + 24) % 24;
  return (
    <g transform={`translate(${x},${y})`}>
      <text x={0} y={0} dy={12} textAnchor="middle" fill="#71717a" fontSize={11}>
        {utcH}:00
      </text>
      <text x={0} y={0} dy={24} textAnchor="middle" fill="#a78bfa" fontSize={10}>
        {localH}:00
      </text>
    </g>
  );
}


