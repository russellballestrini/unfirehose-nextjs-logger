// Price oracle sync — fetches model catalogs and lands them in SQLite.
//
// SERVER ONLY. Imports the DB; never reach for this from a client component.
// The pure math lives in ./pricing, which this module hydrates.
//
// Two oracles, both public, both unauthenticated. No credential ever touches
// this path — nothing to leak under Operation Voyeur.
//
//   openrouter  https://openrouter.ai/api/v1/models
//               robots.txt: `Allow: /`, only /seo/ disallowed. Cleared.
//   nous        https://inference-api.nousresearch.com/v1/models
//               no robots.txt (404 → unrestricted). Cleared.
//
// NOTE: portal.nousresearch.com/robots.txt disallows /api/ — the portal's own
// API is off limits and we do not touch it. inference-api is a separate host
// serving an OpenAI-compatible catalog, and that is the one we read.

import type Database from 'better-sqlite3';
import { getDb } from './db/schema';
import {
  CATALOG_SOURCES,
  setPriceCatalog,
  type CatalogEntry,
  type CatalogSource,
} from './pricing';

export const ORACLE_URLS: Record<CatalogSource, string> = {
  openrouter: 'https://openrouter.ai/api/v1/models',
  nous:       'https://inference-api.nousresearch.com/v1/models',
};

const USER_AGENT = 'unfirehose/1.0 (+https://unfirehose.com) price-catalog-sync';
const FETCH_TIMEOUT_MS = 20_000;

interface UpstreamPricing {
  prompt?: string;
  completion?: string;
  input_cache_read?: string;
  input_cache_write?: string;
  [k: string]: unknown;
}

interface UpstreamModel {
  id?: string;
  name?: string;
  context_length?: number;
  pricing?: UpstreamPricing;
}

// Upstream quotes $/token as a string. We store $/million.
// Absent or unparseable becomes 0 — an absent cache price means the model has
// no cache tier, not that we failed.
function perMillion(v: unknown): number {
  if (typeof v !== 'string' && typeof v !== 'number') return 0;
  const n = typeof v === 'number' ? v : parseFloat(v);
  return Number.isFinite(n) ? n * 1_000_000 : 0;
}

export interface SyncResult {
  source: CatalogSource;
  ok: boolean;
  models: number;
  error?: string;
}

/** Fetch one oracle's catalog. Returns [] on any failure — never throws. */
export async function fetchCatalog(source: CatalogSource): Promise<CatalogEntry[]> {
  const url = ORACLE_URLS[source];
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      signal: ctl.signal,
      headers: { accept: 'application/json', 'user-agent': USER_AGENT },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const body = (await res.json()) as { data?: UpstreamModel[] };
    const rows = Array.isArray(body?.data) ? body.data : [];
    const now = Math.floor(Date.now() / 1000);
    const out: CatalogEntry[] = [];
    for (const m of rows) {
      if (!m?.id) continue;
      const p = m.pricing ?? {};
      out.push({
        id: m.id,
        source,
        input:      perMillion(p.prompt),
        output:     perMillion(p.completion),
        cacheRead:  perMillion(p.input_cache_read),
        cacheWrite: perMillion(p.input_cache_write),
        fetchedAt: now,
      });
    }
    return out;
  } catch {
    return [];
  } finally {
    clearTimeout(timer);
  }
}

// Kept alongside the entries so we can persist display name / context length
// without widening CatalogEntry, which pricing.ts uses for math only.
async function fetchWithMeta(source: CatalogSource) {
  const url = ORACLE_URLS[source];
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      signal: ctl.signal,
      headers: { accept: 'application/json', 'user-agent': USER_AGENT },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const body = (await res.json()) as { data?: UpstreamModel[] };
    return Array.isArray(body?.data) ? body.data : [];
  } catch (err) {
    throw err instanceof Error ? err : new Error(String(err));
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Fetch every oracle and persist. Fail-closed: an oracle that errors leaves
 * its previously-stored rows untouched, so a network blip degrades to stale
 * prices rather than to zeros.
 */
export async function syncPricing(db?: Database.Database): Promise<SyncResult[]> {
  const database = db ?? getDb();
  const results: SyncResult[] = [];

  for (const source of CATALOG_SOURCES) {
    try {
      const rows = await fetchWithMeta(source);
      if (!rows.length) {
        results.push({ source, ok: false, models: 0, error: 'empty catalog' });
        continue;
      }
      const now = Math.floor(Date.now() / 1000);
      const stmt = database.prepare(`
        INSERT INTO model_pricing
          (source, model_id, display_name, input, output, cache_read, cache_write, context_len, fetched_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(source, model_id) DO UPDATE SET
          display_name = excluded.display_name,
          input        = excluded.input,
          output       = excluded.output,
          cache_read   = excluded.cache_read,
          cache_write  = excluded.cache_write,
          context_len  = excluded.context_len,
          fetched_at   = excluded.fetched_at
      `);
      const write = database.transaction((models: UpstreamModel[]) => {
        for (const m of models) {
          if (!m?.id) continue;
          const p = m.pricing ?? {};
          stmt.run(
            source,
            m.id,
            m.name ?? null,
            perMillion(p.prompt),
            perMillion(p.completion),
            perMillion(p.input_cache_read),
            perMillion(p.input_cache_write),
            m.context_length ?? null,
            now,
          );
        }
      });
      write(rows);
      results.push({ source, ok: true, models: rows.length });
    } catch (err) {
      results.push({
        source,
        ok: false,
        models: 0,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  hydratePricing(database);
  return results;
}

/**
 * Load persisted prices into the in-memory catalog that pricing.ts reads.
 * Call on boot, before serving any cost number, and after every sync.
 */
export function hydratePricing(db?: Database.Database): Record<CatalogSource, number> {
  const database = db ?? getDb();
  const counts = {} as Record<CatalogSource, number>;
  for (const source of CATALOG_SOURCES) {
    try {
      const rows = database
        .prepare(
          `SELECT model_id, input, output, cache_read, cache_write, fetched_at
             FROM model_pricing WHERE source = ?`,
        )
        .all(source) as Array<{
          model_id: string;
          input: number;
          output: number;
          cache_read: number;
          cache_write: number;
          fetched_at: number;
        }>;
      setPriceCatalog(
        source,
        rows.map((r) => ({
          id: r.model_id,
          source,
          input: r.input,
          output: r.output,
          cacheRead: r.cache_read,
          cacheWrite: r.cache_write,
          fetchedAt: r.fetched_at,
        })),
      );
      counts[source] = rows.length;
    } catch {
      counts[source] = 0;
    }
  }
  return counts;
}

// Web and worker are separate processes over one SQLite file, so the web side
// has to re-read periodically to pick up what the worker synced. Cheap — a few
// hundred rows off a local file.
const HYDRATE_TTL_MS = 60_000;
let lastHydrate = 0;
let bootstrapping = false;

/**
 * Make sure the in-memory catalog is fresh enough to price against. Safe and
 * cheap to call at the top of any server route that computes cost.
 *
 * On a database that has never synced there is nothing to hydrate, so we kick
 * off a background sync and let this request fall back to the built-in table.
 * We never block a page render on two upstream HTTP fetches.
 */
export function ensurePricingHydrated(db?: Database.Database): void {
  const now = Date.now();
  if (now - lastHydrate < HYDRATE_TTL_MS) return;
  lastHydrate = now;

  const database = db ?? getDb();
  const counts = hydratePricing(database);
  const empty = CATALOG_SOURCES.every((s) => !counts[s]);
  if (empty && !bootstrapping) {
    bootstrapping = true;
    void syncPricing(database)
      .catch(() => { /* stale-or-table fallback is the designed behaviour */ })
      .finally(() => { bootstrapping = false; });
  }
}

/** Seconds since the newest row for a source, or null when we have none. */
export function catalogAge(source: CatalogSource, db?: Database.Database): number | null {
  const database = db ?? getDb();
  try {
    const row = database
      .prepare('SELECT MAX(fetched_at) AS t FROM model_pricing WHERE source = ?')
      .get(source) as { t: number | null };
    if (!row?.t) return null;
    return Math.floor(Date.now() / 1000) - row.t;
  } catch {
    return null;
  }
}

/** Sync only when the catalog is missing or older than maxAgeSeconds. */
export async function syncPricingIfStale(
  maxAgeSeconds = 24 * 60 * 60,
  db?: Database.Database,
): Promise<SyncResult[] | null> {
  const database = db ?? getDb();
  const stale = CATALOG_SOURCES.some((s) => {
    const age = catalogAge(s, database);
    return age === null || age > maxAgeSeconds;
  });
  if (!stale) {
    hydratePricing(database);
    return null;
  }
  return syncPricing(database);
}
