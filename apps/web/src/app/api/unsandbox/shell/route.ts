import { NextRequest } from 'next/server';
import { createHmac } from 'crypto';
import { getSetting } from '@unturf/unfirehose/db/ingest';
import WebSocket from 'ws';

const WSS_BASE = 'wss://api.unsandbox.com';

function sign(secretKey: string, method: string, path: string, body = ''): { timestamp: string; signature: string } {
  const timestamp = Math.floor(Date.now() / 1000).toString();
  const message = `${timestamp}:${method}:${path}:${body}`;
  const signature = createHmac('sha256', secretKey).update(message).digest('hex');
  return { timestamp, signature };
}

function authHeaders(publicKey: string, secretKey: string, method: string, path: string, body = ''): Record<string, string> {
  const { timestamp, signature } = sign(secretKey, method, path, body);
  return {
    'Authorization': `Bearer ${publicKey}`,
    'X-Timestamp': timestamp,
    'X-Signature': signature,
    'Content-Type': 'application/json',
  };
}

// Global map: session_id → WebSocket  (lives for the lifetime of the Node process)
const shells = new Map<string, WebSocket>();
// Listeners registered by SSE connections
const listeners = new Map<string, Set<(data: string) => void>>();

function getListeners(sessionId: string): Set<(data: string) => void> {
  if (!listeners.has(sessionId)) listeners.set(sessionId, new Set());
  return listeners.get(sessionId)!;
}

function connectShell(sessionId: string, publicKey: string, secretKey: string): WebSocket {
  const existing = shells.get(sessionId);
  if (existing && existing.readyState === WebSocket.OPEN) return existing;
  if (existing && existing.readyState === WebSocket.CONNECTING) return existing;

  const path = `/sessions/${sessionId}/shell`;
  const hdrs = authHeaders(publicKey, secretKey, 'GET', path);

  const ws = new WebSocket(`${WSS_BASE}${path}`, {
    headers: hdrs,
  });

  shells.set(sessionId, ws);

  ws.on('message', (data: Buffer | string, isBinary: boolean) => {
    const set = getListeners(sessionId);
    if (!set.size) return;
    let out: string;
    if (isBinary) {
      // Raw terminal output — base64-encode for SSE transport
      out = JSON.stringify({ type: 'output', data: (data as Buffer).toString('base64') });
    } else {
      // Control message (resize ack, exit, detached)
      out = JSON.stringify({ type: 'control', data: data.toString() });
    }
    set.forEach(fn => fn(out));
  });

  ws.on('close', () => {
    shells.delete(sessionId);
    const set = getListeners(sessionId);
    const msg = JSON.stringify({ type: 'close' });
    set.forEach(fn => fn(msg));
  });

  ws.on('error', (err: Error) => {
    const set = getListeners(sessionId);
    const msg = JSON.stringify({ type: 'error', data: err.message });
    set.forEach(fn => fn(msg));
  });

  // Send initial resize on fresh connect
  ws.on('open', () => {
    ws.send(JSON.stringify({ type: 'resize', cols: 220, rows: 50 }));
  });

  return ws;
}

// GET /api/unsandbox/shell?session_id=xxx  — SSE stream of shell output
export async function GET(request: NextRequest) {
  const sessionId = request.nextUrl.searchParams.get('session_id');
  if (!sessionId || !/^[a-zA-Z0-9_-]+$/.test(sessionId)) {
    return Response.json({ error: 'session_id required' }, { status: 400 });
  }

  const publicKey = getSetting('unsandbox_public_key');
  const secretKey = getSetting('unsandbox_secret_key');
  if (!publicKey || !secretKey) {
    return Response.json({ error: 'No unsandbox keys configured' }, { status: 400 });
  }

  const encoder = new TextEncoder();
  let alive = true;

  const stream = new ReadableStream({
    start(controller) {
      const send = (data: string) => {
        if (!alive) return;
        try {
          controller.enqueue(encoder.encode(`data: ${data}\n\n`));
        } catch { alive = false; }
      };

      // Register listener
      const set = getListeners(sessionId);
      set.add(send);

      // Connect (or reuse existing) WS
      let ws: WebSocket;
      try {
        ws = connectShell(sessionId, publicKey, secretKey);
      } catch (err) {
        send(JSON.stringify({ type: 'error', data: String(err) }));
        controller.close();
        return;
      }

      // Wake the shell prompt every time a viewer connects (handles both fresh WS
      // and reused WS where ws.on('open') never fires again)
      const wakePrompt = () => {
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(Buffer.from('\r'));
        } else {
          ws.once('open', () => setTimeout(() => ws.send(Buffer.from('\r')), 150));
        }
      };
      // Delay slightly so xterm has time to initialize before output arrives
      setTimeout(wakePrompt, 300);

      // Keepalive ping every 15s
      const pingTimer = setInterval(() => {
        if (!alive) { clearInterval(pingTimer); return; }
        try { controller.enqueue(encoder.encode(': ping\n\n')); } catch { alive = false; clearInterval(pingTimer); }
      }, 15000);

      // Max 30 min session
      const maxTimer = setTimeout(() => {
        alive = false;
        clearInterval(pingTimer);
        set.delete(send);
        try { controller.close(); } catch {}
      }, 30 * 60 * 1000);

      // Cleanup on cancel
      request.signal.addEventListener('abort', () => {
        alive = false;
        clearInterval(pingTimer);
        clearTimeout(maxTimer);
        set.delete(send);
        try { controller.close(); } catch {}
      });
    },
    cancel() {
      alive = false;
      const set = listeners.get(sessionId);
      if (set) set.clear();
    },
  });

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
    },
  });
}

// POST /api/unsandbox/shell — send keys or resize
export async function POST(request: NextRequest) {
  const publicKey = getSetting('unsandbox_public_key');
  const secretKey = getSetting('unsandbox_secret_key');
  if (!publicKey || !secretKey) {
    return Response.json({ error: 'No unsandbox keys configured' }, { status: 400 });
  }

  const body = await request.json();
  const { session_id, keys, special, action, cols, rows } = body;

  if (!session_id || typeof session_id !== 'string' || !/^[a-zA-Z0-9_-]+$/.test(session_id)) {
    return Response.json({ error: 'session_id required' }, { status: 400 });
  }

  const ws = connectShell(session_id, publicKey, secretKey);

  if (ws.readyState !== WebSocket.OPEN && ws.readyState !== WebSocket.CONNECTING) {
    return Response.json({ error: 'shell not connected' }, { status: 503 });
  }

  const waitOpen = (): Promise<void> => {
    if (ws.readyState === WebSocket.OPEN) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('timeout')), 5000);
      ws.once('open', () => { clearTimeout(t); resolve(); });
      ws.once('error', (e: Error) => { clearTimeout(t); reject(e); });
    });
  };

  try {
    await waitOpen();
  } catch (err) {
    return Response.json({ error: String(err) }, { status: 503 });
  }

  if (action === 'resize') {
    if (typeof cols !== 'number' || typeof rows !== 'number') {
      return Response.json({ error: 'cols and rows required' }, { status: 400 });
    }
    ws.send(JSON.stringify({ type: 'resize', cols: Math.min(Math.max(cols, 40), 500), rows: Math.min(Math.max(rows, 10), 200) }));
    return Response.json({ ok: true });
  }

  const SPECIAL_MAP: Record<string, string> = {
    Enter: '\r', Escape: '\x1b', Tab: '\t', BSpace: '\x7f', DC: '\x1b[3~',
    Up: '\x1b[A', Down: '\x1b[B', Left: '\x1b[D', Right: '\x1b[C',
    Home: '\x1b[H', End: '\x1b[F', PageUp: '\x1b[5~', PageDown: '\x1b[6~',
    'C-c': '\x03', 'C-d': '\x04', 'C-z': '\x1a', 'C-l': '\x0c', 'C-a': '\x01',
    'C-e': '\x05', 'C-k': '\x0b', 'C-u': '\x15', 'C-w': '\x17', 'C-r': '\x12',
    'C-p': '\x10', 'C-n': '\x0e', 'C-b': '\x02', 'C-f': '\x06',
  };

  if (special && typeof special === 'string') {
    const seq = SPECIAL_MAP[special];
    if (!seq) return Response.json({ error: 'key not allowed' }, { status: 400 });
    ws.send(Buffer.from(seq, 'binary'));
  } else if (keys && typeof keys === 'string') {
    if (keys.length > 4096) return Response.json({ error: 'input too long' }, { status: 400 });
    ws.send(Buffer.from(keys, 'utf-8'));
  } else {
    return Response.json({ error: 'keys, special, or action required' }, { status: 400 });
  }

  return Response.json({ ok: true });
}

// GET /api/unsandbox/shell/sessions — list active unsandbox sessions
export async function HEAD(request: NextRequest) {
  void request;
  return Response.json({ ok: true });
}
