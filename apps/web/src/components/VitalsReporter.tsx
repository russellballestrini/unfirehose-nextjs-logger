'use client';

import { useEffect } from 'react';

const SESSION_KEY = 'unfh_vitals_session_v1';

function getSessionId(): string {
  try {
    let id = sessionStorage.getItem(SESSION_KEY);
    if (!id) {
      // Cheap unique id — Date.now()+random. Per-tab via sessionStorage.
      id = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
      sessionStorage.setItem(SESSION_KEY, id);
    }
    return id;
  } catch {
    // sessionStorage unavailable (SSR, locked-down browser) — fall back.
    return 'anon';
  }
}

type Metric = {
  name: string;
  value: number;
  rating: 'good' | 'needs-improvement' | 'poor';
};

/**
 * VitalsReporter — RUM client.
 * Subscribes to web-vitals callbacks for TTFB / FCP / LCP / INP / CLS and
 * POSTs each sample to /api/metrics. Fire-and-forget; never blocks render.
 */
export function VitalsReporter() {
  useEffect(() => {
    const sessionId = getSessionId();

    const report = (m: Metric) => {
      try {
        const body = JSON.stringify({
          pathname: window.location.pathname,
          metric: m.name,
          value: m.value,
          rating: m.rating,
          sessionId,
        });
        // Fire-and-forget. keepalive lets the request survive page unload
        // (important for LCP/INP/CLS that often fire near navigation).
        fetch('/api/metrics', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body,
          keepalive: true,
        }).catch(() => { /* swallow — RUM must never affect UX */ });
      } catch {
        /* swallow */
      }
    };

    import('web-vitals').then(({ onTTFB, onFCP, onLCP, onINP, onCLS }) => {
      onTTFB(report);
      onFCP(report);
      onLCP(report);
      onINP(report);
      onCLS(report);
    }).catch(() => { /* swallow — web-vitals optional */ });
  }, []);

  return null;
}

export default VitalsReporter;
