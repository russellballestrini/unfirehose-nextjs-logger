import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

/**
 * Typing into a container's shell from a browser.
 *
 * Every keystroke on our terminal page becomes one of these, and what goes
 * down the socket is raw bytes to a root shell inside a container. So the
 * boundary is the point: a session id is matched against a pattern before
 * it reaches a URL, a special key must be one of a fixed set rather than
 * an arbitrary escape sequence, and a paste is bounded.
 *
 * The socket is mocked. Key material is fabricated.
 */

const settings: Record<string, string> = {};
vi.mock('@unturf/unfirehose/db/ingest', () => ({ getSetting: (k: string) => settings[k] ?? null }));

/** What the route sent down the socket, in order. */
let frames: Array<string | Buffer>;
let readyState: number;

class FakeSocket {
  static OPEN = 1; static CONNECTING = 0; static CLOSED = 3;
  readyState = readyState;
  send(data: string | Buffer) { frames.push(data); }
  once(ev: string, cb: (e?: unknown) => void) { if (ev === 'open' && this.readyState === 1) cb(); }
  on() {} close() {} removeAllListeners() {}
}
vi.mock('ws', () => ({ default: Object.assign(FakeSocket, { OPEN: 1, CONNECTING: 0, CLOSED: 3 }) }));

const { POST, HEAD } = await import('./route');

let fetched: string[];
let sessions: unknown[];

beforeEach(() => {
  frames = []; fetched = []; readyState = 1;
  sessions = [];
  for (const k of Object.keys(settings)) delete settings[k];
  settings.unsandbox_public_key = 'pk_test';
  settings.unsandbox_secret_key = 'sk_test';
  vi.stubGlobal('fetch', async (url: string) => {
    fetched.push(url.replace('https://api.unsandbox.com', ''));
    return { ok: true, status: 200, json: async () => ({ sessions }) };
  });
});
afterEach(() => vi.unstubAllGlobals());

const post = (body: unknown) => POST({ json: async () => body } as never);
const sent = () => frames.map(f => (Buffer.isBuffer(f) ? f.toString('binary') : f));

describe('POST /api/unsandbox/shell', () => {
  it('refuses before a key is configured', async () => {
    delete settings.unsandbox_secret_key;
    expect((await post({ session_id: 'abc', keys: 'ls' })).status).toBe(400);
  });

  it('refuses a session id that is not one', async () => {
    // It goes into a URL and a signed path. Anything with a slash or a
    // space in it is not a session, whatever else it might be.
    for (const session_id of ['', '../../sessions', 'a b', 'a/b', 42]) {
      expect((await post({ session_id, keys: 'ls' })).status).toBe(400);
    }
    expect(frames).toEqual([]);
  });

  it('sends typed characters as utf-8 bytes', async () => {
    expect(await (await post({ session_id: 'sess1', keys: 'ls -la' })).json()).toEqual({ ok: true });
    expect(sent()).toEqual(['ls -la']);
  });

  it('bounds a paste rather than pushing it all at a shell', async () => {
    // A stray paste of a whole file is otherwise one frame the container
    // has to consume before anything else is read.
    const res = await post({ session_id: 'sess1', keys: 'x'.repeat(5000) });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe('input too long');
    expect(frames).toEqual([]);
  });

  it('turns a named key into its escape sequence', async () => {
    await post({ session_id: 'sess1', special: 'C-c' });
    await post({ session_id: 'sess1', special: 'Up' });
    expect(sent()).toEqual(['\x03', '\x1b[A']);
  });

  it('refuses a key that is not on the list', async () => {
    // The alternative is forwarding an arbitrary escape sequence, which is
    // a terminal control channel, not a keystroke.
    const res = await post({ session_id: 'sess1', special: '\x1b]0;title\x07' });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe('key not allowed');
    expect(frames).toEqual([]);
  });

  it('refuses a request that says nothing to do', async () => {
    expect((await post({ session_id: 'sess1' })).status).toBe(400);
  });

  it('resizes within bounds the far end can hold', async () => {
    await post({ session_id: 'sess1', action: 'resize', cols: 120, rows: 40 });
    expect(JSON.parse(sent()[0])).toEqual({ type: 'resize', cols: 120, rows: 40 });
  });

  it('clamps a resize instead of forwarding a nonsense geometry', async () => {
    // A zero-column terminal is not a small one, it is a broken one, and
    // the container has no reason to be told about it.
    await post({ session_id: 'sess1', action: 'resize', cols: 0, rows: 100_000 });
    expect(JSON.parse(sent()[0])).toEqual({ type: 'resize', cols: 40, rows: 200 });
  });

  it('refuses a resize with no geometry', async () => {
    expect((await post({ session_id: 'sess1', action: 'resize' })).status).toBe(400);
  });

  it('looks a service up in the session list before using it as a session', async () => {
    sessions = [{ session_id: 'real-session-id', service_id: 'unsb-service-abc' }];
    await post({ session_id: 'unsb-service-abc', keys: 'ls' });
    expect(fetched).toContain('/sessions');
    expect(sent()).toEqual(['ls']);
  });

  it('falls back to the service id when the lookup finds nothing', async () => {
    // The portal's own convention is that they are the same. Failing here
    // would break every service terminal whenever the list call did.
    sessions = [];
    await post({ session_id: 'unsb-service-abc', keys: 'ls' });
    expect(sent()).toEqual(['ls']);
  });

  it('does not look up a plain session id', async () => {
    await post({ session_id: 'sess1', keys: 'ls' });
    expect(fetched).toEqual([]);
  });

  it('says the shell is not connected rather than dropping the keystroke', async () => {
    // A fresh id, because an open socket is cached per session — which is
    // the point of the cache, and why this needs one it has never seen.
    readyState = 3;
    const res = await post({ session_id: 'sessClosed', keys: 'ls' });
    expect(res.status).toBe(503);
    expect(frames).toEqual([]);
  });
});

describe('HEAD', () => {
  it('answers, so a page can check the route is alive', async () => {
    expect(await (await HEAD({} as never)).json()).toEqual({ ok: true });
  });
});
