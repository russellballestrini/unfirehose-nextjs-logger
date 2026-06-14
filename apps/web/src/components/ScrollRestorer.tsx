'use client';

/**
 * Save the scroll position of <main> on pagehide and restore it on the
 * next mount of the SAME url. Survives hard reloads (Next dev HMR full
 * refreshes, F5, devtools nav-type=reload). Client-side Next navigation
 * doesn't trigger pagehide so this component is a no-op for in-app
 * navigation, which is exactly what we want — Next does its own scroll
 * handling for those.
 */

import { useEffect } from 'react';

const SCROLL_KEY = 'unfh_scroll_restore_v1';
const TTL_MS = 5 * 60 * 1000; // 5 min — stale-enough positions are discarded

interface SavedScroll {
  url: string;
  scrollTop: number;
  at: number;
}

export function ScrollRestorer() {
  useEffect(() => {
    if (typeof window === 'undefined') return;
    const main = document.querySelector('main');

    // Restore: if there's a saved position for this exact url and it isn't
    // stale, apply it once layout has settled. Two RAFs are enough for the
    // child content (SWR-driven mostly) to mount; SWR's first revalidation
    // will then maintain the position from there.
    try {
      const raw = sessionStorage.getItem(SCROLL_KEY);
      if (raw) {
        const data = JSON.parse(raw) as SavedScroll;
        const hereUrl = window.location.pathname + window.location.search + window.location.hash;
        if (data.url === hereUrl && Date.now() - data.at < TTL_MS && main) {
          requestAnimationFrame(() => {
            requestAnimationFrame(() => {
              main.scrollTop = data.scrollTop;
            });
          });
        }
        // Clear regardless — single-shot, no resurrection on subsequent navs.
        sessionStorage.removeItem(SCROLL_KEY);
      }
    } catch { /* ignore */ }

    const save = () => {
      if (!main) return;
      try {
        const data: SavedScroll = {
          url: window.location.pathname + window.location.search + window.location.hash,
          scrollTop: main.scrollTop,
          at: Date.now(),
        };
        sessionStorage.setItem(SCROLL_KEY, JSON.stringify(data));
      } catch { /* ignore */ }
    };

    window.addEventListener('pagehide', save);
    return () => window.removeEventListener('pagehide', save);
  }, []);

  return null;
}
