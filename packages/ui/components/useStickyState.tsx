'use client';

import { useCallback, useState } from 'react';

/**
 * useState that survives a refresh.
 *
 * Every page had its own answer to "remember what I was looking at".
 * TimeRangeSelect grew a localStorage-backed `useTimeRange`, so the pages
 * using it kept their slice, while any control that reached for a plain
 * `useState` silently reset — the permacomputer Fleet Metrics chart held its
 * window in `useState(24)`, so choosing 6h and refreshing snapped back to 24h.
 *
 * The value is JSON-encoded, so numbers, strings and small objects all round
 * trip. Reading happens in the initializer rather than an effect: an effect
 * would render the default first and then correct itself, which for a chart
 * means one wasted fetch over the wrong window and a visible flash.
 */
export function useStickyState<T>(storageKey: string, defaultValue: T) {
  const [value, setRaw] = useState<T>(() => {
    if (typeof globalThis.localStorage === 'undefined') return defaultValue;
    let raw: string | null = null;
    try {
      raw = localStorage.getItem(storageKey);
    } catch {
      return defaultValue;   // storage disabled entirely
    }
    if (raw === null) return defaultValue;
    try {
      return JSON.parse(raw) as T;
    } catch {
      // Keys written before this hook existed hold bare strings ('6h'), which
      // are not valid JSON. Accepting them keeps everyone's saved slice
      // through the change instead of resetting it once.
      return (raw as unknown) as T;
    }
  });

  const set = useCallback((v: T) => {
    setRaw(v);
    try {
      localStorage.setItem(storageKey, JSON.stringify(v));
    } catch {
      // Private mode or a full quota — the control still works for this visit.
    }
  }, [storageKey]);

  return [value, set] as const;
}

export default useStickyState;
