'use client';

import { useState, useEffect, useRef, useCallback } from 'react';
import { useParams, useSearchParams } from 'next/navigation';
import Link from 'next/link';
import useSWR from 'swr';
import '@xterm/xterm/css/xterm.css';

const fetcher = (url: string) => fetch(url).then(r => r.json());

// ── ANSI renderer (for tmux capture-pane snapshots) ─────────────────────────
const FG_MAP: Record<string, string> = {
  '30': '#1e1e1e', '31': '#ef4444', '32': '#22c55e', '33': '#eab308',
  '34': '#60a5fa', '35': '#c084fc', '36': '#22d3ee', '37': '#d4d4d4',
  '90': '#737373', '91': '#f87171', '92': '#4ade80', '93': '#facc15',
  '94': '#93c5fd', '95': '#d8b4fe', '96': '#67e8f9', '97': '#ffffff',
};
const BG_MAP: Record<string, string> = {
  '40': '#1e1e1e', '41': '#991b1b', '42': '#166534', '43': '#854d0e',
  '44': '#1e3a5f', '45': '#581c87', '46': '#164e63', '47': '#404040',
};
const ANSI_RE = /(\x1b\[[0-9;]*m)/;
const ESC_RE = /^\x1b\[([0-9;]*)m$/;
const styleCache = new Map<string, string>();
function getStyleTag(fg: string, bg: string, bold: boolean, dim: boolean): string {
  const key = `${fg}|${bg}|${bold ? 1 : 0}|${dim ? 1 : 0}`;
  let cached = styleCache.get(key);
  if (!cached) {
    const s: string[] = [];
    if (fg) s.push(`color:${fg}`);
    if (bg) s.push(`background:${bg}`);
    if (bold) s.push('font-weight:bold');
    if (dim) s.push('opacity:0.6');
    cached = s.length ? `<span style="${s.join(';')}">` : '';
    styleCache.set(key, cached);
  }
  return cached;
}
function ansiToHtml(text: string): string {
  const chunks: string[] = [];
  let fg = '', bg = '', bold = false, dim = false;
  for (const part of text.split(ANSI_RE)) {
    if (!part) continue;
    const match = ESC_RE.exec(part);
    if (match) {
      for (const code of match[1].split(';')) {
        if (!code || code === '0') { fg = ''; bg = ''; bold = false; dim = false; }
        else if (code === '1') bold = true;
        else if (code === '2') dim = true;
        else if (code === '22') { bold = false; dim = false; }
        else if (FG_MAP[code]) fg = FG_MAP[code];
        else if (BG_MAP[code]) bg = BG_MAP[code];
        else if (code === '39') fg = '';
        else if (code === '49') bg = '';
      }
    } else {
      const escaped = part.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
      const open = getStyleTag(fg, bg, bold, dim);
      if (open) chunks.push(open, escaped, '</span>');
      else chunks.push(escaped);
    }
  }
  return chunks.join('');
}

// ── Drop overlay animations ──────────────────────────────────────────────────
const DROP_STYLES = `
  @keyframes scanlines { 0% { background-position: 0 0; } 100% { background-position: 0 4px; } }
  @keyframes uf-pulse-red { 0%,100% { opacity: 1; } 50% { opacity: 0.4; } }
  @keyframes uf-flicker { 0%,100%{opacity:1;} 92%{opacity:1;} 93%{opacity:0.6;} 94%{opacity:1;} 97%{opacity:0.8;} 98%{opacity:1;} }
  @keyframes uf-glow-orange { 0%,100%{box-shadow:0 0 12px #f97316,0 0 30px #f9731633;} 50%{box-shadow:0 0 24px #f97316,0 0 60px #f9731666;} }
  @keyframes uf-done-flash { 0%{background:rgba(249,115,22,0.25);} 100%{background:rgba(249,115,22,0);} }
  .xterm-screen { height: 100% !important; }
  .xterm { height: 100% !important; padding: 8px; }
  .xterm-viewport { overflow-y: auto !important; }
`;

// ── XtermPane — full terminal emulator for unsandbox sessions ────────────────
function XtermPane({
  sessionId,
  interactive,
  sendKeysRef,
  onConnect,
}: {
  sessionId: string;
  interactive: boolean;
  sendKeysRef: React.MutableRefObject<((keys: string) => void) | null>;
  onConnect: (connected: boolean) => void;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const interactiveRef = useRef(interactive);
  interactiveRef.current = interactive;

  useEffect(() => {
    if (!containerRef.current) return;
    let disposed = false;
    let es: EventSource | null = null;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let term: any = null;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let fitAddon: any = null;

    (async () => {
      const { Terminal } = await import('@xterm/xterm');
      const { FitAddon } = await import('@xterm/addon-fit');
      if (disposed || !containerRef.current) return;

      term = new Terminal({
        theme: {
          background: '#0d0d0d',
          foreground: '#d4d4d4',
          cursor: '#d4d4d4',
          selectionBackground: '#3b4048',
          black: '#1e1e1e', red: '#ef4444', green: '#22c55e', yellow: '#eab308',
          blue: '#60a5fa', magenta: '#c084fc', cyan: '#22d3ee', white: '#d4d4d4',
          brightBlack: '#737373', brightRed: '#f87171', brightGreen: '#4ade80',
          brightYellow: '#facc15', brightBlue: '#93c5fd', brightMagenta: '#d8b4fe',
          brightCyan: '#67e8f9', brightWhite: '#ffffff',
        },
        fontFamily: '"JetBrains Mono", "Fira Code", "Cascadia Code", monospace',
        fontSize: 14,
        lineHeight: 1.3,
        cursorBlink: true,
        convertEol: false,
        allowProposedApi: true,
      });

      fitAddon = new FitAddon();
      term.loadAddon(fitAddon);
      term.open(containerRef.current);
      term.focus();

      // Small delay so container has its final size before fitting
      await new Promise(r => setTimeout(r, 50));
      if (disposed) return;
      fitAddon.fit();

      // When Ctrl+C is pressed with a text selection, xterm v5 copies to clipboard
      // and does NOT fire onData. Override: always send \x03 regardless of selection.
      term.attachCustomKeyEventHandler((e: KeyboardEvent) => {
        if (e.type !== 'keydown' || !interactiveRef.current) return true;
        if (e.ctrlKey && !e.shiftKey && !e.altKey && !e.metaKey) {
          const CTRL_SEQS: Record<string, string> = {
            c: '\x03', d: '\x04', z: '\x1a', a: '\x01', e: '\x05',
            k: '\x0b', l: '\x0c', r: '\x12', u: '\x15', w: '\x17',
          };
          const seq = CTRL_SEQS[e.key.toLowerCase()];
          if (seq) {
            // Send directly, bypassing xterm's copy-on-ctrl-c behavior
            fetch('/api/unsandbox/shell', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ session_id: sessionId, keys: seq }),
            }).catch(() => {});
            return false; // prevent xterm from also processing (avoids double-send)
          }
        }
        return true;
      });

      // Send resize when terminal re-fits
      term.onResize(({ cols, rows }: { cols: number; rows: number }) => {
        if (disposed) return;
        fetch('/api/unsandbox/shell', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ session_id: sessionId, action: 'resize', cols, rows }),
        }).catch(() => {});
      });

      // Send keyboard input — xterm handles all key-to-ANSI conversion
      term.onData((data: string) => {
        if (!interactiveRef.current || disposed) return;
        fetch('/api/unsandbox/shell', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ session_id: sessionId, keys: data }),
        }).catch(() => {});
      });

      // Expose sendKeys for file-drop injection
      sendKeysRef.current = (keys: string) => {
        if (disposed) return;
        fetch('/api/unsandbox/shell', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ session_id: sessionId, keys }),
        }).catch(() => {});
      };

      // ResizeObserver → re-fit xterm
      const ro = new ResizeObserver(() => {
        if (!disposed && fitAddon) {
          try { fitAddon.fit(); } catch { /* ignore */ }
        }
      });
      ro.observe(containerRef.current);

      // SSE stream
      const connect = () => {
        if (disposed) return;
        es = new EventSource(`/api/unsandbox/shell?session_id=${encodeURIComponent(sessionId)}`);

        es.onmessage = (e) => {
          if (disposed) return;
          try {
            const msg = JSON.parse(e.data);
            if (msg.type === 'output') {
              onConnect(true);
              const bytes = Uint8Array.from(atob(msg.data), c => c.charCodeAt(0));
              term.write(bytes);
            } else if (msg.type === 'error') {
              term.write(`\r\n\x1b[31m[error: ${msg.data}]\x1b[0m\r\n`);
            } else if (msg.type === 'close') {
              onConnect(false);
              term.write('\r\n\x1b[33m[session closed]\x1b[0m\r\n');
              // Reconnect after 2s
              es?.close();
              setTimeout(connect, 2000);
            }
          } catch { /* skip */ }
        };

        es.onerror = () => {
          if (disposed) return;
          onConnect(false);
          es?.close();
          setTimeout(connect, 1000);
        };
      };

      connect();
      onConnect(true); // optimistic

      // Cleanup
      return () => {
        ro.disconnect();
      };
    })();

    return () => {
      disposed = true;
      es?.close();
      if (term) { try { term.dispose(); } catch { /* ignore */ } }
      sendKeysRef.current = null;
      onConnect(false);
    };
  }, [sessionId, sendKeysRef, onConnect]);

  return <div ref={containerRef} className="h-full w-full" />;
}

// ── Main viewer ──────────────────────────────────────────────────────────────
export default function TmuxViewerPage() {
  const params = useParams();
  const searchParams = useSearchParams();
  const session = params.session as string;
  const host = searchParams.get('host') ?? undefined;
  const isUnsandbox = host === 'unsandbox';

  // Nickname for this session
  const { data: nicknamesData } = useSWR('/api/sessions/nickname', fetcher, { refreshInterval: 30000 });
  const nicknames: Record<string, { nickname: string; service_name: string }> = nicknamesData ?? {};
  const sessionId = decodeURIComponent(session);
  const nick = nicknames[sessionId];
  const hostParam = host && !isUnsandbox ? `&host=${encodeURIComponent(host)}` : '';
  const [connected, setConnected] = useState(false);
  const connectedRef = useRef(false);
  const [activeWindow, setActiveWindow] = useState<string | undefined>(undefined);
  const termRef = useRef<HTMLPreElement>(null);
  const autoScrollRef = useRef(true);
  const pendingContentRef = useRef<string | null>(null);
  const lastRenderedRef = useRef('');
  const rafIdRef = useRef<number>(0);

  // Unsandbox: ref to xterm sendKeys function (for file drop)
  const unsandboxSendRef = useRef<((keys: string) => void) | null>(null);
  const pathFixSentRef = useRef(false);
  const handleUnsandboxConnect = useCallback((c: boolean) => {
    connectedRef.current = c;
    setConnected(c);
    // On first connect, auto-attach to the 'claude' tmux session if it exists
    if (c && !pathFixSentRef.current) {
      pathFixSentRef.current = true;
      setTimeout(() => {
        fetch('/api/unsandbox/shell', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ session_id: sessionId, keys: 'tmux attach -t claude 2>/dev/null || true\r' }),
        }).catch(() => {});
      }, 500);
    }
  }, [sessionId]);

  // Paint content to terminal — tmux mode
  const paintContent = useCallback((raw: string) => {
    if (raw === lastRenderedRef.current) return;
    lastRenderedRef.current = raw;
    if (termRef.current) {
      termRef.current.innerHTML = ansiToHtml(raw);
      if (autoScrollRef.current) termRef.current.scrollTop = termRef.current.scrollHeight;
    }
  }, []);

  const { data: windowsData } = useSWR(
    isUnsandbox ? null : `/api/tmux/stream?session=${encodeURIComponent(session)}&windows=1${hostParam}`,
    fetcher,
    { refreshInterval: 5000 }
  );
  const windows: { index: string; name: string; active: boolean }[] = windowsData?.windows ?? [];

  // SSE connection — tmux mode only
  const connectSSERef = useRef<() => EventSource>(null);
  connectSSERef.current = useCallback(() => {
    const url = `/api/tmux/stream?session=${encodeURIComponent(session)}${activeWindow ? `&window=${activeWindow}` : ''}${hostParam}`;
    const es = new EventSource(url);
    es.onmessage = (e) => {
      try {
        const data = JSON.parse(e.data);
        if (!connectedRef.current) { connectedRef.current = true; setConnected(true); }
        pendingContentRef.current = data;
        if (!rafIdRef.current) {
          rafIdRef.current = requestAnimationFrame(() => {
            rafIdRef.current = 0;
            const raw = pendingContentRef.current;
            if (raw !== null) paintContent(raw);
          });
        }
      } catch { /* skip */ }
    };
    es.onerror = () => {
      connectedRef.current = false;
      setConnected(false);
      es.close();
      setTimeout(() => connectSSERef.current?.(), 500);
    };
    return es;
  }, [session, activeWindow, hostParam, paintContent]);

  useEffect(() => {
    if (isUnsandbox) return; // xterm handles its own connection
    if (termRef.current && !termRef.current.textContent) {
      termRef.current.textContent = 'Connecting...';
    }
    const es = connectSSERef.current!();
    return () => {
      es.close();
      if (rafIdRef.current) { cancelAnimationFrame(rafIdRef.current); rafIdRef.current = 0; }
    };
  }, [session, activeWindow, hostParam, isUnsandbox]);

  // Interactive mode
  const [interactive, setInteractive] = useState(true);
  const queueRef = useRef<Array<{ keys?: string; special?: string }>>([]);
  const flushingRef = useRef(false);
  const flushTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const flushQueue = useCallback(async () => {
    if (flushingRef.current || queueRef.current.length === 0) return;
    flushingRef.current = true;
    while (queueRef.current.length > 0) {
      let batch = '';
      const pending: typeof queueRef.current = [];
      for (const item of queueRef.current) {
        if (item.keys) { batch += item.keys; }
        else { if (batch) break; pending.push(item); break; }
        pending.push(item);
      }
      queueRef.current.splice(0, pending.length);
      const payload = batch ? { keys: batch } : pending[0];
      try {
        const res = await fetch('/api/tmux/stream', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ session: decodeURIComponent(session), window: activeWindow, host, ...payload }),
        });
        const result = await res.json();
        if (result.content) paintContent(result.content);
      } catch { /* best effort */ }
    }
    flushingRef.current = false;
  }, [session, activeWindow, host, paintContent]);

  const enqueueKeys = useCallback((payload: { keys?: string; special?: string }) => {
    queueRef.current.push(payload);
    if (payload.special) {
      if (flushTimerRef.current) { clearTimeout(flushTimerRef.current); flushTimerRef.current = null; }
      flushQueue();
    } else {
      if (!flushTimerRef.current) {
        flushTimerRef.current = setTimeout(() => { flushTimerRef.current = null; flushQueue(); }, 16);
      }
    }
  }, [flushQueue]);

  // Keyboard handler — tmux mode only (unsandbox uses xterm.onData)
  useEffect(() => {
    if (!interactive || isUnsandbox) return;
    const SPECIAL_MAP: Record<string, string> = {
      Enter: 'Enter', Escape: 'Escape', Tab: 'Tab', Backspace: 'BSpace',
      Delete: 'DC', ArrowUp: 'Up', ArrowDown: 'Down', ArrowLeft: 'Left',
      ArrowRight: 'Right', Home: 'Home', End: 'End', PageUp: 'PageUp', PageDown: 'PageDown',
    };
    const CTRL_MAP: Record<string, string> = {
      c: 'C-c', d: 'C-d', z: 'C-z', l: 'C-l', a: 'C-a', e: 'C-e',
      k: 'C-k', u: 'C-u', w: 'C-w', r: 'C-r', p: 'C-p', n: 'C-n', b: 'C-b', f: 'C-f',
    };
    const handler = (e: KeyboardEvent) => {
      if ((e.target as HTMLElement)?.closest('input, textarea, select')) return;
      if (e.ctrlKey && CTRL_MAP[e.key]) { e.preventDefault(); enqueueKeys({ special: CTRL_MAP[e.key] }); }
      else if (SPECIAL_MAP[e.key]) { e.preventDefault(); enqueueKeys({ special: SPECIAL_MAP[e.key] }); }
      else if (e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey) { e.preventDefault(); enqueueKeys({ keys: e.key }); }
    };
    const pasteHandler = (e: ClipboardEvent) => {
      if ((e.target as HTMLElement)?.closest('input, textarea, select')) return;
      const text = e.clipboardData?.getData('text');
      if (text) { e.preventDefault(); enqueueKeys({ keys: text }); }
    };
    window.addEventListener('keydown', handler);
    window.addEventListener('paste', pasteHandler);
    return () => {
      window.removeEventListener('keydown', handler);
      window.removeEventListener('paste', pasteHandler);
    };
  }, [interactive, isUnsandbox, enqueueKeys]);

  // Resize — tmux mode only (xterm FitAddon handles unsandbox resize)
  useEffect(() => {
    if (isUnsandbox || !termRef.current) return;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const sendResize = () => {
      if (!termRef.current) return;
      const rect = termRef.current.getBoundingClientRect();
      const span = document.createElement('span');
      span.style.cssText = 'position:absolute;visibility:hidden;font:inherit;white-space:pre';
      span.textContent = 'X'.repeat(10);
      termRef.current.appendChild(span);
      const charW = span.getBoundingClientRect().width / 10;
      const charH = parseFloat(getComputedStyle(termRef.current).lineHeight) || 20;
      termRef.current.removeChild(span);
      const padding = 32;
      const cols = Math.max(80, Math.floor((rect.width - padding) / charW));
      const rows = Math.max(24, Math.floor((rect.height - padding) / charH));
      fetch('/api/tmux/stream', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ session: decodeURIComponent(session), window: activeWindow, host, action: 'resize', cols, rows }),
      }).catch(() => {});
    };
    const observer = new ResizeObserver(() => { if (timer) clearTimeout(timer); timer = setTimeout(sendResize, 150); });
    observer.observe(termRef.current);
    sendResize();
    return () => { observer.disconnect(); if (timer) clearTimeout(timer); };
  }, [session, activeWindow, host, isUnsandbox]);

  const handleScroll = () => {
    if (!termRef.current) return;
    const { scrollTop, scrollHeight, clientHeight } = termRef.current;
    autoScrollRef.current = scrollHeight - scrollTop - clientHeight < 50;
  };

  // ── File drop ──────────────────────────────────────────────────────────────
  type DropState = 'idle' | 'hover' | 'uploading' | 'done' | 'error';
  const [dropState, setDropState] = useState<DropState>('idle');
  const [uploadProgress, setUploadProgress] = useState(0);
  const [dropFile, setDropFile] = useState<{ name: string; path: string } | null>(null);
  const [dropError, setDropError] = useState('');
  const dragCounterRef = useRef(0);

  const uploadFile = async (file: File) => {
    setDropFile({ name: file.name, path: '' });
    setDropState('uploading');
    setUploadProgress(0);
    let prog = 0;
    const tick = setInterval(() => {
      prog = prog < 70 ? prog + 4 : prog < 88 ? prog + 0.4 : prog;
      setUploadProgress(Math.min(prog, 88));
    }, 40);
    try {
      const fd = new FormData();
      fd.append('file', file);
      fd.append('session', decodeURIComponent(session));
      if (host) fd.append('host', host); // 'unsandbox' triggers container injection
      const res = await fetch('/api/tmux/upload', { method: 'POST', body: fd });
      clearInterval(tick);
      if (!res.ok) {
        const e = await res.json().catch(() => ({ error: 'upload failed' }));
        throw new Error(e.error ?? 'upload failed');
      }
      const { path } = await res.json();
      setUploadProgress(100);
      setDropFile({ name: file.name, path });
      setDropState('done');
      // Type the path into terminal
      if (isUnsandbox) {
        unsandboxSendRef.current?.(path);
      } else {
        await fetch('/api/tmux/stream', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ session: decodeURIComponent(session), window: activeWindow, host, keys: path }),
        });
      }
      setTimeout(() => { setDropState('idle'); setDropFile(null); }, 1800);
    } catch (err) {
      clearInterval(tick);
      setDropError(String(err));
      setDropState('error');
      setTimeout(() => { setDropState('idle'); setDropError(''); }, 3000);
    }
  };

  const onDragEnter = (e: React.DragEvent) => { e.preventDefault(); dragCounterRef.current++; if (dropState === 'idle') setDropState('hover'); };
  const onDragLeave = (e: React.DragEvent) => { e.preventDefault(); dragCounterRef.current--; if (dragCounterRef.current <= 0) { dragCounterRef.current = 0; setDropState('idle'); } };
  const onDragOver = (e: React.DragEvent) => { e.preventDefault(); };
  const onDrop = (e: React.DragEvent) => { e.preventDefault(); dragCounterRef.current = 0; const file = e.dataTransfer.files[0]; if (file) uploadFile(file); };

  return (
    <>
      <style>{DROP_STYLES}</style>
      <div className="flex flex-col h-[calc(100vh-2rem)]">
        {/* Header */}
        <div className="flex items-center gap-3 mb-3">
          <Link href="/tmux" className="text-[var(--color-muted)] hover:text-[var(--color-foreground)] text-sm">
            &larr; Back
          </Link>
          <div className="flex flex-col min-w-0">
            {nick?.nickname && (
              <span className="text-base font-bold leading-tight truncate">{nick.nickname}</span>
            )}
            <div className="flex items-center gap-2">
              <h2 className={`font-mono truncate ${nick?.nickname ? 'text-xs text-[var(--color-muted)]' : 'text-lg font-bold'}`}>{sessionId}</h2>
              {isUnsandbox
                ? <span className="text-xs text-violet-400 font-mono flex-shrink-0">@unsandbox</span>
                : host && <span className="text-xs text-[var(--color-muted)] font-mono flex-shrink-0">@{host}</span>
              }
            </div>
            {nick?.service_name && (
              <span className="text-[10px] text-violet-400/70 font-mono">⬡ {nick.service_name}</span>
            )}
          </div>
          <span className={`w-2 h-2 rounded-full flex-shrink-0 ${connected ? 'bg-green-400 animate-pulse' : 'bg-red-400'}`} />
          <span className="text-xs text-[var(--color-muted)]">{connected ? 'live' : 'reconnecting...'}</span>
          <div className="ml-auto flex items-center gap-2">
            {/* Paste button — reliable cross-browser clipboard read */}
            <button
              onClick={async () => {
                try {
                  const text = await navigator.clipboard.readText();
                  if (!text) return;
                  if (isUnsandbox) {
                    // send directly to unsandbox shell
                    fetch('/api/unsandbox/shell', {
                      method: 'POST',
                      headers: { 'Content-Type': 'application/json' },
                      body: JSON.stringify({ session_id: decodeURIComponent(session), keys: text }),
                    }).catch(() => {});
                  } else {
                    enqueueKeys({ keys: text });
                  }
                } catch { /* clipboard permission denied */ }
              }}
              className="px-3 py-1 text-xs rounded font-bold cursor-pointer transition-colors bg-[var(--color-surface)] text-[var(--color-muted)] hover:text-[var(--color-foreground)] border border-[var(--color-border)]"
              title="Paste clipboard into terminal"
            >
              ⎘ Paste
            </button>
            {!isUnsandbox && (
              <button
                onClick={() => setInteractive(!interactive)}
                className={`px-3 py-1 text-xs rounded font-bold cursor-pointer transition-colors ${
                  interactive
                    ? 'bg-green-500 text-black'
                    : 'bg-[var(--color-surface)] text-[var(--color-muted)] hover:text-[var(--color-foreground)] border border-[var(--color-border)]'
                }`}
              >
                {interactive ? '⌨ Interactive' : '⌨ Read-only'}
              </button>
            )}
          </div>
        </div>

        {/* Window tabs (tmux only) */}
        {!isUnsandbox && windows.length > 1 && (
          <div className="flex items-center gap-1 mb-2">
            {windows.map(w => (
              <button
                key={w.index}
                onClick={() => { setActiveWindow(w.index); termRef.current?.focus(); }}
                className={`px-3 py-1 text-xs rounded font-mono cursor-pointer transition-colors ${
                  (activeWindow ?? (windows.find(x => x.active)?.index)) === w.index
                    ? 'bg-[var(--color-accent)] text-[var(--color-background)] font-bold'
                    : 'bg-[var(--color-surface)] text-[var(--color-muted)] hover:text-[var(--color-foreground)]'
                }`}
              >
                {w.index}:{w.name} {w.active ? '●' : ''}
              </button>
            ))}
          </div>
        )}

        {/* Terminal + drop overlay */}
        <div
          className="relative flex-1 min-h-0"
          onDragEnter={onDragEnter}
          onDragLeave={onDragLeave}
          onDragOver={onDragOver}
          onDrop={onDrop}
        >
          {isUnsandbox ? (
            <div
              className={`h-full rounded-lg border overflow-hidden transition-all duration-300 ${
                dropState === 'hover' ? 'border-violet-500 shadow-[0_0_20px_rgba(139,92,246,0.6)]'
                : dropState === 'uploading' || dropState === 'error' ? 'border-red-500 shadow-[0_0_20px_rgba(239,68,68,0.4)]'
                : dropState === 'done' ? 'border-orange-400'
                : 'border-violet-900/40'
              }`}
              style={dropState === 'done' ? { animation: 'uf-glow-orange 0.6s ease-in-out 3' } : undefined}
            >
              <XtermPane
                sessionId={decodeURIComponent(session)}
                interactive={interactive}
                sendKeysRef={unsandboxSendRef}
                onConnect={handleUnsandboxConnect}
              />
            </div>
          ) : (
            <pre
              ref={termRef}
              tabIndex={0}
              onScroll={handleScroll}
              style={dropState === 'done' ? { animation: 'uf-glow-orange 0.6s ease-in-out 3' } : undefined}
              className={`h-full bg-[#0d0d0d] rounded-lg border p-4 overflow-hidden font-mono text-sm leading-relaxed text-[#d4d4d4] whitespace-pre outline-none transition-all duration-300 ${
                dropState === 'hover' ? 'border-violet-500 shadow-[0_0_20px_rgba(139,92,246,0.6)]'
                : dropState === 'uploading' || dropState === 'error' ? 'border-red-500 shadow-[0_0_20px_rgba(239,68,68,0.4)]'
                : dropState === 'done' ? 'border-orange-400'
                : interactive ? 'border-[var(--color-border)] cursor-text' : 'border-[var(--color-border)]'
              }`}
            />
          )}

          {/* Drop overlays */}
          {dropState === 'hover' && (
            <div className="absolute inset-0 rounded-lg flex flex-col items-center justify-center pointer-events-none"
              style={{ background: 'rgba(10,0,20,0.85)' }}>
              <div className="text-6xl mb-4" style={{ animation: 'uf-pulse-red 1s infinite', color: '#a78bfa' }}>⬇</div>
              <div className="font-mono font-bold text-2xl tracking-widest" style={{ color: '#c4b5fd', animation: 'uf-flicker 3s infinite' }}>DROP FILE</div>
              <div className="font-mono text-sm mt-2 tracking-wider" style={{ color: '#8b5cf6' }}>→ INJECT INTO SESSION ←</div>
            </div>
          )}
          {dropState === 'uploading' && (
            <div className="absolute inset-0 rounded-lg flex flex-col items-center justify-center pointer-events-none overflow-hidden"
              style={{ background: 'rgba(20,0,0,0.88)', backgroundImage: 'repeating-linear-gradient(0deg,transparent,transparent 2px,rgba(255,0,0,0.04) 2px,rgba(255,0,0,0.04) 4px)', animation: 'scanlines 0.2s linear infinite' }}>
              <div className="font-mono text-red-400 text-xs tracking-widest mb-1" style={{ animation: 'uf-pulse-red 0.8s infinite' }}>▶ TRANSMITTING</div>
              <div className="font-mono font-bold text-red-300 text-lg tracking-wide mb-4 max-w-xs truncate px-4">{dropFile?.name}</div>
              <div className="w-64 h-5 border border-red-700 rounded-sm bg-black relative overflow-hidden">
                <div className="h-full bg-red-600 origin-left" style={{ width: `${uploadProgress}%`, transition: 'width 0.04s linear', boxShadow: '0 0 8px #ef4444,0 0 20px #ef444466' }} />
                <div className="absolute inset-0" style={{ background: 'repeating-linear-gradient(90deg,transparent,transparent 6px,rgba(0,0,0,0.2) 6px,rgba(0,0,0,0.2) 7px)' }} />
              </div>
              <div className="font-mono text-red-500 text-xs mt-2 tabular-nums">
                {uploadProgress.toFixed(0)}%{isUnsandbox ? '  →  CONTAINER' : host && host !== 'localhost' ? `  →  SCP → ${host}` : '  →  LOCAL'}
              </div>
            </div>
          )}
          {dropState === 'done' && (
            <div className="absolute inset-0 rounded-lg flex flex-col items-center justify-center pointer-events-none" style={{ animation: 'uf-done-flash 1.8s ease-out forwards' }}>
              <div className="font-mono font-bold text-xl tracking-widest" style={{ color: '#f97316' }}>✓ INJECTED</div>
              <div className="font-mono text-xs mt-2 max-w-xs truncate px-4" style={{ color: '#fb923c' }}>{dropFile?.path}</div>
            </div>
          )}
          {dropState === 'error' && (
            <div className="absolute inset-0 rounded-lg flex flex-col items-center justify-center pointer-events-none" style={{ background: 'rgba(30,0,0,0.85)' }}>
              <div className="font-mono font-bold text-red-400 text-xl tracking-widest">✗ FAILED</div>
              <div className="font-mono text-red-300 text-xs mt-2 max-w-xs text-center px-4">{dropError}</div>
            </div>
          )}
        </div>

        <div className="text-xs text-[var(--color-muted)] mt-1">
          {isUnsandbox
            ? 'unsandbox container — full interactive terminal. Drag a file to inject its path.'
            : interactive
              ? 'Keystrokes are sent to tmux. Ctrl+C, arrows, Enter, Tab, Escape all work. Click the terminal first to focus. Drag a file to inject its path.'
              : 'Read-only mode. Click Interactive to enable keyboard input.'
          }
        </div>
      </div>
    </>
  );
}
