'use client';

import { useStickyState } from './useStickyState';

export const TIME_RANGE_OPTIONS = [
  { label: '1 hour', value: '1h', ms: 60 * 60 * 1000 },
  { label: '3 hours', value: '3h', ms: 3 * 60 * 60 * 1000 },
  { label: '6 hours', value: '6h', ms: 6 * 60 * 60 * 1000 },
  { label: '12 hours', value: '12h', ms: 12 * 60 * 60 * 1000 },
  { label: '24 hours', value: '24h', ms: 24 * 60 * 60 * 1000 },
  { label: '7 days', value: '7d', ms: 7 * 24 * 60 * 60 * 1000 },
  { label: '14 days', value: '14d', ms: 14 * 24 * 60 * 60 * 1000 },
  { label: '28 days', value: '28d', ms: 28 * 24 * 60 * 60 * 1000 },
  { label: 'Lifetime', value: 'all', ms: 0 },
] as const;

export type TimeRangeValue = (typeof TIME_RANGE_OPTIONS)[number]['value'];

export function getTimeRangeMinutes(value: string): number {
  if (value === 'all') return 0;
  const opt = TIME_RANGE_OPTIONS.find((o) => o.value === value);
  if (!opt || !opt.ms) return 0;
  return opt.ms / 60000;
}

export function getTimeRangeFrom(value: string): string | undefined {
  if (value === 'all') return undefined;
  const opt = TIME_RANGE_OPTIONS.find((o) => o.value === value);
  if (!opt || !opt.ms) return undefined;
  return new Date(Date.now() - opt.ms).toISOString();
}

// Kept as the named entry point for time ranges, now backed by the shared
// sticky-state primitive so every remembered control behaves identically.
// Legacy keys were written as bare strings rather than JSON, so a value that
// does not parse is still accepted if it names a known range.
export function useTimeRange(storageKey: string, defaultValue: TimeRangeValue = '7d') {
  const [value, setValue] = useStickyState<string>(storageKey, defaultValue);
  const known = TIME_RANGE_OPTIONS.some((o) => o.value === value);
  return [known ? value : defaultValue, setValue] as const;
}

export function TimeRangeSelect({
  value,
  onChange,
}: {
  value: string;
  onChange: (value: string) => void;
}) {
  return (
    <select
      value={value}
      onChange={(e) => onChange(e.target.value)}
      className="bg-[var(--color-surface)] border border-[var(--color-border)] rounded px-3 py-1.5 text-base text-[var(--color-foreground)] cursor-pointer"
    >
      {TIME_RANGE_OPTIONS.map((o) => (
        <option key={o.value} value={o.value}>
          {o.label}
        </option>
      ))}
    </select>
  );
}
