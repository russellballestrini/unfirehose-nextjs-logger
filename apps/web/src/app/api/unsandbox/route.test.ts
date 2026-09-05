import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

/**
 * Our signed proxy to the unsandbox API.
 *
 * Everything the Permacomputer page does to a container goes through here,
 * and every request is HMAC-signed with a key held in settings. The two
 * things worth pinning are that the signature covers what it should — a
 * signature over the wrong body is rejected by the server as if the key
 * were wrong, which sends someone to rotate a perfectly good key — and
 * that an unknown action is refused rather than forwarded.
 *
 * Key material below is fabricated. The signature is checked for shape and
 * for what it covers, never against a real secret.
 */

const settings: Record<string, string> = {};
vi.mock('@unturf/unfirehose/db/ingest', () => ({
  getSetting: (k: string) => settings[k] ?? null, setSetting: vi.fn(),
}));
vi.mock('fs/promises', () => ({ readFile: async () => { throw new Error('ENOENT'); }, stat: async () => { throw new Error('ENOENT'); } }));

const { GET, POST } = await import('./route');

/** Every outbound request, with the headers the route signed it with. */
let sent: Array<{ path: string; method: string; body?: string; headers: Record<string, string> }>;
let answer: (path: string) => { ok?: boolean; status?: number; body: unknown };

beforeEach(() => {
  sent = [];
  for (const k of Object.keys(settings)) delete settings[k];
  settings.unsandbox_public_key = 'pk_test';
  settings.unsandbox_secret_key = 'sk_test';
  answer = () => ({ body: { tier: 'free', sessions: [], services: [] } });
  vi.stubGlobal('fetch', async (url: string, init: RequestInit = {}) => {
    const path = url.replace('https://api.unsandbox.com', '');
    sent.push({
      path, method: (init.method ?? 'GET') as string,
      body: init.body as string | undefined,
      headers: (init.headers ?? {}) as Record<string, string>,
    });
    const a = answer(path);
    return { ok: a.ok ?? true, status: a.status ?? 200, json: async () => a.body, text: async () => JSON.stringify(a.body) };
  });
});
afterEach(() => vi.unstubAllGlobals());

const get = (action?: string) =>
  GET({ nextUrl: { searchParams: new URLSearchParams(action ? { action } : {}) } } as never);
const post = (body: unknown) => POST({ json: async () => body } as never);

describe('signing', () => {
  it('signs every request with the public key and a timestamp', async () => {
    await get('sessions');
    const h = sent[0].headers;
    expect(h['Authorization']).toBe('Bearer pk_test');
    expect(h['X-Signature']).toMatch(/^[0-9a-f]{64}$/);
    expect(h['X-Timestamp']).toMatch(/^\d{10}$/);
  });

  it('signs a different path differently', async () => {
    // The path is in the signed string, so a signature reused across
    // endpoints is rejected as if the key were stale.
    await get('sessions');
    await get('services');
    expect(sent[0].headers['X-Signature']).not.toBe(sent[1].headers['X-Signature']);
  });

  it('signs the body it actually sends', async () => {
    await post({ action: 'execute', language: 'python', code: 'print(1)' });
    const [first] = sent;
    expect(first.method).toBe('POST');
    expect(first.body).toBeTruthy();
  });
});

describe('GET', () => {
  it('reports not connected, rather than an error, before any key is set', async () => {
    // This is a fresh install, not a fault. An error banner here is the
    // first thing a new user sees.
    delete settings.unsandbox_public_key;
    const body = await (await get()).json();
    expect(body).toMatchObject({ connected: false });
    expect(sent).toEqual([]);
  });

  it('lists sessions', async () => {
    answer = () => ({ body: { sessions: [{ id: 's1' }] } });
    expect((await (await get('sessions')).json()).sessions).toEqual([{ id: 's1' }]);
  });

  it('takes a bare array as the list, since the API answers both ways', async () => {
    answer = () => ({ body: [{ id: 's1' }] });
    expect((await (await get('sessions')).json()).sessions).toEqual([{ id: 's1' }]);
  });

  it('answers with an empty list and the error when the API is unreachable', async () => {
    // The page maps over this. Returning only an error crashes the render
    // that was supposed to display it.
    vi.stubGlobal('fetch', async () => { throw new Error('ECONNREFUSED'); });
    const body = await (await get('services')).json();
    expect(body.services).toEqual([]);
    expect(body.error).toMatch(/ECONNREFUSED/);
  });

  it('reports key status by default', async () => {
    answer = () => ({ body: { tier: 'builder', rate_limit: 60, concurrency: 4 } });
    expect(await (await get()).json()).toMatchObject({ connected: true, tier: 'builder' });
  });
});

describe('POST', () => {
  it('refuses an action it does not have', async () => {
    const res = await post({ action: 'rm -rf' });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe('Unknown action');
    expect(sent).toEqual([]);
  });

  it('refuses every action before a key is set', async () => {
    delete settings.unsandbox_secret_key;
    expect((await post({ action: 'test' })).status).toBe(400);
  });

  it('tests a key and reports its tier', async () => {
    answer = () => ({ body: { tier: 'builder' } });
    expect(await (await post({ action: 'test' })).json()).toEqual({ ok: true, tier: 'builder' });
    expect(sent[0].path).toBe('/keys/self');
  });

  it('says a rejected signature is probably a stale key, not a broken server', async () => {
    // 401 from a signing proxy has one likely cause, and saying so is the
    // difference between a re-paste and an afternoon.
    answer = () => ({ ok: false, status: 401, body: {} });
    const body = await (await post({ action: 'test' })).json();
    expect(body.ok).toBe(false);
    expect(body.error).toMatch(/stale secret key/);
  });

  it('names clock skew when the server rejects our timestamp', async () => {
    // Every signature includes a timestamp, so a machine with a wrong
    // clock fails every request and looks exactly like a bad key.
    vi.stubGlobal('fetch', async () => { throw new Error('invalid_timestamp'); });
    expect((await (await post({ action: 'test' })).json()).error).toMatch(/clock skew/);
  });

  it('passes an ordinary error through without inventing a cause', async () => {
    vi.stubGlobal('fetch', async () => { throw new Error('ECONNRESET'); });
    const body = await (await post({ action: 'test' })).json();
    expect(body.error).toContain('ECONNRESET');
    expect(body.error).not.toMatch(/stale|skew/);
  });
});

/**
 * Every action the proxy forwards.
 *
 * These were twelve if-blocks in one function until they became a table,
 * and each one names a different endpoint with a different verb. A wrong
 * verb or a wrong path is rejected by the server as a signature failure —
 * the signed string includes both — which sends somebody to rotate a key
 * that was never the problem. So what each action sends is the whole test.
 *
 * Several of them destroy things. Redeploy tears a container down and
 * builds it again; destroy-service removes one for good.
 */
describe('every action', () => {
  const call = async (body: Record<string, unknown>) => {
    const res = await post(body);
    return { status: res.status, body: await res.json(), sent: sent[0] };
  };

  it('refuses each action that needs an id without one', async () => {
    // The id goes into the path. Without it the request is signed for
    // /services/undefined and rejected as a bad signature.
    for (const action of [
      'kill-session', 'destroy-service', 'service-info',
      'service-logs', 'service-wake', 'service-redeploy',
    ]) {
      const r = await call({ action });
      expect(r.status, action).toBe(400);
      expect(sent, action).toEqual([]);
    }
    expect((await call({ action: 'session-exec', sessionId: 's1' })).status).toBe(400);
  });

  it('runs one-shot code through /execute', async () => {
    const r = await call({ action: 'execute', language: 'python', code: 'print(1)' });
    expect(r.sent).toMatchObject({ path: '/execute', method: 'POST' });
  });

  it('opens a session through /sessions', async () => {
    const r = await call({ action: 'session', shell: 'bash', network: 'semitrusted' });
    expect(r.sent).toMatchObject({ path: '/sessions', method: 'POST' });
  });

  it('passes on why a session could not be opened, with its status', async () => {
    // Concurrency and tier limits both come back here, and both are
    // things a person can act on.
    answer = () => ({ ok: false, status: 429, body: { error: 'concurrency limit reached' } });
    const r = await call({ action: 'session' });
    expect(r.status).toBe(429);
    expect(r.body.error).toBe('concurrency limit reached');
  });

  it('kills a session with DELETE, not by posting to it', async () => {
    const r = await call({ action: 'kill-session', sessionId: 'sess-1' });
    expect(r.sent).toMatchObject({ path: '/sessions/sess-1', method: 'DELETE' });
  });

  it('destroys a service with DELETE too', async () => {
    const r = await call({ action: 'destroy-service', serviceId: 'svc-1' });
    expect(r.sent).toMatchObject({ path: '/services/svc-1', method: 'DELETE' });
  });

  it('reads a service, its logs, and wakes or redeploys it, each at its own path', async () => {
    // wake and redeploy are different verbs on purpose: waking a
    // container that never started returns it to the same broken state.
    for (const [action, path, method] of [
      ['service-info', '/services/svc-1', 'GET'],
      ['service-logs', '/services/svc-1/logs', 'GET'],
      ['service-wake', '/services/svc-1/wake', 'POST'],
      ['service-redeploy', '/services/svc-1/redeploy', 'POST'],
    ] as const) {
      sent = [];
      const r = await call({ action, serviceId: 'svc-1' });
      expect(r.sent, action).toMatchObject({ path, method });
    }
  });

  it('runs a command inside a session it names', async () => {
    const r = await call({ action: 'session-exec', sessionId: 'sess-1', command: 'ls' });
    expect(r.sent.path).toContain('/sessions/sess-1');
    expect(r.sent.method).toBe('POST');
  });

  it('creates a service with the ports and network it was given', async () => {
    const r = await call({
      action: 'create-service', name: 'uncloseai', ports: [8080],
      network: 'semitrusted', bootstrap: 'echo hi',
    });
    expect(r.sent.path).toBe('/services');
    expect(JSON.parse(r.sent.body!)).toMatchObject({ network: 'semitrusted' });
  });

  it('suffixes a service name with a hash of the key that made it', () => {
    // Service names are global. Two people asking for 'uncloseai' would
    // otherwise collide, and the second would get the first's container.
    return call({ action: 'create-service', name: 'uncloseai', ports: [8080] }).then(r => {
      expect(JSON.parse(r.sent.body!).name).toMatch(/^uncloseai-[0-9a-f]{8}$/);
    });
  });

  it('names an unnamed service after the key alone', async () => {
    const r = await call({ action: 'create-service', ports: [8080] });
    expect(JSON.parse(r.sent.body!).name).toMatch(/^service-[0-9a-f]{8}$/);
  });

  it('reports a network failure per action rather than throwing', async () => {
    // Every one of these is a button on the Permacomputer page.
    vi.stubGlobal('fetch', async () => { throw new Error('ECONNREFUSED'); });
    for (const [action, extra] of [
      ['execute', { code: 'x' }], ['session', {}],
      ['kill-session', { sessionId: 's' }], ['destroy-service', { serviceId: 's' }],
      ['service-info', { serviceId: 's' }], ['service-logs', { serviceId: 's' }],
      ['service-wake', { serviceId: 's' }], ['service-redeploy', { serviceId: 's' }],
      ['session-exec', { sessionId: 's', command: 'ls' }],
    ] as const) {
      const res = await post({ action, ...extra });
      expect(res.status, action).toBe(500);
      expect((await res.json()).error, action).toMatch(/ECONNREFUSED/);
    }
  });
});
