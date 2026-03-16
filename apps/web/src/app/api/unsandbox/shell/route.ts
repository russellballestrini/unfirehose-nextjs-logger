import { NextRequest } from 'next/server';
import { createHmac } from 'crypto';
import { getSetting } from '@unturf/unfirehose/db/ingest';
import WebSocket from 'ws';

const API_BASE = 'https://api.unsandbox.com';
const WSS_BASE = 'wss://api.unsandbox.com';

// Service IDs start with 'unsb-service-'
const IS_SERVICE_RE = /^unsb-service-/;

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

// Check service state before connecting — returns error string or null if OK
async function checkServiceState(sessionId: string, publicKey: string, secretKey: string): Promise<{ error: string; state: string } | null> {
  if (!IS_SERVICE_RE.test(sessionId)) return null; // not a service, skip check

  try {
    const hdrs = authHeaders(publicKey, secretKey, 'GET', `/services/${sessionId}`);
    const res = await fetch(`${API_BASE}/services/${sessionId}`, { headers: hdrs, signal: AbortSignal.timeout(10000) });
    if (!res.ok) return { error: `Service not found (${res.status})`, state: 'not_found' };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const svc: any = await res.json();
    const state = svc.state ?? svc.status ?? 'unknown';
    if (state === 'running') return null; // all good
    if (state === 'frozen' || state === 'sleeping') {
      return { error: `Service is ${state}. Wake it first.`, state };
    }
    if (state === 'unreachable') {
      return { error: 'Service is unreachable — container failed to start. Check bootstrap logs or redeploy.', state };
    }
    return { error: `Service state: ${state}`, state };
  } catch {
    return null; // can't check, proceed anyway
  }
}

// Find the session ID for a service — the portal uses service ID directly as session ID,
// but also checks svc: prefix and service_id field (matching portal's connectToService logic)
async function resolveSessionId(serviceId: string, publicKey: string, secretKey: string): Promise<string> {
  if (!IS_SERVICE_RE.test(serviceId)) return serviceId; // already a session ID

  // Portal pattern: session ID = service ID
  // Verify by checking sessions list
  try {
    const hdrs = authHeaders(publicKey, secretKey, 'GET', '/sessions');
    const res = await fetch(`${API_BASE}/sessions`, { headers: hdrs, signal: AbortSignal.timeout(10000) });
    if (res.ok) {
      const data = await res.json();
      const sessions = data.sessions ?? data;
      // Match portal's connectToService logic
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const match = sessions.find((s: any) => {
        const sid = s.session_id || s.id;
        return sid === serviceId || sid === `svc:${serviceId}` || s.service_id === serviceId;
      });
      if (match) return match.session_id || match.id;
    }
  } catch { /* fall through */ }

  // Default: use service ID as session ID (portal convention)
  return serviceId;
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
    shells.delete(sessionId);
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
    async start(controller) {
      const send = (data: string) => {
        if (!alive) return;
        try {
          controller.enqueue(encoder.encode(`data: ${data}\n\n`));
        } catch { alive = false; }
      };

      // For services: check state before connecting WebSocket
      const stateErr = await checkServiceState(sessionId, publicKey, secretKey);
      if (stateErr) {
        send(JSON.stringify({ type: 'service_state', data: stateErr.error, state: stateErr.state }));
        // Don't close — let the client decide (it may poll for state changes)
        // Keep alive with pings so client can reconnect when service wakes
        const pingTimer = setInterval(() => {
          if (!alive) { clearInterval(pingTimer); return; }
          try { controller.enqueue(encoder.encode(': ping\n\n')); } catch { alive = false; clearInterval(pingTimer); }
        }, 5000);
        // Re-check state every 10s — auto-connect when service comes up
        const recheckTimer = setInterval(async () => {
          if (!alive) { clearInterval(recheckTimer); clearInterval(pingTimer); return; }
          const recheck = await checkServiceState(sessionId, publicKey, secretKey);
          if (!recheck) {
            // Service is now running — notify client to reconnect
            clearInterval(recheckTimer);
            clearInterval(pingTimer);
            send(JSON.stringify({ type: 'service_state', data: 'Service is now running', state: 'running' }));
            try { controller.close(); } catch {}
          }
        }, 10000);
        request.signal.addEventListener('abort', () => {
          alive = false;
          clearInterval(pingTimer);
          clearInterval(recheckTimer);
          try { controller.close(); } catch {};
        });
        return;
      }

      // Resolve the actual session ID for this service
      const resolvedId = await resolveSessionId(sessionId, publicKey, secretKey);

      // Register listener under the original ID (what the client knows)
      const set = getListeners(sessionId);
      set.add(send);

      // Connect (or reuse existing) WS — use the resolved session ID
      let ws: WebSocket;
      try {
        ws = connectShell(resolvedId, publicKey, secretKey);
      } catch (err) {
        send(JSON.stringify({ type: 'error', data: String(err) }));
        controller.close();
        return;
      }

      // If resolved ID differs from sessionId, also listen on resolved ID
      if (resolvedId !== sessionId) {
        const resolvedSet = getListeners(resolvedId);
        resolvedSet.add(send);
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
        if (resolvedId !== sessionId) {
          const resolvedSet = listeners.get(resolvedId);
          if (resolvedSet) resolvedSet.delete(send);
        }
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

  // Resolve service ID → session ID if needed
  const resolvedId = IS_SERVICE_RE.test(session_id)
    ? await resolveSessionId(session_id, publicKey, secretKey)
    : session_id;

  const ws = connectShell(resolvedId, publicKey, secretKey);

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
