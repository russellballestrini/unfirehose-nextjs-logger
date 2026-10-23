'use client';

import { useEffect, useRef } from 'react';
import type { TerminalPaneProps } from '../index';

// ── XtermPane — full terminal emulator for unsandbox sessions ────────────────
export function XtermPane({
  sessionId,
  interactive,
  sendKeysRef,
  onConnect,
  onServiceState,
}: TerminalPaneProps) {
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
              onServiceState(null, ''); // clear any service state
              const bytes = Uint8Array.from(atob(msg.data), c => c.charCodeAt(0));
              term.write(bytes);
            } else if (msg.type === 'service_state') {
              // Service lifecycle event — don't spam reconnect
              onServiceState(msg.state, msg.data);
              if (msg.state === 'running') {
                // Service came back — reconnect to get the shell
                onServiceState(null, '');
                es?.close();
                setTimeout(connect, 1000);
              }
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
          // Slower reconnect — don't spam on dead services
          setTimeout(connect, 3000);
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

