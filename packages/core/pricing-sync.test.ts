// The ledger is a checkbook. These tests prove the properties a checkbook
// has and an upsert table does not: nothing is erased, every attempt is on
// the register, and the balance at a past date is reproducible.
//
// No network. Feeds are injected; the clock is injected; the DB is in memory.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { migrate } from './db/migrate.js';
import {
  syncPricing,
  hydratePricing,
  parseCatalog,
  unpricedModels,
  recentSyncRuns,
  recentPriceChanges,
  priceHistory,
  type UpstreamRow,
} from './pricing-sync.js';
import {
  clearPriceCatalogs,
  resolvePrice,
  costForUsage,
  priceConsensus,
  historySize,
  type CatalogSource,
} from './pricing.js';

const row = (id: string, input: number, output: number, extra: Partial<UpstreamRow> = {}): UpstreamRow => ({
  id, name: null, input, output, cacheRead: input / 10, cacheWrite: input * 1.25,
  contextLen: null, releasedOn: null, ...extra,
});

/** A fake set of feeds. Only the sources listed respond; the rest throw. */
function feeds(map: Partial<Record<CatalogSource, UpstreamRow[] | Error>>) {
  return async (source: CatalogSource): Promise<UpstreamRow[]> => {
    const v = map[source];
    if (v === undefined) throw new Error(`HTTP 503 (${source} offline)`);
    if (v instanceof Error) throw v;
    return v;
  };
}

let db: Database.Database;
let t = 1_000_000; // unix seconds, advanced between runs
const clock = () => t;

beforeEach(() => {
  db = new Database(':memory:');
  migrate(db);
  clearPriceCatalogs();
  t = 1_000_000;
});
afterEach(() => db.close());

describe('the ledger never erases', () => {
  it('opens one row per new id, then only stamps it when the price holds', async () => {
    const or = [row('anthropic/claude-fable-5.1', 10, 50)];
    const r1 = await syncPricing(db, { sources: ['openrouter'], fetchUpstream: feeds({ openrouter: or }), now: clock, trigger: 'make' });
    expect(r1[0]).toMatchObject({ ok: true, models: 1, added: 1, changed: 0, unchanged: 0 });

    t += 86_400;
    const r2 = await syncPricing(db, { sources: ['openrouter'], fetchUpstream: feeds({ openrouter: or }), now: clock });
    expect(r2[0]).toMatchObject({ ok: true, added: 0, changed: 0, unchanged: 1 });

    const rows = priceHistory('anthropic/claude-fable-5.1', db);
    expect(rows).toHaveLength(1);
    expect(rows[0].effective_from).toBe(1_000_000);
    expect(rows[0].last_seen_at).toBe(1_086_400); // "still true on this date"
    expect(rows[0].effective_to).toBeNull();
  });

  it('closes the old row and opens a new one when the price moves', async () => {
    await syncPricing(db, { sources: ['openrouter'], fetchUpstream: feeds({ openrouter: [row('anthropic/claude-opus-5', 5, 25)] }), now: clock });
    t += 86_400 * 30;
    const r = await syncPricing(db, { sources: ['openrouter'], fetchUpstream: feeds({ openrouter: [row('anthropic/claude-opus-5', 4, 20)] }), now: clock });
    expect(r[0]).toMatchObject({ changed: 1, added: 0 });
    expect(r[0].changes[0]).toMatchObject({ modelId: 'anthropic/claude-opus-5', from: { input: 5, output: 25 }, to: { input: 4, output: 20 } });

    const rows = priceHistory('anthropic/claude-opus-5', db);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ input: 5, effective_from: 1_000_000, effective_to: 1_000_000 + 86_400 * 30 });
    expect(rows[1]).toMatchObject({ input: 4, effective_from: 1_000_000 + 86_400 * 30, effective_to: null });

    // The test clock lives in 1970; a window wide enough to reach it.
    const changes = recentPriceChanges(db, 100 * 365 * 86_400);
    expect(changes).toHaveLength(1);
    expect(changes[0]).toMatchObject({ prev_input: 5, input: 4 });
  });

  it('treats a float printed two ways as the same entry', async () => {
    await syncPricing(db, { sources: ['openrouter'], fetchUpstream: feeds({ openrouter: [row('x/y', 0.00001 * 1e6, 0.00005 * 1e6)] }), now: clock });
    t += 60;
    const r = await syncPricing(db, { sources: ['openrouter'], fetchUpstream: feeds({ openrouter: [row('x/y', 10.000000000001, 50)] }), now: clock });
    expect(r[0]).toMatchObject({ changed: 0, unchanged: 1 });
  });

  it('stamps a vanished id delisted but keeps its price in force', async () => {
    await syncPricing(db, { sources: ['openrouter'], fetchUpstream: feeds({ openrouter: [row('stealth/ox-alpha', 0, 0), row('z-ai/glm-5.3-flash', 0.075, 0.25)] }), now: clock });
    t += 3600;
    const r = await syncPricing(db, { sources: ['openrouter'], fetchUpstream: feeds({ openrouter: [row('z-ai/glm-5.3-flash', 0.075, 0.25)] }), now: clock });
    expect(r[0]).toMatchObject({ delisted: 1 });
    const rows = priceHistory('stealth/ox-alpha', db);
    expect(rows[0].delisted_at).toBe(1_003_600);
    expect(rows[0].effective_to).toBeNull();
    // Delisting twice is one event, not two.
    t += 3600;
    const r2 = await syncPricing(db, { sources: ['openrouter'], fetchUpstream: feeds({ openrouter: [row('z-ai/glm-5.3-flash', 0.075, 0.25)] }), now: clock });
    expect(r2[0].delisted).toBe(0);
  });
});

describe('the register records every attempt', () => {
  it('writes a failed row when a feed is down and leaves its book untouched', async () => {
    await syncPricing(db, { sources: ['openrouter'], fetchUpstream: feeds({ openrouter: [row('anthropic/claude-opus-5', 5, 25)] }), now: clock });
    t += 86_400;
    const r = await syncPricing(db, { sources: ['openrouter', 'nous'], fetchUpstream: feeds({ nous: [row('anthropic/claude-opus-5', 4, 20)] }), now: clock, trigger: 'worker' });
    expect(r.find((x) => x.source === 'openrouter')).toMatchObject({ ok: false, error: 'HTTP 503 (openrouter offline)' });
    expect(r.find((x) => x.source === 'nous')).toMatchObject({ ok: true, added: 1 });

    const runs = recentSyncRuns(db);
    expect(runs).toHaveLength(3);
    const failed = runs.find((x) => !x.ok)!;
    expect(failed).toMatchObject({ source: 'openrouter', trigger: 'worker', error: 'HTTP 503 (openrouter offline)', started_at: 1_086_400 });
    expect(failed.finished_at).toBe(1_086_400);

    // The OpenRouter book still says $5 — stale beats zero.
    expect(resolvePrice('claude-opus-5', ['openrouter'])).toMatchObject({ input: 5, source: 'openrouter' });
  });

  it('records an empty catalog as a failure, not as "everything delisted"', async () => {
    await syncPricing(db, { sources: ['openrouter'], fetchUpstream: feeds({ openrouter: [row('a/b', 1, 2)] }), now: clock });
    const r = await syncPricing(db, { sources: ['openrouter'], fetchUpstream: feeds({ openrouter: [] }), now: clock });
    expect(r[0]).toMatchObject({ ok: false, error: 'empty catalog', delisted: 0 });
    expect(priceHistory('a/b', db)[0].delisted_at).toBeNull();
  });
});

describe('cost is booked at the price in force', () => {
  it('bills June tokens at the June price after a September change', async () => {
    const june = Date.UTC(2026, 5, 15) / 1000;
    const sept = Date.UTC(2026, 8, 1) / 1000;
    t = june;
    await syncPricing(db, { sources: ['openrouter'], fetchUpstream: feeds({ openrouter: [row('anthropic/claude-opus-5', 5, 25)] }), now: clock });
    t = sept;
    await syncPricing(db, { sources: ['openrouter'], fetchUpstream: feeds({ openrouter: [row('anthropic/claude-opus-5', 10, 50)] }), now: clock });

    const tokens = { model: 'claude-opus-5', input: 1_000_000, output: 0, cacheRead: 0, cacheWrite: 0 };
    expect(costForUsage({ ...tokens, at: '2026-07-01' }).total).toBe(5);
    expect(costForUsage({ ...tokens, at: '2026-09-02T00:00:00Z' }).total).toBe(10);
    expect(costForUsage({ ...tokens }).total).toBe(10); // no `at` = today's price
    expect(costForUsage({ ...tokens, at: '2026-07-01' }).backdated).toBe(false);
  });

  it('flags a date before the book opened as backdated, and uses the earliest price', async () => {
    t = Date.UTC(2026, 8, 1) / 1000;
    await syncPricing(db, { sources: ['openrouter'], fetchUpstream: feeds({ openrouter: [row('anthropic/claude-opus-5', 5, 25)] }), now: clock });
    const c = costForUsage({ model: 'claude-opus-5', input: 1_000_000, at: '2026-01-01' });
    expect(c.total).toBe(5);
    expect(c.backdated).toBe(true);
  });

  it('hydrates history as well as the current catalog', async () => {
    await syncPricing(db, { sources: ['nous'], fetchUpstream: feeds({ nous: [row('a/b', 1, 2)] }), now: clock });
    t += 10;
    await syncPricing(db, { sources: ['nous'], fetchUpstream: feeds({ nous: [row('a/b', 2, 4)] }), now: clock });
    clearPriceCatalogs();
    const counts = hydratePricing(db);
    expect(counts.nous).toBe(1);
    expect(historySize('nous')).toBe(2);
  });
});

describe('five books', () => {
  it('parses every feed shape into $/million', () => {
    const or = parseCatalog('openrouter', { data: [{ id: 'anthropic/claude-fable-5.1', name: 'Fable', context_length: 1000000, created: 1788285838, pricing: { prompt: '0.00001', completion: '0.00005', input_cache_read: '0.00000025', input_cache_write: '0.0000125' } }] });
    expect(or[0]).toMatchObject({ id: 'anthropic/claude-fable-5.1', input: 10, output: 50, cacheRead: 0.25, cacheWrite: 12.5, contextLen: 1000000, releasedOn: '2026-09-01' });

    const ll = parseCatalog('litellm', {
      sample_spec: { input_cost_per_token: 0 },
      'claude-fable-5-1': { litellm_provider: 'anthropic', mode: 'chat', input_cost_per_token: 0.00001, output_cost_per_token: 0.00005, cache_read_input_token_cost: 2.5e-7, cache_creation_input_token_cost: 0.0000125, max_input_tokens: 1000000 },
      'text-embedding-3-small': { mode: 'embedding', input_cost_per_token: 0.00000002 },
    });
    expect(ll).toHaveLength(1);
    expect(ll[0]).toMatchObject({ id: 'claude-fable-5-1', input: 10, output: 50, cacheRead: 0.25, cacheWrite: 12.5 });

    const md = parseCatalog('modelsdev', {
      anthropic: { id: 'anthropic', models: {
        'claude-fable-5-1': { name: 'Claude Fable 5.1', release_date: '2026-09-01', cost: { input: 10, output: 50, cache_read: 0.25, cache_write: 12.5 }, limit: { context: 1000000 } },
        'no-price': { name: 'x' },
      } },
    });
    expect(md).toHaveLength(1);
    expect(md[0]).toMatchObject({ id: 'anthropic/claude-fable-5-1', input: 10, output: 50, releasedOn: '2026-09-01', contextLen: 1000000 });

    const lp = parseCatalog('llmprices', { prices: [{ id: 'claude-fable-5-1', vendor: 'anthropic', name: 'Claude Fable 5.1', input: 10, output: 50, input_cached: 0.25 }] });
    expect(lp[0]).toMatchObject({ id: 'anthropic/claude-fable-5-1', input: 10, output: 50, cacheRead: 0.25, cacheWrite: 0 });
  });

  it('resolves our logged name against every book and reports whether they agree', async () => {
    await syncPricing(db, {
      fetchUpstream: feeds({
        openrouter: [row('anthropic/claude-fable-5.1', 10, 50)],
        modelsdev:  [row('anthropic/claude-fable-5-1', 10, 50)],
        litellm:    [row('claude-fable-5-1', 10, 50)],
        llmprices:  [row('anthropic/claude-fable-5-1', 10, 50)],
        nous:       [row('anthropic/claude-fable-5.1', 8, 40)],
      }),
      now: clock,
    });
    const c = priceConsensus('claude-fable-5-1');
    expect(c.quotes.map((q) => q.source)).toEqual(['openrouter', 'modelsdev', 'litellm', 'llmprices']);
    expect(c.agree).toBe(true);
    expect(c.corroborated).toBe(3);
    expect(c.resale).toMatchObject({ source: 'nous', input: 8 });
    expect(resolvePrice('claude-fable-5-1')).toMatchObject({ source: 'openrouter', input: 10 });
  });

  it('calls out a book that disagrees instead of letting order decide quietly', async () => {
    await syncPricing(db, {
      fetchUpstream: feeds({
        openrouter: [row('anthropic/claude-opus-5', 5, 25)],
        litellm:    [row('claude-opus-5', 15, 75)],
      }),
      now: clock,
    });
    const c = priceConsensus('claude-opus-5');
    expect(c.agree).toBe(false);
    expect(c.spread).toBeCloseTo(2 / 3);
    expect(c.corroborated).toBe(0);
  });

  it('prices a model that only one of the wider books carries', async () => {
    await syncPricing(db, {
      fetchUpstream: feeds({
        openrouter: [row('anthropic/claude-opus-5', 5, 25)],
        modelsdev:  [row('anthropic/claude-fable-5-1', 10, 50)],
      }),
      now: clock,
    });
    expect(resolvePrice('claude-fable-5-1')).toMatchObject({ source: 'modelsdev', input: 10 });
  });
});

describe('unpriced models are a reason to sync', () => {
  it('lists a recently logged model no book can price, and drops it once one can', async () => {
    const pid = db.prepare("INSERT INTO projects (name, display_name) VALUES ('p', 'p')").run().lastInsertRowid;
    const sid = db.prepare("INSERT INTO sessions (session_uuid, project_id) VALUES ('s', ?)").run(pid).lastInsertRowid;
    const ins = db.prepare('INSERT INTO messages (session_id, type, timestamp, model, input_tokens, output_tokens) VALUES (?, ?, ?, ?, ?, ?)');
    const now = new Date().toISOString();
    ins.run(sid, 'assistant', now, 'claude-fable-5-1', 1000, 100);
    ins.run(sid, 'assistant', now, 'mock-1m', 1000, 100);        // synthetic — never unpriced
    ins.run(sid, 'assistant', now, 'claude-opus-5', 0, 0);       // no tokens — not worth a fetch

    expect(unpricedModels(db).map((u) => u.model)).toEqual(['claude-fable-5-1']);

    await syncPricing(db, { sources: ['openrouter'], fetchUpstream: feeds({ openrouter: [row('anthropic/claude-fable-5.1', 10, 50)] }), now: clock });
    expect(unpricedModels(db)).toEqual([]);
  });
});
