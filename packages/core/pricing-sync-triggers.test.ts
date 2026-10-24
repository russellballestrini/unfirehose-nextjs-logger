// When the worker decides to sync the price book at all: a book that is
// missing or a day old, or a model in recent traffic nobody can price. Both
// are cheap reads that gate a network fetch, so each test injects the feeds
// and checks what was and was not fetched.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { migrate } from './db/migrate.js';
import { syncPricing, catalogAge, syncPricingIfStale, syncIfUnpriced, recentSyncRuns, type UpstreamRow } from './pricing-sync.js';
import { CATALOG_SOURCES, clearPriceCatalogs, catalogStats, resolvePrice, type CatalogSource } from './pricing.js';

const row = (id: string, input: number, output: number): UpstreamRow => ({
  id, name: null, input, output, cacheRead: input / 10, cacheWrite: input * 1.25, contextLen: null, releasedOn: null,
});

let db: Database.Database;
let fetched: CatalogSource[];
const nowS = () => Math.floor(Date.now() / 1000);

/** Every source answers with the same one model, and is recorded as asked. */
const allFeeds = (rows: UpstreamRow[]) => async (source: CatalogSource) => { fetched.push(source); return rows; };

beforeEach(() => {
  db = new Database(':memory:');
  migrate(db);
  clearPriceCatalogs();
  fetched = [];
});
afterEach(() => db.close());

describe('catalogAge', () => {
  it('is null for a source never synced', () => {
    expect(catalogAge('openrouter', db)).toBeNull();
  });

  it('counts seconds since the newest confirmed row', async () => {
    const at = nowS() - 3600;
    await syncPricing(db, { sources: ['openrouter'], fetchUpstream: allFeeds([row('a/m', 1, 2)]), now: () => at });
    const age = catalogAge('openrouter', db)!;
    // Date.now() moves between the sync and the read; allow for a slow box.
    expect(age).toBeGreaterThanOrEqual(3600);
    expect(age).toBeLessThan(3600 + 60);
    expect(catalogAge('modelsdev', db)).toBeNull();
  });

  it('reads a database without the ledger as no age, not as a crash', () => {
    const bare = new Database(':memory:');
    expect(catalogAge('openrouter', bare)).toBeNull();
    bare.close();
  });
});

describe('syncPricingIfStale', () => {
  it('syncs every source when any book is missing', async () => {
    const r = await syncPricingIfStale(86_400, db, { fetchUpstream: allFeeds([row('a/m', 1, 2)]) });
    expect(r).toHaveLength(CATALOG_SOURCES.length);
    expect(fetched.sort()).toEqual([...CATALOG_SOURCES].sort());
  });

  it('only hydrates, fetching nothing, when every book is fresh', async () => {
    await syncPricing(db, { fetchUpstream: allFeeds([row('vendor/fresh-model', 3, 15)]), now: nowS });
    clearPriceCatalogs();
    fetched = [];
    expect(await syncPricingIfStale(86_400, db, { fetchUpstream: allFeeds([]) })).toBeNull();
    expect(fetched).toEqual([]);
    // Hydrated from the ledger: the price resolves without any fetch.
    expect(resolvePrice('vendor/fresh-model')).toMatchObject({ input: 3, output: 15 });
  });

  it('syncs again once a book is older than the limit', async () => {
    const old = nowS() - 2 * 86_400;
    await syncPricing(db, { fetchUpstream: allFeeds([row('a/m', 1, 2)]), now: () => old });
    fetched = [];
    expect(await syncPricingIfStale(86_400, db, { fetchUpstream: allFeeds([row('a/m', 1, 2)]) })).not.toBeNull();
    expect(fetched).toHaveLength(CATALOG_SOURCES.length);
  });
});

describe('syncIfUnpriced', () => {
  // The throttle is process-wide, so this block runs its cases in order.
  it('does nothing when every recent model is priced or there is no traffic', async () => {
    expect(await syncIfUnpriced(db, 60_000, { fetchUpstream: allFeeds([]) })).toBeNull();
    expect(fetched).toEqual([]);
  });

  it('syncs, as trigger "unpriced", when recent traffic names a model no book carries; then holds the throttle', async () => {
    const pid = db.prepare("INSERT INTO projects (name, display_name) VALUES ('p', 'p')").run().lastInsertRowid;
    const sid = db.prepare("INSERT INTO sessions (session_uuid, project_id) VALUES ('s', ?)").run(pid).lastInsertRowid;
    db.prepare('INSERT INTO messages (session_id, type, timestamp, model, input_tokens, output_tokens) VALUES (?, ?, ?, ?, ?, ?)')
      .run(sid, 'assistant', new Date().toISOString(), 'brand-new-model-x', 500, 50);

    const r = await syncIfUnpriced(db, 60 * 60_000, { sources: ['openrouter'], fetchUpstream: allFeeds([row('other/model', 1, 2)]) });
    expect(r?.unpriced.map((u) => u.model)).toEqual(['brand-new-model-x']);
    expect(r?.unpriced[0].tokens).toBe(550);
    expect(r?.results).toHaveLength(1);
    expect(recentSyncRuns(db)[0]).toMatchObject({ source: 'openrouter', trigger: 'unpriced' });

    // Still unpriced (the feed did not carry it), but inside the interval:
    // no second fetch, so a model nobody lists cannot become a fetch storm.
    fetched = [];
    expect(await syncIfUnpriced(db, 60 * 60_000, { sources: ['openrouter'], fetchUpstream: allFeeds([]) })).toBeNull();
    expect(fetched).toEqual([]);
  });
});

describe('catalogStats', () => {
  it('counts models per source and stamps each with its newest fetch', async () => {
    expect(catalogStats().openrouter).toEqual({ models: 0, fetchedAt: null });
    await syncPricing(db, { sources: ['openrouter'], fetchUpstream: allFeeds([row('a/one', 1, 2), row('a/two', 1, 2)]), now: () => 1_000 });
    await syncPricing(db, { sources: ['openrouter'], fetchUpstream: allFeeds([row('a/one', 1, 2), row('a/two', 1, 2), row('a/three', 1, 2)]), now: () => 2_000 });
    const stats = catalogStats();
    expect(stats.openrouter.models).toBe(3);
    expect(stats.openrouter.fetchedAt).not.toBeNull();
    expect(stats.modelsdev).toEqual({ models: 0, fetchedAt: null });
    expect(Object.keys(stats).sort()).toEqual([...CATALOG_SOURCES].sort());
  });
});
