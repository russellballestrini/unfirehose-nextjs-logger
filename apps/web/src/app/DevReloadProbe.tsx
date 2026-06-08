'use client';

import { useEffect, useState } from 'react';

const REC_KEY = 'unfh_reload_probe_v1';

type ProbeRec = {
  at: number;
  url: string;
  cause: string;
  detail?: string;
  lastError?: string;
};

export function DevReloadProbe() {
  const [banner, setBanner] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (typeof window === 'undefined') return;

    const navEntry = performance.getEntriesByType('navigation')[0] as
      | PerformanceNavigationTiming
      | undefined;
    const navType = navEntry?.type ?? 'unknown';

    const priorRaw = sessionStorage.getItem(REC_KEY);
    sessionStorage.removeItem(REC_KEY);
    let summary = `nav.type=${navType}`;
    if (priorRaw) {
      try {
        const r = JSON.parse(priorRaw) as ProbeRec;
        const agoSec = ((Date.now() - r.at) / 1000).toFixed(1);
        summary += ` | ${agoSec}s ago: ${r.cause}`;
        if (r.detail) summary += ` "${r.detail.slice(0, 300)}"`;
        if (r.lastError) summary += ` | err: ${r.lastError.slice(0, 140)}`;
        if (r.url) summary += ` | from ${r.url}`;
      } catch {}
    }
    console.warn('[DevReloadProbe]', summary);
    if (navType === 'reload' || priorRaw) setBanner(summary);

    let lastErr: string | undefined;
    const recordCause = (cause: string, detail?: string) => {
      try {
        sessionStorage.setItem(
          REC_KEY,
          JSON.stringify({
            at: Date.now(),
            url: location.pathname + location.search,
            cause,
            detail,
            lastError: lastErr,
          } satisfies ProbeRec),
        );
      } catch {}
    };

    const onErr = (e: ErrorEvent) => {
      lastErr = `${e.message} @ ${e.filename}:${e.lineno}:${e.colno}`;
    };
    const onRej = (e: PromiseRejectionEvent) => {
      lastErr = `unhandled: ${String(e.reason).slice(0, 240)}`;
    };
    const onPagehide = () => recordCause('pagehide');
    const onBeforeUnload = () => recordCause('beforeunload');

    window.addEventListener('error', onErr);
    window.addEventListener('unhandledrejection', onRej);
    window.addEventListener('pagehide', onPagehide);
    window.addEventListener('beforeunload', onBeforeUnload);

    // ---- Location method interception (best-effort; Firefox blocks this) ----
    const undoers: Array<() => void> = [];

    const tryWrapMethod = (
      obj: object,
      key: 'reload' | 'assign' | 'replace',
      label: string,
    ) => {
      try {
        const orig = (obj as unknown as Record<string, unknown>)[key];
        if (typeof orig !== 'function') return false;
        const wrapped = function (this: unknown, ...args: unknown[]) {
          const stack = (new Error().stack || '')
            .split('\n')
            .slice(1, 5)
            .join(' | ');
          recordCause(label, `args=${JSON.stringify(args)} stack=${stack}`);
          return (orig as (...a: unknown[]) => unknown).apply(this, args);
        };
        Object.defineProperty(obj, key, {
          value: wrapped,
          writable: true,
          configurable: true,
        });
        undoers.push(() => {
          try {
            Object.defineProperty(obj, key, {
              value: orig,
              writable: true,
              configurable: true,
            });
          } catch {}
        });
        return true;
      } catch {
        return false;
      }
    };

    // Try prototype first, fall back to instance.
    let wrappedReload = tryWrapMethod(Location.prototype, 'reload', 'reload()');
    if (!wrappedReload) wrappedReload = tryWrapMethod(location, 'reload', 'reload()');
    let wrappedAssign = tryWrapMethod(Location.prototype, 'assign', 'assign()');
    if (!wrappedAssign) wrappedAssign = tryWrapMethod(location, 'assign', 'assign()');
    let wrappedReplace = tryWrapMethod(Location.prototype, 'replace', 'replace()');
    if (!wrappedReplace) wrappedReplace = tryWrapMethod(location, 'replace', 'replace()');

    try {
      const hrefDesc =
        Object.getOwnPropertyDescriptor(Location.prototype, 'href') ||
        Object.getOwnPropertyDescriptor(location, 'href');
      if (hrefDesc?.set && hrefDesc.get) {
        const origGet = hrefDesc.get;
        const origSet = hrefDesc.set;
        Object.defineProperty(Location.prototype, 'href', {
          configurable: true,
          get: origGet,
          set(v: string) {
            recordCause('href=', String(v));
            return origSet.call(this, v);
          },
        });
        undoers.push(() => {
          try {
            Object.defineProperty(Location.prototype, 'href', hrefDesc);
          } catch {}
        });
      }
    } catch {}

    // ---- WebSocket interception — catch HMR socket disconnect ----
    // The dev server's HMR client uses WebSocket. If the socket closes / errors
    // and the client reconnects with a mismatched build ID, it'll silently
    // window.location.reload(). Catching the close event tells us why.
    try {
      const OrigWS = window.WebSocket;
      const isDevSocket = (url: string | URL) => {
        const s = String(url);
        return s.includes('/_next/') || s.includes('webpack-hmr') || s.includes('turbopack-hmr');
      };
      const Wrapped = function (this: unknown, url: string | URL, protocols?: string | string[]) {
        const ws = new OrigWS(url, protocols);
        if (isDevSocket(url)) {
          ws.addEventListener('close', (e: CloseEvent) => {
            recordCause('hmr-ws-close', `code=${e.code} reason="${e.reason}" clean=${e.wasClean} url=${url}`);
            console.warn('[DevReloadProbe] HMR socket closed', e.code, e.reason, e.wasClean);
          });
          ws.addEventListener('error', () => {
            recordCause('hmr-ws-error', `url=${url}`);
            console.warn('[DevReloadProbe] HMR socket error', url);
          });
        }
        return ws;
      } as unknown as typeof WebSocket;
      Wrapped.prototype = OrigWS.prototype;
      (Wrapped as unknown as { CONNECTING: number; OPEN: number; CLOSING: number; CLOSED: number }).CONNECTING = OrigWS.CONNECTING;
      (Wrapped as unknown as { CONNECTING: number; OPEN: number; CLOSING: number; CLOSED: number }).OPEN = OrigWS.OPEN;
      (Wrapped as unknown as { CONNECTING: number; OPEN: number; CLOSING: number; CLOSED: number }).CLOSING = OrigWS.CLOSING;
      (Wrapped as unknown as { CONNECTING: number; OPEN: number; CLOSING: number; CLOSED: number }).CLOSED = OrigWS.CLOSED;
      window.WebSocket = Wrapped;
      undoers.push(() => {
        window.WebSocket = OrigWS;
      });
    } catch {}

    return () => {
      window.removeEventListener('error', onErr);
      window.removeEventListener('unhandledrejection', onRej);
      window.removeEventListener('pagehide', onPagehide);
      window.removeEventListener('beforeunload', onBeforeUnload);
      for (const undo of undoers) {
        try {
          undo();
        } catch {}
      }
    };
  }, []);

  if (!banner) return null;
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(banner);
      setCopied(true);
      setTimeout(() => setCopied(false), 1200);
    } catch {}
  };
  const btnStyle = {
    background: 'rgba(255,255,255,0.15)',
    color: 'white',
    border: '1px solid rgba(255,255,255,0.3)',
    borderRadius: 4,
    padding: '2px 8px',
    fontSize: 10,
    fontFamily: 'inherit',
    cursor: 'pointer',
    lineHeight: 1.2,
  } as const;
  return (
    <div
      style={{
        position: 'fixed',
        bottom: 8,
        right: 8,
        zIndex: 99999,
        background: 'rgba(212,0,0,0.95)',
        color: 'white',
        padding: '8px 10px',
        borderRadius: 6,
        fontSize: 11,
        fontFamily: 'monospace',
        maxWidth: 640,
        boxShadow: '0 4px 16px rgba(0,0,0,0.5)',
        display: 'flex',
        flexDirection: 'column',
        gap: 6,
      }}
    >
      <div
        style={{
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
          gap: 8,
        }}
      >
        <button onClick={copy} title="copy to clipboard" style={btnStyle}>
          {copied ? 'copied' : 'copy'}
        </button>
        <button
          onClick={() => setBanner(null)}
          title="dismiss"
          style={{ ...btnStyle, fontWeight: 'bold' }}
        >
          ×
        </button>
      </div>
      <div
        style={{
          whiteSpace: 'pre-wrap',
          wordBreak: 'break-all',
          userSelect: 'text',
        }}
      >
        {banner}
      </div>
    </div>
  );
}
