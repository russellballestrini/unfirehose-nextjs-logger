'use client';

import { useState, useEffect, useRef, useCallback } from 'react';
import { useParams, useSearchParams } from 'next/navigation';
import Link from 'next/link';
import useSWR from 'swr';

const fetcher = (url: string) => fetch(url).then(r => r.json());

// Convert basic ANSI escape codes to styled spans — optimized hot path
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
// Cache style strings keyed by state — avoids rebuilding for repeated states
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
  let fg = '';
  let bg = '';
  let bold = false;
  let dim = false;

  const parts = text.split(ANSI_RE);

  for (let i = 0; i < parts.length; i++) {
    const part = parts[i];
    if (!part) continue;
    const match = ESC_RE.exec(part);
    if (match) {
      const codes = match[1].split(';');
      for (let j = 0; j < codes.length; j++) {
        const code = codes[j];
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
      if (open) {
        chunks.push(open, escaped, '</span>');
      } else {
        chunks.push(escaped);
      }
    }
  }
  return chunks.join('');
}

export default function TmuxViewerPage() {
  const params = useParams();
  const searchParams = useSearchParams();
  const session = params.session as string;
  const host = searchParams.get('host') ?? undefined;
  const hostParam = host ? `&host=${encodeURIComponent(host)}` : '';
  const [connected, setConnected] = useState(false);
  const connectedRef = useRef(false);
  const [activeWindow, setActiveWindow] = useState<string | undefined>(undefined);
  const termRef = useRef<HTMLPreElement>(null);
  const autoScrollRef = useRef(true);
  // rAF-gated rendering: buffer incoming content, only paint once per frame
  const pendingContentRef = useRef<string | null>(null);
  const lastRenderedRef = useRef('');
  const rafIdRef = useRef<number>(0);

  // Paint content to terminal — used by both SSE and POST response
  const paintContent = useCallback((raw: string) => {
    if (raw === lastRenderedRef.current) return;
    lastRenderedRef.current = raw;
    if (termRef.current) {
      termRef.current.innerHTML = ansiToHtml(raw);
      if (autoScrollRef.current) {
        termRef.current.scrollTop = termRef.current.scrollHeight;
      }
    }
  }, []);

  const { data: windowsData } = useSWR(
    `/api/tmux/stream?session=${encodeURIComponent(session)}&windows=1${hostParam}`,
    fetcher,
    { refreshInterval: 5000 }
  );
  const windows: { index: string; name: string; active: boolean }[] = windowsData?.windows ?? [];

  const connectSSERef = useRef<() => EventSource>(null);
  connectSSERef.current = useCallback(() => {  
    const url = `/api/tmux/stream?session=${encodeURIComponent(session)}${activeWindow ? `&window=${activeWindow}` : ''}${hostParam}`;
    const es = new EventSource(url);

    es.onmessage = (e) => {
      try {
        const data = JSON.parse(e.data);
        if (!connectedRef.current) { connectedRef.current = true; setConnected(true); }
        // Buffer content — only render on next animation frame
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
      // Reconnect after 500ms
      setTimeout(() => connectSSERef.current?.(), 500);
    };

    return es;
  }, [session, activeWindow, hostParam, paintContent]);

  useEffect(() => {
    // Set initial text
    if (termRef.current && !termRef.current.textContent) {
      termRef.current.textContent = 'Connecting...';
    }
    const es = connectSSERef.current!();
    return () => {
      es.close();
      if (rafIdRef.current) { cancelAnimationFrame(rafIdRef.current); rafIdRef.current = 0; }
    };
  }, [session, activeWindow, hostParam]);

  // Interactive mode
  const [interactive, setInteractive] = useState(true);
  const queueRef = useRef<Array<{ keys?: string; special?: string }>>([]);
  const flushingRef = useRef(false);
  const flushTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Flush the keystroke queue — batches consecutive literal chars into one request
  const flushQueue = useCallback(async () => {
    if (flushingRef.current || queueRef.current.length === 0) return;
    flushingRef.current = true;

    while (queueRef.current.length > 0) {
      // Batch consecutive literal keys into one string
      let batch = '';
      const pending: typeof queueRef.current = [];
      for (const item of queueRef.current) {
        if (item.keys) {
          batch += item.keys;
        } else {
          if (batch) break;
          pending.push(item);
          break;
        }
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
        // Render immediately from POST response — don't wait for next SSE poll
        const result = await res.json();
        if (result.content) paintContent(result.content);
      } catch { /* best effort */ }
    }

    flushingRef.current = false;
  }, [session, activeWindow, host, paintContent]);

  const enqueueKeys = useCallback((payload: { keys?: string; special?: string }) => {
    queueRef.current.push(payload);
    // For special keys, flush immediately; for literals, debounce 16ms to batch typing
    if (payload.special) {
      if (flushTimerRef.current) { clearTimeout(flushTimerRef.current); flushTimerRef.current = null; }
      flushQueue();
    } else {
      if (!flushTimerRef.current) {
        flushTimerRef.current = setTimeout(() => {
          flushTimerRef.current = null;
          flushQueue();
        }, 16);
      }
    }
  }, [flushQueue]);

  // Keyboard handler for interactive mode
  useEffect(() => {
    if (!interactive) return;
    const SPECIAL_MAP: Record<string, string> = {
      Enter: 'Enter', Escape: 'Escape', Tab: 'Tab', Backspace: 'BSpace',
      Delete: 'DC', ArrowUp: 'Up', ArrowDown: 'Down', ArrowLeft: 'Left',
      ArrowRight: 'Right', Home: 'Home', End: 'End', PageUp: 'PageUp', PageDown: 'PageDown',
    };
    const CTRL_MAP: Record<string, string> = {
      c: 'C-c', d: 'C-d', z: 'C-z', l: 'C-l', a: 'C-a', e: 'C-e',
      k: 'C-k', u: 'C-u', w: 'C-w', r: 'C-r', p: 'C-p', n: 'C-n',
      b: 'C-b', f: 'C-f',
    };
    const handler = (e: KeyboardEvent) => {
      // Don't capture if user is in an input/select/textarea
      if ((e.target as HTMLElement)?.closest('input, textarea, select')) return;

      if (e.ctrlKey && CTRL_MAP[e.key]) {
        e.preventDefault();
        enqueueKeys({ special: CTRL_MAP[e.key] });
      } else if (SPECIAL_MAP[e.key]) {
        e.preventDefault();
        enqueueKeys({ special: SPECIAL_MAP[e.key] });
      } else if (e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey) {
        e.preventDefault();
        enqueueKeys({ keys: e.key });
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [interactive, enqueueKeys]);

  // Resize tmux window to match the terminal container dimensions
  useEffect(() => {
    if (!termRef.current) return;
    let timer: ReturnType<typeof setTimeout> | null = null;

    const sendResize = () => {
      if (!termRef.current) return;
      const rect = termRef.current.getBoundingClientRect();
      // Measure actual character width using a hidden test span
      const span = document.createElement('span');
      span.style.cssText = 'position:absolute;visibility:hidden;font:inherit;white-space:pre';
      span.textContent = 'X'.repeat(10);
      termRef.current.appendChild(span);
      const charW = span.getBoundingClientRect().width / 10;
      const charH = parseFloat(getComputedStyle(termRef.current).lineHeight) || 20;
      termRef.current.removeChild(span);

      const padding = 32; // p-4 = 1rem = 16px each side
      const cols = Math.max(80, Math.floor((rect.width - padding) / charW));
      const rows = Math.max(24, Math.floor((rect.height - padding) / charH));

      fetch('/api/tmux/stream', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ session: decodeURIComponent(session), window: activeWindow, host, action: 'resize', cols, rows }),
      }).catch(() => {});
    };

    const observer = new ResizeObserver(() => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(sendResize, 150);
    });
    observer.observe(termRef.current);
    // Fire immediately on mount
    sendResize();

    return () => {
      observer.disconnect();
      if (timer) clearTimeout(timer);
    };
  }, [session, activeWindow, host]);

  // Handle scroll — disable auto-scroll when user scrolls up
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

    // Animate progress — fast to 70%, stall while waiting for server
    let prog = 0;
    const tick = setInterval(() => {
      prog = prog < 70 ? prog + 4 : prog < 88 ? prog + 0.4 : prog;
      setUploadProgress(Math.min(prog, 88));
    }, 40);

    try {
      const fd = new FormData();
      fd.append('file', file);
      fd.append('session', decodeURIComponent(session));
      if (host) fd.append('host', host);

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

      // Type the path into the terminal
      await fetch('/api/tmux/stream', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ session: decodeURIComponent(session), window: activeWindow, host, keys: path }),
      });

      setTimeout(() => { setDropState('idle'); setDropFile(null); }, 1800);
    } catch (err) {
      clearInterval(tick);
      setDropError(String(err));
      setDropState('error');
      setTimeout(() => { setDropState('idle'); setDropError(''); }, 3000);
    }
  };

  const onDragEnter = (e: React.DragEvent) => {
    e.preventDefault();
    dragCounterRef.current++;
    if (dropState === 'idle') setDropState('hover');
  };
  const onDragLeave = (e: React.DragEvent) => {
    e.preventDefault();
    dragCounterRef.current--;
    if (dragCounterRef.current <= 0) { dragCounterRef.current = 0; setDropState('idle'); }
  };
  const onDragOver = (e: React.DragEvent) => { e.preventDefault(); };
  const onDrop = (e: React.DragEvent) => {
    e.preventDefault();
    dragCounterRef.current = 0;
    const file = e.dataTransfer.files[0];
    if (file) uploadFile(file);
  };

  return (
    <>
      <style>{`
        @keyframes scanlines {
          0% { background-position: 0 0; }
          100% { background-position: 0 4px; }
        }
        @keyframes uf-pulse-red {
          0%,100% { opacity: 1; }
          50% { opacity: 0.4; }
        }
        @keyframes uf-flicker {
          0%,100% { opacity:1; } 92%{opacity:1;} 93%{opacity:0.6;} 94%{opacity:1;} 97%{opacity:0.8;} 98%{opacity:1;}
        }
        @keyframes uf-slide-in {
          from { transform: scaleX(0); }
          to   { transform: scaleX(1); }
        }
        @keyframes uf-glow-green {
          0%,100% { box-shadow: 0 0 12px #00ff41, 0 0 30px #00ff4133; }
          50%     { box-shadow: 0 0 24px #00ff41, 0 0 60px #00ff4166; }
        }
        @keyframes uf-done-flash {
          0%   { background: rgba(0,255,65,0.3); }
          100% { background: rgba(0,255,65,0); }
        }
      `}</style>
      <div className="flex flex-col h-[calc(100vh-2rem)]">
      {/* Header */}
      <div className="flex items-center gap-3 mb-3">
        <Link href="/tmux" className="text-[var(--color-muted)] hover:text-[var(--color-foreground)] text-sm">
          &larr; Back
        </Link>
        <h2 className="text-lg font-bold font-mono">{decodeURIComponent(session)}</h2>
        {host && <span className="text-xs text-[var(--color-muted)] font-mono">@{host}</span>}
        <span className={`w-2 h-2 rounded-full ${connected ? 'bg-green-400 animate-pulse' : 'bg-red-400'}`} />
        <span className="text-xs text-[var(--color-muted)]">{connected ? 'live' : 'reconnecting...'}</span>
        <button
          onClick={() => setInteractive(!interactive)}
          className={`ml-auto px-3 py-1 text-xs rounded font-bold cursor-pointer transition-colors ${
            interactive
              ? 'bg-green-500 text-black'
              : 'bg-[var(--color-surface)] text-[var(--color-muted)] hover:text-[var(--color-foreground)] border border-[var(--color-border)]'
          }`}
        >
          {interactive ? '⌨ Interactive' : '⌨ Read-only'}
        </button>
      </div>

      {/* Window tabs */}
      {windows.length > 1 && (
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

      {/* Terminal + drop overlay wrapper */}
      <div
        className="relative flex-1 min-h-0"
        onDragEnter={onDragEnter}
        onDragLeave={onDragLeave}
        onDragOver={onDragOver}
        onDrop={onDrop}
      >
        <pre
          ref={termRef}
          tabIndex={0}
          onScroll={handleScroll}
          style={dropState === 'done' ? { animation: 'uf-glow-green 0.6s ease-in-out 3' } : undefined}
          className={`h-full bg-[#0d0d0d] rounded-lg border p-4 overflow-hidden font-mono text-sm leading-relaxed text-[#d4d4d4] whitespace-pre outline-none transition-all duration-300 ${
            dropState === 'hover'
              ? 'border-cyan-400 shadow-[0_0_20px_rgba(34,211,238,0.5)]'
              : dropState === 'uploading' || dropState === 'error'
              ? 'border-red-500 shadow-[0_0_20px_rgba(239,68,68,0.4)]'
              : dropState === 'done'
              ? 'border-green-400'
              : interactive ? 'border-green-500/50 cursor-text' : 'border-[var(--color-border)]'
          }`}
        />

        {/* ── HOVER overlay ── */}
        {dropState === 'hover' && (
          <div className="absolute inset-0 rounded-lg flex flex-col items-center justify-center pointer-events-none"
            style={{ background: 'rgba(0,20,30,0.82)' }}>
            <div className="text-6xl mb-4" style={{ animation: 'uf-pulse-red 1s infinite', color: '#22d3ee' }}>⬇</div>
            <div className="font-mono font-bold text-2xl tracking-widest text-cyan-300"
              style={{ animation: 'uf-flicker 3s infinite' }}>DROP FILE</div>
            <div className="font-mono text-sm text-cyan-500 mt-2 tracking-wider">
              → INJECT INTO SESSION ←
            </div>
          </div>
        )}

        {/* ── UPLOADING overlay ── */}
        {dropState === 'uploading' && (
          <div className="absolute inset-0 rounded-lg flex flex-col items-center justify-center pointer-events-none overflow-hidden"
            style={{
              background: 'rgba(20,0,0,0.88)',
              backgroundImage: 'repeating-linear-gradient(0deg, transparent, transparent 2px, rgba(255,0,0,0.04) 2px, rgba(255,0,0,0.04) 4px)',
              animation: 'scanlines 0.2s linear infinite',
            }}>
            <div className="font-mono text-red-400 text-xs tracking-widest mb-1"
              style={{ animation: 'uf-pulse-red 0.8s infinite' }}>
              ▶ TRANSMITTING
            </div>
            <div className="font-mono font-bold text-red-300 text-lg tracking-wide mb-4 max-w-xs truncate px-4">
              {dropFile?.name}
            </div>
            {/* Progress bar */}
            <div className="w-64 h-5 border border-red-700 rounded-sm bg-black relative overflow-hidden">
              <div
                className="h-full bg-red-600 origin-left"
                style={{
                  width: `${uploadProgress}%`,
                  transition: 'width 0.04s linear',
                  boxShadow: '0 0 8px #ef4444, 0 0 20px #ef444466',
                }}
              />
              {/* Scanline on bar */}
              <div className="absolute inset-0"
                style={{ background: 'repeating-linear-gradient(90deg, transparent, transparent 6px, rgba(0,0,0,0.2) 6px, rgba(0,0,0,0.2) 7px)' }} />
            </div>
            <div className="font-mono text-red-500 text-xs mt-2 tabular-nums">
              {uploadProgress.toFixed(0)}%{host && host !== 'localhost' ? `  →  SCP → ${host}` : '  →  LOCAL'}
            </div>
          </div>
        )}

        {/* ── DONE overlay ── */}
        {dropState === 'done' && (
          <div className="absolute inset-0 rounded-lg flex flex-col items-center justify-center pointer-events-none"
            style={{ animation: 'uf-done-flash 1.8s ease-out forwards' }}>
            <div className="font-mono font-bold text-green-400 text-xl tracking-widest">✓ INJECTED</div>
            <div className="font-mono text-green-300 text-xs mt-2 max-w-xs truncate px-4">{dropFile?.path}</div>
          </div>
        )}

        {/* ── ERROR overlay ── */}
        {dropState === 'error' && (
          <div className="absolute inset-0 rounded-lg flex flex-col items-center justify-center pointer-events-none"
            style={{ background: 'rgba(30,0,0,0.85)' }}>
            <div className="font-mono font-bold text-red-400 text-xl tracking-widest">✗ FAILED</div>
            <div className="font-mono text-red-300 text-xs mt-2 max-w-xs text-center px-4">{dropError}</div>
          </div>
        )}
      </div>

      {interactive && (
        <div className="text-xs text-[var(--color-muted)] mt-1">
          Keystrokes are sent to tmux. Ctrl+C, arrows, Enter, Tab, Escape all work. Click the terminal first to focus.
          {' '}Drag a file to inject its path.
        </div>
      )}
    </div>
    </>
  );
}
