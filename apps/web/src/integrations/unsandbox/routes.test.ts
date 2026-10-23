import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

/**
 * Our unsandbox routes behind their switch.
 *
 * Off — the default — every method on every route is a 404 that names the
 * integration and how to turn it on, and nothing is signed or sent. On, the
 * wrapper hands the request to the same handler as before: with no keys
 * stored that handler says so itself rather than reaching the network.
 */

const settings: Record<string, string | null> = {};
vi.mock('@unturf/unfirehose/db/ingest', () => ({
  getSetting: (k: string) => settings[k] ?? null,
  setSetting: (k: string, v: string) => { settings[k] = v; },
}));

const proxy = await import('@/app/api/unsandbox/route');
const shell = await import('@/app/api/unsandbox/shell/route');
const sync = await import('@/app/api/unsandbox/sync/route');

const req = (url: string, method = 'GET', body: unknown = {}) => ({
  url, method,
  nextUrl: new URL(url),
  headers: new Headers(),
  json: async () => body,
}) as never;

const calls = [
  ['GET /api/unsandbox', () => proxy.GET(req('http://localhost/api/unsandbox'))],
  ['POST /api/unsandbox', () => proxy.POST(req('http://localhost/api/unsandbox', 'POST', { action: 'test' }))],
  ['GET /api/unsandbox/shell', () => shell.GET(req('http://localhost/api/unsandbox/shell?session_id=s1'))],
  ['POST /api/unsandbox/shell', () => shell.POST(req('http://localhost/api/unsandbox/shell', 'POST', { session_id: 's1', keys: 'x' }))],
  ['HEAD /api/unsandbox/shell', () => shell.HEAD(req('http://localhost/api/unsandbox/shell?session_id=s1', 'HEAD'))],
  ['GET /api/unsandbox/sync', () => sync.GET()],
  ['POST /api/unsandbox/sync', () => sync.POST(req('http://localhost/api/unsandbox/sync', 'POST'))],
] as const;

let fetchSpy: ReturnType<typeof vi.fn>;
const savedEnv = process.env.UNFIREHOSE_INTEGRATIONS;

beforeEach(() => {
  for (const k of Object.keys(settings)) delete settings[k];
  delete process.env.UNFIREHOSE_INTEGRATIONS;
  fetchSpy = vi.fn(async () => { throw new Error('no network in a test'); });
  vi.stubGlobal('fetch', fetchSpy);
});
afterEach(() => {
  vi.unstubAllGlobals();
  if (savedEnv === undefined) delete process.env.UNFIREHOSE_INTEGRATIONS;
  else process.env.UNFIREHOSE_INTEGRATIONS = savedEnv;
});

describe('unsandbox routes, off (the default)', () => {
  for (const [name, call] of calls) {
    it(`${name} is not there`, async () => {
      // Keys being stored does not turn it on; the switch does.
      settings.unsandbox_public_key = 'pk_test';
      settings.unsandbox_secret_key = 'sk_test';
      const res = await call();
      expect(res.status).toBe(404);
      if (!name.startsWith('HEAD')) {
        const body = await res.json();
        expect(body.integration).toBe('unsandbox');
        expect(body.detail).toMatch(/Settings → Integrations/);
      }
      expect(fetchSpy).not.toHaveBeenCalled();
    });
  }

  it('stays off when the environment lists other integrations only', async () => {
    settings.integration_unsandbox = 'true';
    process.env.UNFIREHOSE_INTEGRATIONS = 'none';
    expect((await proxy.GET(req('http://localhost/api/unsandbox'))).status).toBe(404);
  });
});

describe('unsandbox routes, on', () => {
  it('answers from its own handler when the setting turns it on', async () => {
    settings.integration_unsandbox = 'true';
    const res = await proxy.GET(req('http://localhost/api/unsandbox'));
    expect(res.status).not.toBe(404);
    // No keys stored: the handler reports that instead of calling out.
    expect((await res.json()).connected).toBe(false);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('answers when the environment turns it on, whatever the setting says', async () => {
    settings.integration_unsandbox = 'false';
    process.env.UNFIREHOSE_INTEGRATIONS = 'unsandbox';
    const res = await sync.GET();
    expect(res.status).not.toBe(404);
  });
});
