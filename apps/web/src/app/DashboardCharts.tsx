'use client';

/**
 * The dashboard's charts, loaded after the numbers.
 *
 * Four of the five draw on uPlot, which is 49KB and already on the page for
 * the node charts; the model-share pie draws on our own canvas donut, built
 * in uPlot's image. Nothing here is recharts any more. The module still
 * loads through next/dynamic with ssr:false, so the stats cards a reader
 * came for paint from the first bundle and the charts fill in below them.
 *
 * ssr:false is not a shortcut: recharts measures its container to size
 * itself and renders nothing useful on the server anyway.
 */

import { Donut } from '@/components/Donut';
import { UPlotCategoryChart } from '@/components/UPlotCategoryChart';
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
        <UPlotCategoryChart
          data={data.dailyActivity ?? []}
          labelKey="date"
          series={[{ key: 'messageCount', label: 'messages', color: '#10b981' }]}
          height={200}
          tick={(d) => d.slice(5)}
        />
      </div>

      <div className="bg-[var(--color-surface)] rounded border border-[var(--color-border)] p-4">
        <h3 className="text-base font-bold mb-3 text-[var(--color-muted)]">
          Hour Distribution
          <span className="font-normal text-[var(--color-muted)] ml-2">
            UTC {localOffset >= 0 ? '+' : ''}{localOffset} ({tzName})
          </span>
        </h3>
        <UPlotCategoryChart
          data={rotatedHours}
          labelKey="hour"
          series={[{ key: 'count', label: 'messages', color: '#a78bfa' }]}
          height={220}
          tick={(h, i) => (i % 2 === 0 ? `${h}:00` : '')}
          hover={(row) => formatDualHourTooltip(Number(row.hour))}
        />
      </div>
    </div>

    {/* Day of week charts row */}
    <div className="grid grid-cols-2 gap-4">
      {/* Day of week totals */}
      <div className="bg-[var(--color-surface)] rounded border border-[var(--color-border)] p-4">
        <h3 className="text-base font-bold mb-3 text-[var(--color-muted)]">
          Day of Week ({range})
        </h3>
        <UPlotCategoryChart
          data={data.dayOfWeekCounts ?? []}
          labelKey="day"
          series={[{ key: 'count', label: 'messages', color: (data.dayOfWeekCounts ?? []).map((d: any) => DAY_COLORS[d.dow]) }]}
          height={200}
        />
      </div>

      {/* Day × Hour hotspot curves */}
      <div className="bg-[var(--color-surface)] rounded border border-[var(--color-border)] p-4">
        <h3 className="text-base font-bold mb-3 text-[var(--color-muted)]">
          Hotspots by Day &times; Hour
          <span className="font-normal text-[var(--color-muted)] ml-2">
            UTC {localOffset >= 0 ? '+' : ''}{localOffset}
          </span>
        </h3>
        <UPlotCategoryChart
          kind="lines"
          data={dowHourData}
          labelKey="hour"
          series={['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].map((day, i) => ({
            key: day, label: day, color: DAY_COLORS[i], fill: `${DAY_COLORS[i]}1a`,
          }))}
          height={220}
          tick={(h, i) => (i % 2 === 0 ? `${h}:00` : '')}
          hover={(row) => formatDualHourTooltip(Number(row.hour))}
        />
      </div>
    </div>

    </>
  );
}

/** The token-share pie beside the model table. */
export function ModelUsagePie({ modelData }: { modelData: any[] }) {
  return (
    <Donut
      data={modelData.map((m: any) => ({ name: m.name, fullName: m.fullName, value: m.tokens, color: getModelColor(m.fullName) }))}
      format={formatTokens}
      height={200}
      className="w-[220px] shrink-0"
    />
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



