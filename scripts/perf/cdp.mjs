/**
 * A very small Chrome DevTools Protocol client.
 *
 * We drive a real browser because the thing we want to know — when does a
 * reader see their data — is not something an HTTP client can answer. Our
 * pages render on the client: the document arrives in about forty
 * milliseconds and then nothing is on screen until the bundle parses, React
 * hydrates, SWR fetches, and the result paints. Timing the document
 * measures the fastest part of that and reports it as the whole.
 *
 * No new dependency: chromium is on the box and `ws` is already in the tree.
 */

import { spawn } from 'child_process';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import WebSocket from 'ws';

const CHROME = process.env.CHROME_BIN ?? 'chromium';

/** Wait for a condition, polling. Browsers start asynchronously. */
async function until(fn, { timeout = 20_000, every = 100 } = {}) {
  const deadline = Date.now() + timeout;
  for (;;) {
    try {
      const v = await fn();
      if (v) return v;
    } catch { /* not ready */ }
    if (Date.now() > deadline) throw new Error('timed out waiting for the browser');
    await new Promise((r) => setTimeout(r, every));
  }
}

export async function launch({ port = 9333, headless = true } = {}) {
  // A throwaway profile each run: a warm HTTP cache would measure the second
  // visit and call it the first, which is the visit nobody complains about.
  const profile = mkdtempSync(join(tmpdir(), 'unfirehose-perf-'));
  const proc = spawn(CHROME, [
    headless ? '--headless=new' : '',
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${profile}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-extensions',
    // Headless throttles background work; these keep a measured page in the
    // foreground so its timers and rendering are not artificially slowed.
    '--disable-backgrounding-occluded-windows',
    '--disable-renderer-backgrounding',
    '--disable-background-timer-throttling',
    '--window-size=1440,900',
    'about:blank',
    // Its own process group, so closing kills the renderers too. Killing the
    // parent alone leaves every renderer running at full tilt — twenty-one of
    // them were found eating the machine after a morning of runs, which
    // pushed the load average to twenty and made the very pages being
    // measured three times slower than they were. An instrument that
    // degrades what it measures is worse than none.
  ].filter(Boolean), { stdio: 'ignore', detached: true });

  // Cleanup must never take a finished measurement down with it. Chromium
  // is still writing its profile as it dies, and rmSync on a directory that
  // is changing underneath it throws ENOTEMPTY — which once discarded five
  // minutes of results at the very last line. So: kill, then remove with
  // retries, and swallow whatever the last attempt says. A stale profile in
  // /tmp is a nuisance; a lost run is the failure.
  const rmProfile = (attempt = 0) => {
    try { rmSync(profile, { recursive: true, force: true }); }
    catch { if (attempt < 5) setTimeout(() => rmProfile(attempt + 1), 400).unref(); }
  };
  const killAll = () => {
    try { process.kill(-proc.pid, 'SIGTERM'); } catch { /* already gone */ }
    setTimeout(() => { try { process.kill(-proc.pid, 'SIGKILL'); } catch { /* gone */ } }, 1500).unref();
    setTimeout(() => rmProfile(), 600).unref();
  };
  // An aborted run — Ctrl-C, a thrown error, a killed shell — must not leave
  // a browser behind either.
  process.once('exit', killAll);
  process.once('SIGINT', () => { killAll(); process.exit(130); });
  process.once('SIGTERM', () => { killAll(); process.exit(143); });

  const version = await until(async () => {
    const res = await fetch(`http://127.0.0.1:${port}/json/version`);
    return res.ok ? res.json() : null;
  });

  const ws = new WebSocket(version.webSocketDebuggerUrl, { maxPayload: 256 * 1024 * 1024 });
  await new Promise((res, rej) => { ws.once('open', res); ws.once('error', rej); });

  let nextId = 1;
  const pending = new Map();
  const listeners = new Set();

  ws.on('message', (raw) => {
    const msg = JSON.parse(raw);
    if (msg.id && pending.has(msg.id)) {
      const { resolve, reject } = pending.get(msg.id);
      pending.delete(msg.id);
      msg.error ? reject(new Error(`${msg.error.message} (${msg.error.code})`)) : resolve(msg.result);
      return;
    }
    for (const fn of listeners) fn(msg);
  });

  /** One CDP call. `sessionId` scopes it to a tab. */
  const send = (method, params = {}, sessionId) =>
    new Promise((resolve, reject) => {
      const id = nextId++;
      pending.set(id, { resolve, reject });
      ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
    });

  const on = (fn) => { listeners.add(fn); return () => listeners.delete(fn); };

  return {
    send,
    on,
    /** A fresh tab, so one page's state cannot colour the next one's numbers. */
    async newPage() {
      const { targetId } = await send('Target.createTarget', { url: 'about:blank' });
      const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true });
      return {
        sessionId,
        send: (method, params) => send(method, params, sessionId),
        on,
        close: () => send('Target.closeTarget', { targetId }),
      };
    },
    async close() {
      try { ws.close(); } catch { /* already gone */ }
      process.off('exit', killAll);
      killAll();
      await new Promise((r) => setTimeout(r, 300));
    },
  };
}
