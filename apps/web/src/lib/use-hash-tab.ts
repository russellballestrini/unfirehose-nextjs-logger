'use client';

import { useState, useEffect, useLayoutEffect } from 'react';

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
 * The first render uses the fallback, because the server did: these pages
 * are server-rendered client components, and a first render that read the
 * hash would disagree with the HTML the server sent. React then throws the
 * whole tree away and rebuilds it — "Hydration failed", a flash, and the
 * work of rendering twice. Four hand-rolled copies of this hook all did
 * exactly that, and so did this one until a deep link to #rules said so. The
 * hash is adopted in a layout effect instead: after hydration, before paint,
 * so a deep link still shows its tab without a visible flash of the default.
 */
export function useHashTab<T extends string>(
  tabs: readonly T[],
  fallback: T,
): [T, (tab: T) => void] {
  const [tab, setTab] = useState<T>(fallback);

  // Adopt a deep link after hydration and before paint.
  useLayoutEffect(() => {
    const fromHash = readHash(tabs);
    if (fromHash) setTab(fromHash);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

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
