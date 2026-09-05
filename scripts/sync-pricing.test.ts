import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';

/**
 * The price-ledger report.
 *
 * `make pricing-report` is how anyone checks what a model costs and whether
 * the oracles agree, and its body used to run on import with the process
 * arguments baked in — so nothing could call it without a terminal.
 *
 * These run the report against the real ledger. It reads and never writes in
 * --report mode, which is the mode worth being able to trust.
 */

import { createTestDb } from '@unturf/unfirehose/test/db-helper';

// The schema refuses to hand a test the live database, which is the guard
// working. An empty ledger is also the more interesting report: it is what a
// fresh install sees.
const db = createTestDb();
vi.mock('@unturf/unfirehose/db/schema', async (original) => ({
  ...(await original<Record<string, unknown>>()),
  getDb: () => db,
}));

const quiet = { log: console.log, error: console.error };
let printed: string[] = [];

beforeAll(() => {
  console.log = (...args: unknown[]) => { printed.push(args.join(' ')); };
  console.error = (...args: unknown[]) => { printed.push(args.join(' ')); };
});

afterAll(() => {
  console.log = quiet.log;
  console.error = quiet.error;
});

const run = async (argv: string[]) => {
  printed = [];
  const { main } = await import('./sync-pricing.ts');
  await main(argv);
  return printed.join('\n');
};

describe('sync-pricing --report', () => {
  it('prints something for a ledger with nothing in it', async () => {
    // A fresh install has no prices yet, and the report still has to answer.
    const out = await run(['--report']);
    expect(out.length).toBeGreaterThan(0);
  });

  it('answers as JSON when asked, and it parses', async () => {
    // The JSON form is what a script reads; a report that prints a table
    // when asked for JSON is a report nothing can consume.
    const out = await run(['--report', '--json']);
    const parsed = JSON.parse(out);
    expect(parsed).toBeTypeOf('object');
    expect(Array.isArray(parsed.books)).toBe(true);
  });

  it('names each oracle it read a book from', async () => {
    const { books } = JSON.parse(await run(['--report', '--json']));
    expect(Array.isArray(books)).toBe(true);
    for (const book of books) {
      expect(book.source).toBeTruthy();
      expect(typeof book.models).toBe('number');
    }
  });

  it('touches no network in report mode', async () => {
    // The whole point of --report: it reads the ledger we already have.
    // Reaching out here would make a read of local state depend on being
    // online.
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    await run(['--report', '--json']);
    expect(fetchSpy).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });
});
