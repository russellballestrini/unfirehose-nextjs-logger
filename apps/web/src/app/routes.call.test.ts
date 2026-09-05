/// <reference types="vite/client" />
import { describe, it, expect, vi } from 'vitest';
import { createTestDb } from '@unturf/unfirehose/test/db-helper';

/**
 * Every GET handler answers, against a database with the real schema.
 *
 * routes.smoke proves a route module loads and exports a method. This calls
 * it. Most of these routes have no test of their own, so until now the first
 * thing to run their SQL was a browser — and a query that references a
 * column the migration renamed fails there as a 500 on one endpoint while
 * every suite stays green.
 *
 * The database is empty on purpose: the empty result is the case a route is
 * least likely to have been tried against, and the one that produces
 * `undefined.map` and `n.toFixed()` on nothing.
 *
 * A handler that reaches the network, spawns a process or streams is skipped
 * by name — those are not answering from our data, and mocking each would
 * be writing the route twice.
 */

const db = createTestDb();
vi.mock('@unturf/unfirehose/db/schema', async (original) => ({
  ...(await original<Record<string, unknown>>()),
  getDb: () => db,
}));

vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
  ok: true, status: 200, json: async () => ({}), text: async () => '',
}));

/** Routes whose work is a network call, a spawn, or an open stream. */
const OUTBOUND = [
  './api/mesh/route.ts',              // SSH probes across the fleet
  './api/mesh/node/route.ts',
  './api/tmux/stream/route.ts',       // server-sent events, never returns
  './api/unsandbox/shell/route.ts',
  './api/boot/route.ts',              // spawns tmux
  './api/boot/mega/route.ts',
  './api/boot/finished/route.ts',
  './api/harness/verify/route.ts',    // ssh
  './api/projects/[project]/agent/route.ts',
];

const routes = Object.entries(import.meta.glob('./api/**/route.ts'))
  .filter(([path]) => !OUTBOUND.includes(path));

/** `./api/todos/[id]/route.ts` is a module path, not a URL. */
const urlFor = (modulePath: string) =>
  'http://localhost:3000' +
  modulePath.replace(/^\./, '').replace(/\/route\.ts$/, '').replace(/\[[^\]]+\]/g, 'demo');

const request = (path: string) => ({
  url: urlFor(path),
  nextUrl: new URL(urlFor(path)),
  headers: new Headers(),
  json: async () => ({}),
  text: async () => '',
}) as never;

/** Next 15 hands params in as a promise; the values are per-route noise. */
const context = {
  params: Promise.resolve({
    project: '-home-fox-git-demo', session: '0', id: '1', hash: 'a'.repeat(64),
    node: 'localhost', sessionId: 's1', slug: 'demo', name: 'demo',
  }),
};

describe('every GET handler answers on an empty database', () => {
  it('finds the routes, so this cannot quietly cover nothing', () => {
    expect(routes.length).toBeGreaterThanOrEqual(60);
  });

  for (const [path, load] of routes) {
    it(`GET ${path.replace('./api', '').replace('/route.ts', '')}`, async () => {
      const mod = (await load()) as { GET?: (req: never, ctx: never) => Promise<Response> };
      if (typeof mod.GET !== 'function') return;

      const res = await mod.GET(request(path), context as never);

      // Any answer is fine, including a 4xx or a 500 body it chose to send.
      // What must not happen is a throw, which reaches a browser as a blank
      // page rather than as a message.
      expect(res).toBeTruthy();
      expect(typeof res.status).toBe('number');
    });
  }
});
