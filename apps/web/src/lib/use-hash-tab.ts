'use client';

import { useState, useEffect } from 'react';

/**
 * Tab selection kept in our URL hash, so a tab can be linked and survives a
 * reload.
 *
 * Four pages hand-rolled this and three of them had drifted. Two wrote the
 * hash with `location.hash =`, which pushes a history entry — click through
 * five tabs on settings and leaving the page took five presses of Back.
 * Tokens used `replaceState` and did not. This hook settles on replaceState:
 * a tab is a view of one page, not a place you navigated to.
 *
 * The initial value is read synchronously in the useState initialiser rather
 * than in an effect, so a deep link renders its tab on the first paint
 * instead of flashing the default.
 */
export function useHashTab<T extends string>(
  tabs: readonly T[],
  fallback: T,
): [T, (tab: T) => void] {
  const [tab, setTab] = useState<T>(() => readHash(tabs) ?? fallback);

  // Back and forward move the hash without re-mounting us.
  useEffect(() => {
    const onHashChange = () => setTab(readHash(tabs) ?? fallback);
    window.addEventListener('hashchange', onHashChange);
    return () => window.removeEventListener('hashchange', onHashChange);
    // tabs is a module-level literal at every call site; fallback is a string.
  }, [fallback, tabs]);

  return [tab, (next: T) => {
    setTab(next);
    if (typeof window !== 'undefined') {
      window.history.replaceState(null, '', `#${next}`);
    }
  }];
}

/** The hash, if it names one of our tabs. Anything else is somebody else's anchor. */
export function readHash<T extends string>(tabs: readonly T[]): T | null {
  if (typeof window === 'undefined' || !window.location) return null;
  const hash = decodeURIComponent(window.location.hash.slice(1)) as T;
  return tabs.includes(hash) ? hash : null;
}
