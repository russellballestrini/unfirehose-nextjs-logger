import { NextRequest } from 'next/server';
import { execFile } from 'child_process';

function sshPrefix(host?: string): { cmd: string; args: string[] } {
  if (!host || host === 'localhost') return { cmd: 'tmux', args: [] };
  // Validate hostname to prevent command injection
  if (!/^[a-zA-Z0-9._-]+$/.test(host)) throw new Error('Invalid hostname');
  return { cmd: 'ssh', args: ['-o', 'ConnectTimeout=5', '-o', 'StrictHostKeyChecking=no', host, 'tmux'] };
}

function capturePane(session: string, window?: string, host?: string): Promise<string> {
  const target = window ? `${session}:${window}` : session;
  const { cmd, args } = sshPrefix(host);
  const isLocal = !host || host === 'localhost';
  return new Promise((resolve, reject) => {
    execFile(cmd, [...args, 'capture-pane', '-p', '-t', target, '-e'], { timeout: isLocal ? 1000 : 10000, maxBuffer: 1024 * 256 }, (err, stdout) => {
      if (err) reject(err);
      else resolve(stdout);
    });
  });
}

function listSessions(host?: string): Promise<string[]> {
  const { cmd, args } = sshPrefix(host);
  return new Promise((resolve, reject) => {
    execFile(cmd, [...args, 'list-sessions', '-F', '#{session_name}'], { timeout: host ? 10000 : 3000 }, (err, stdout) => {
      if (err) reject(err);
      else resolve(stdout.trim().split('\n').filter(Boolean));
    });
  });
}

function listWindows(session: string, host?: string): Promise<{ index: string; name: string; active: boolean }[]> {
  const { cmd, args } = sshPrefix(host);
  return new Promise((resolve, reject) => {
    execFile(cmd, [...args, 'list-windows', '-t', session, '-F', '#{window_index}:#{window_name}:#{window_active}'], { timeout: host ? 10000 : 3000 }, (err, stdout) => {
      if (err) reject(err);
      else resolve(stdout.trim().split('\n').filter(Boolean).map(line => {
        const [index, name, active] = line.split(':');
        return { index, name, active: active === '1' };
      }));
    });
  });
}

// GET /api/tmux/stream?session=xxx&window=yyy — SSE stream of pane content
// GET /api/tmux/stream — list sessions
// GET /api/tmux/stream?session=xxx&windows=1 — list windows
export async function GET(request: NextRequest) {
  const session = request.nextUrl.searchParams.get('session');
  const window = request.nextUrl.searchParams.get('window') ?? undefined;
  const wantWindows = request.nextUrl.searchParams.get('windows');
  const host = request.nextUrl.searchParams.get('host') ?? undefined;

  // List sessions
  if (!session) {
    try {
      const sessions = await listSessions(host);
      return Response.json({ sessions });
    } catch {
      return Response.json({ sessions: [], error: 'tmux not running' });
    }
  }

  // List windows
  if (wantWindows) {
    try {
      const windows = await listWindows(session, host);
      return Response.json({ windows });
    } catch {
      return Response.json({ windows: [], error: 'session not found' });
    }
  }

  // SSE stream
  const encoder = new TextEncoder();
  let alive = true;
  let lastContent = '';

  const stream = new ReadableStream({
    async start(controller) {
      const send = (data: string) => {
        try {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(data)}\n\n`));
        } catch { alive = false; }
      };

      // Initial capture
      try {
        const content = await capturePane(session, window, host);
        lastContent = content;
        send(content);
      } catch (err) {
        send(`Error: ${String(err)}`);
        controller.close();
        return;
      }

      // Poll — local at 33ms (~30fps), remote at 300ms
      const isLocal = !host || host === 'localhost';
      const pollMs = isLocal ? 33 : 300;
      let polling = false;
      const interval = setInterval(async () => {
        if (!alive) { clearInterval(interval); controller.close(); return; }
        if (polling) return; // skip if previous capture still in flight
        polling = true;
        try {
          const content = await capturePane(session, window, host);
          if (content !== lastContent) {
            lastContent = content;
            send(content);
          }
        } catch {
          alive = false;
          clearInterval(interval);
          try { controller.close(); } catch {}
        }
        polling = false;
      }, pollMs);

      // Clean up after 30 minutes max
      setTimeout(() => { alive = false; clearInterval(interval); try { controller.close(); } catch {} }, 30 * 60 * 1000);
    },
    cancel() { alive = false; },
  });

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
    },
  });
}

// POST /api/tmux/stream — send keys to a tmux session
function sendKeys(session: string, keys: string, host?: string): Promise<void> {
  const { cmd, args } = sshPrefix(host);
  return new Promise((resolve, reject) => {
    execFile(cmd, [...args, 'send-keys', '-t', session, '-l', keys], { timeout: host ? 10000 : 3000 }, (err) => {
      if (err) reject(err);
      else resolve();
    });
  });
}

function sendSpecialKey(session: string, key: string, host?: string): Promise<void> {
  const { cmd, args } = sshPrefix(host);
  return new Promise((resolve, reject) => {
    execFile(cmd, [...args, 'send-keys', '-t', session, key], { timeout: host ? 10000 : 3000 }, (err) => {
      if (err) reject(err);
      else resolve();
    });
  });
}

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { session, keys, special, host } = body;
    if (!session || typeof session !== 'string') {
      return Response.json({ error: 'session required' }, { status: 400 });
    }
    if (!/^[a-zA-Z0-9_-]+$/.test(session)) {
      return Response.json({ error: 'invalid session name' }, { status: 400 });
    }

    if (special && typeof special === 'string') {
      // Named keys: Enter, C-c, Escape, Up, Down, Left, Right, Tab, BSpace, etc.
      const allowed = ['Enter', 'Escape', 'Tab', 'BSpace', 'DC', 'Up', 'Down', 'Left', 'Right', 'Home', 'End', 'PageUp', 'PageDown', 'C-c', 'C-d', 'C-z', 'C-l', 'C-a', 'C-e', 'C-k', 'C-u', 'C-w', 'C-r', 'C-p', 'C-n', 'C-b', 'C-f'];
      if (!allowed.includes(special)) {
        return Response.json({ error: 'key not allowed' }, { status: 400 });
      }
      await sendSpecialKey(session, special, host);
    } else if (keys && typeof keys === 'string') {
      // Limit literal input length
      if (keys.length > 4096) {
        return Response.json({ error: 'input too long' }, { status: 400 });
      }
      await sendKeys(session, keys, host);
    } else {
      return Response.json({ error: 'keys or special required' }, { status: 400 });
    }

    return Response.json({ ok: true });
  } catch (err) {
    return Response.json({ error: String(err) }, { status: 500 });
  }
}
