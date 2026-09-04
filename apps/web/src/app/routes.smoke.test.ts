import { describe, it, expect, vi } from 'vitest';
import { createTestDb } from '@unturf/unfirehose/test/db-helper';

/**
 * Every route module loads, and exports something Next.js can call.
 *
 * Same reasoning as pages.smoke.test.tsx: most of these seventy-five files
 * have no test of their own, so a broken import or a module-level throw
 * reaches production as a 500 on one endpoint while every suite stays green.
 *
 * A route file that exports no HTTP method is dead weight — Next.js will
 * route to it and answer 405 — so that is worth asserting too.
 */

const db = createTestDb();
vi.mock('@unturf/unfirehose/db/schema', async (original) => ({
  ...(await original() as object),
  getDb: () => db,
}));

const METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'];

const routes = import.meta.glob('./**/route.ts');

describe('every route module', () => {
  it('finds all of them, so this test cannot quietly cover nothing', () => {
    expect(Object.keys(routes).length).toBeGreaterThanOrEqual(70);
  });

  for (const [path, load] of Object.entries(routes)) {
    it(`loads ${path.replace('./', '')}`, async () => {
      const mod = (await load()) as Record<string, unknown>;
      const handlers = METHODS.filter((m) => typeof mod[m] === 'function');
      expect(handlers.length).toBeGreaterThan(0);
    });
  }
});
