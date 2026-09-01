// Price oracle sync — fetches model catalogs and books them in the ledger.
//
// SERVER ONLY. Imports the DB; never reach for this from a client component.
// The pure math lives in ./pricing, which this module hydrates.
//
// Five oracles, all public, all unauthenticated. No credential ever touches
// this path — nothing to leak under Operation Voyeur.
//
//   openrouter  https://openrouter.ai/api/v1/models
//               robots.txt: `Allow: /`, only /seo/ disallowed. Cleared.
//   modelsdev   https://models.dev/api.json
//               Open catalog (github.com/sst/models.dev), served as one JSON.
//   litellm     https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json
//               The price table LiteLLM ships; MIT, raw file off GitHub.
//   llmprices   https://www.llm-prices.com/current-v1.json
//               Simon Willison's hand-curated table. Small, no cache-write.
//   nous        https://inference-api.nousresearch.com/v1/models
//               no robots.txt (404 → unrestricted). Cleared.
//
// NOTE: portal.nousresearch.com/robots.txt disallows /api/ — the portal's own
// API is off limits and we do not touch it. inference-api is a separate host
// serving an OpenAI-compatible catalog, and that is the one we read.
//
// The ledger is append-only. A sync never updates a price; it closes the row
// that stopped being true and opens a new one. Every attempt — including a
// failed fetch — is written to pricing_sync_runs, so "did the book get
// checked today" has an answer, and so does "what changed".

import type Database from 'better-sqlite3';
import { getDb } from './db/schema';
import {
  CATALOG_SOURCES,
  SYNTHETIC_MODELS,
  setPriceCatalog,
  setPriceHistory,
  resolvePrice,
  type CatalogEntry,
  type CatalogSource,
} from './pricing';

export const ORACLE_URLS: Record<CatalogSource, string> = {
  openrouter: 'https://openrouter.ai/api/v1/models',
  modelsdev:  'https://models.dev/api.json',
  litellm:    'https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json',
  llmprices:  'https://www.llm-prices.com/current-v1.json',
  nous:       'https://inference-api.nousresearch.com/v1/models',
};

const USER_AGENT = 'unfirehose/1.0 (+https://unfirehose.com) price-catalog-sync';
// models.dev is ~4.5MB and LiteLLM ~2MB; a slow link needs longer than the
// 20s the two small feeds used to get.
const FETCH_TIMEOUT_MS = 45_000;

/** Why a sync ran. Written to the register so a gap can be read back. */
export type SyncTrigger = 'worker' | 'make' | 'api' | 'unpriced' | 'bootstrap';

// ---------------------------------------------------------------------------
// Feed adapters — each turns one upstream shape into rows per MILLION tokens
// ---------------------------------------------------------------------------

/** One upstream model as we book it. Prices per million tokens. */
export interface UpstreamRow {
  id: string;
  name: string | null;
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  contextLen: number | null;
  releasedOn: string | null;
}

function num(v: unknown): number | null {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (typeof v === 'string') {
    const n = parseFloat(v);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

// Upstream quotes $/token. We store $/million. Absent or unparseable becomes
// 0 — an absent cache price means the model has no cache tier, not that we
// failed.
function perTokenToPerMillion(v: unknown): number {
  const n = num(v);
  return n === null ? 0 : n * 1_000_000;
}

function perMillion(v: unknown): number {
  return num(v) ?? 0;
}

function intOrNull(v: unknown): number | null {
  const n = num(v);
  return n === null ? null : Math.round(n);
}

function dateOrNull(v: unknown): string | null {
  return typeof v === 'string' && /^\d{4}-\d{2}-\d{2}/.test(v) ? v.slice(0, 10) : null;
}

/** OpenRouter and Nous: `{ data: [{ id, name, context_length, pricing: { prompt, completion, ... } }] }`, $/token as strings. */
function parseOpenAiCompatible(body: unknown): UpstreamRow[] {
  const data = (body as { data?: unknown[] })?.data;
  if (!Array.isArray(data)) return [];
  const out: UpstreamRow[] = [];
  for (const m of data as Array<Record<string, unknown>>) {
    if (!m || typeof m.id !== 'string' || !m.id) continue;
    const p = (m.pricing ?? {}) as Record<string, unknown>;
    out.push({
      id: m.id,
      name: typeof m.name === 'string' ? m.name : null,
      input:      perTokenToPerMillion(p.prompt),
      output:     perTokenToPerMillion(p.completion),
      cacheRead:  perTokenToPerMillion(p.input_cache_read),
      cacheWrite: perTokenToPerMillion(p.input_cache_write),
      contextLen: intOrNull(m.context_length),
      releasedOn: typeof m.created === 'number'
        ? new Date(m.created * 1000).toISOString().slice(0, 10)
        : null,
    });
  }
  return out;
}

/**
 * LiteLLM: `{ "<key>": { litellm_provider, mode, input_cost_per_token, ... } }`.
 * Keys are the names LiteLLM users pass — `claude-fable-5-1` for a direct
 * Anthropic call, `vertex_ai/claude-fable-5-1` via Vertex, and so on — which
 * is why this feed matches our logged names without any alias work.
 * Only chat-shaped rows are priced tokens the way we count them; embeddings,
 * images and audio are skipped rather than booked as $0.
 */
const LITELLM_TOKEN_MODES = new Set(['chat', 'completion', 'responses']);
function parseLiteLLM(body: unknown): UpstreamRow[] {
  if (!body || typeof body !== 'object') return [];
  const out: UpstreamRow[] = [];
  for (const [key, raw] of Object.entries(body as Record<string, unknown>)) {
    if (key === 'sample_spec' || !raw || typeof raw !== 'object') continue;
    const m = raw as Record<string, unknown>;
    const mode = typeof m.mode === 'string' ? m.mode : 'chat';
    if (!LITELLM_TOKEN_MODES.has(mode)) continue;
    if (m.input_cost_per_token === undefined && m.output_cost_per_token === undefined) continue;
    out.push({
      id: key,
      name: null,
      input:      perTokenToPerMillion(m.input_cost_per_token),
      output:     perTokenToPerMillion(m.output_cost_per_token),
      cacheRead:  perTokenToPerMillion(m.cache_read_input_token_cost),
      cacheWrite: perTokenToPerMillion(m.cache_creation_input_token_cost),
      contextLen: intOrNull(m.max_input_tokens ?? m.max_tokens),
      releasedOn: null,
    });
  }
  return out;
}

/**
 * models.dev: `{ "<provider>": { id, name, models: { "<key>": { id, name, cost: { input, output, cache_read, cache_write }, release_date, limit: { context } } } } }`.
 * Already $/million. Booked as `<provider>/<key>` so `anthropic/claude-fable-5-1`
 * lands on the same candidate our alias rules already produce.
 */
function parseModelsDev(body: unknown): UpstreamRow[] {
  if (!body || typeof body !== 'object') return [];
  const out: UpstreamRow[] = [];
  for (const [providerId, raw] of Object.entries(body as Record<string, unknown>)) {
    const provider = raw as Record<string, unknown> | null;
    const models = provider?.models;
    if (!models || typeof models !== 'object') continue;
    for (const [key, mraw] of Object.entries(models as Record<string, unknown>)) {
      const m = mraw as Record<string, unknown> | null;
      const cost = m?.cost as Record<string, unknown> | undefined;
      // No cost object = no price claim. Skip rather than book a $0.
      if (!cost || typeof cost !== 'object') continue;
      const limit = (m?.limit ?? {}) as Record<string, unknown>;
      out.push({
        id: `${providerId}/${key}`,
        name: typeof m?.name === 'string' ? m.name : null,
        input:      perMillion(cost.input),
        output:     perMillion(cost.output),
        cacheRead:  perMillion(cost.cache_read),
        cacheWrite: perMillion(cost.cache_write),
        contextLen: intOrNull(limit.context),
        releasedOn: dateOrNull(m?.release_date),
      });
    }
  }
  return out;
}

/**
 * llm-prices.com: `{ prices: [{ id, vendor, name, input, output, input_cached }], updated_at }`.
 * Already $/million. No cache-write column — booked as 0, which is why this
 * feed sits last in list-price preference and is excluded from cache-tier
 * consensus.
 */
function parseLlmPrices(body: unknown): UpstreamRow[] {
  const prices = (body as { prices?: unknown[] })?.prices;
  if (!Array.isArray(prices)) return [];
  const out: UpstreamRow[] = [];
  for (const m of prices as Array<Record<string, unknown>>) {
    if (!m || typeof m.id !== 'string' || !m.id) continue;
    const vendor = typeof m.vendor === 'string' && m.vendor ? m.vendor : null;
    out.push({
      id: vendor ? `${vendor}/${m.id}` : m.id,
      name: typeof m.name === 'string' ? m.name : null,
      input:      perMillion(m.input),
      output:     perMillion(m.output),
      cacheRead:  perMillion(m.input_cached),
      cacheWrite: 0,
      contextLen: null,
      releasedOn: null,
    });
  }
  return out;
}

const PARSERS: Record<CatalogSource, (body: unknown) => UpstreamRow[]> = {
  openrouter: parseOpenAiCompatible,
  nous:       parseOpenAiCompatible,
  litellm:    parseLiteLLM,
  modelsdev:  parseModelsDev,
  llmprices:  parseLlmPrices,
};

/** Parse one feed's body. Exported so the adapters can be tested without a network. */
export function parseCatalog(source: CatalogSource, body: unknown): UpstreamRow[] {
  return PARSERS[source](body);
}

async function fetchJson(url: string): Promise<unknown> {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      signal: ctl.signal,
      headers: { accept: 'application/json', 'user-agent': USER_AGENT },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

/** Fetch and parse one oracle. Throws on any failure. */
export async function fetchUpstream(source: CatalogSource): Promise<UpstreamRow[]> {
  return parseCatalog(source, await fetchJson(ORACLE_URLS[source]));
}

/** Fetch one oracle's catalog as CatalogEntry rows. Returns [] on any failure — never throws. */
export async function fetchCatalog(source: CatalogSource): Promise<CatalogEntry[]> {
  try {
    const now = Math.floor(Date.now() / 1000);
    return (await fetchUpstream(source)).map((r) => ({
      id: r.id, source,
      input: r.input, output: r.output, cacheRead: r.cacheRead, cacheWrite: r.cacheWrite,
      fetchedAt: now,
    }));
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------------
// Sync — book what the feeds say
// ---------------------------------------------------------------------------

export interface PriceChange {
  source: CatalogSource;
  modelId: string;
  /** Previous price per million; null when the id is new to this book. */
  from: { input: number; output: number; cacheRead: number; cacheWrite: number } | null;
  to: { input: number; output: number; cacheRead: number; cacheWrite: number };
}

export interface SyncResult {
  source: CatalogSource;
  ok: boolean;
  /** Rows the feed returned. */
  models: number;
  added: number;
  changed: number;
  unchanged: number;
  delisted: number;
  /** pricing_sync_runs.id for this attempt. */
  runId: number;
  /** Every price that moved, plus new ids — the diff this run booked. */
  changes: PriceChange[];
  error?: string;
}

export interface SyncOptions {
  trigger?: SyncTrigger;
  /** Subset of oracles to sync. Default: all. */
  sources?: CatalogSource[];
  /** Injected fetch, for tests. Default: network. */
  fetchUpstream?: (source: CatalogSource) => Promise<UpstreamRow[]>;
  /** Injected clock (unix seconds), for tests. */
  now?: () => number;
}

interface OpenRow {
  id: number;
  model_id: string;
  input: number;
  output: number;
  cache_read: number;
  cache_write: number;
  delisted_at: number | null;
}

// Float equality for money. Feeds print the same price as "0.00001" and
// 1e-05 and 0.000010000; those are the same book entry.
function samePrice(a: OpenRow, r: UpstreamRow): boolean {
  const eq = (x: number, y: number) => Math.abs(x - y) <= 1e-9 * Math.max(1, Math.abs(x), Math.abs(y));
  return eq(a.input, r.input) && eq(a.output, r.output)
      && eq(a.cache_read, r.cacheRead) && eq(a.cache_write, r.cacheWrite);
}

/**
 * Fetch every oracle and book the result. Fail-closed: an oracle that errors
 * leaves its book untouched and writes a failed register entry, so a network
 * blip degrades to stale prices rather than to zeros — and is on the record.
 */
export async function syncPricing(
  db?: Database.Database,
  opts: SyncOptions = {},
): Promise<SyncResult[]> {
  const database = db ?? getDb();
  const trigger = opts.trigger ?? 'worker';
  const sources = opts.sources ?? CATALOG_SOURCES;
  const fetchOne = opts.fetchUpstream ?? fetchUpstream;
  const clock = opts.now ?? (() => Math.floor(Date.now() / 1000));
  const results: SyncResult[] = [];

  const openRun = database.prepare(
    'INSERT INTO pricing_sync_runs (source, trigger, started_at) VALUES (?, ?, ?)',
  );
  const closeRun = database.prepare(`
    UPDATE pricing_sync_runs
       SET finished_at = ?, ok = ?, models = ?, added = ?, changed = ?, unchanged = ?, delisted = ?, error = ?
     WHERE id = ?`);
  const selectOpen = database.prepare(`
    SELECT id, model_id, input, output, cache_read, cache_write, delisted_at
      FROM model_price_ledger WHERE source = ? AND effective_to IS NULL`);
  const insertRow = database.prepare(`
    INSERT INTO model_price_ledger
      (source, model_id, display_name, input, output, cache_read, cache_write, context_len,
       released_on, effective_from, effective_to, last_seen_at, delisted_at, run_id)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, NULL, ?)`);
  const confirmRow = database.prepare(`
    UPDATE model_price_ledger
       SET last_seen_at = ?, display_name = COALESCE(?, display_name),
           context_len = COALESCE(?, context_len), released_on = COALESCE(?, released_on),
           delisted_at = NULL
     WHERE id = ?`);
  const closeRow = database.prepare(
    'UPDATE model_price_ledger SET effective_to = ?, last_seen_at = ? WHERE id = ?',
  );
  const delistRow = database.prepare(
    'UPDATE model_price_ledger SET delisted_at = ? WHERE id = ? AND delisted_at IS NULL',
  );

  for (const source of sources) {
    const startedAt = clock();
    const runId = Number(openRun.run(source, trigger, startedAt).lastInsertRowid);
    const result: SyncResult = {
      source, ok: false, models: 0, added: 0, changed: 0, unchanged: 0, delisted: 0, runId, changes: [],
    };

    let rows: UpstreamRow[];
    try {
      rows = await fetchOne(source);
      if (!rows.length) throw new Error('empty catalog');
    } catch (err) {
      result.error = err instanceof Error ? err.message : String(err);
      closeRun.run(clock(), 0, 0, 0, 0, 0, 0, result.error, runId);
      results.push(result);
      continue;
    }

    try {
      database.transaction(() => {
        const now = clock();
        const open = new Map<string, OpenRow>();
        for (const r of selectOpen.all(source) as OpenRow[]) open.set(r.model_id, r);
        const seen = new Set<string>();

        for (const r of rows) {
          if (seen.has(r.id)) continue; // a feed listing an id twice is still one entry
          seen.add(r.id);
          const prev = open.get(r.id);
          const to = { input: r.input, output: r.output, cacheRead: r.cacheRead, cacheWrite: r.cacheWrite };
          if (!prev) {
            insertRow.run(source, r.id, r.name, r.input, r.output, r.cacheRead, r.cacheWrite,
              r.contextLen, r.releasedOn, now, now, runId);
            result.added++;
            result.changes.push({ source, modelId: r.id, from: null, to });
          } else if (samePrice(prev, r)) {
            confirmRow.run(now, r.name, r.contextLen, r.releasedOn, prev.id);
            result.unchanged++;
          } else {
            closeRow.run(now, now, prev.id);
            insertRow.run(source, r.id, r.name, r.input, r.output, r.cacheRead, r.cacheWrite,
              r.contextLen, r.releasedOn, now, now, runId);
            result.changed++;
            result.changes.push({
              source, modelId: r.id,
              from: { input: prev.input, output: prev.output, cacheRead: prev.cache_read, cacheWrite: prev.cache_write },
              to,
            });
          }
        }

        for (const [id, prev] of open) {
          if (seen.has(id) || prev.delisted_at !== null) continue;
          delistRow.run(now, prev.id);
          result.delisted++;
        }

        result.models = rows.length;
        result.ok = true;
        closeRun.run(now, 1, result.models, result.added, result.changed, result.unchanged, result.delisted, null, runId);
      })();
    } catch (err) {
      result.error = err instanceof Error ? err.message : String(err);
      result.ok = false;
      closeRun.run(clock(), 0, rows.length, 0, 0, 0, 0, result.error, runId);
    }
    results.push(result);
  }

  hydratePricing(database);
  return results;
}

// ---------------------------------------------------------------------------
// Hydrate — load the book into the pure module
// ---------------------------------------------------------------------------

interface LedgerRow {
  model_id: string;
  input: number;
  output: number;
  cache_read: number;
  cache_write: number;
  effective_from: number;
  effective_to: number | null;
  last_seen_at: number;
  released_on: string | null;
}

/**
 * Load the ledger into the in-memory catalog and history that pricing.ts
 * reads. Call on boot, before serving any cost number, and after every sync.
 * Returns open-row counts per source.
 */
export function hydratePricing(db?: Database.Database): Record<CatalogSource, number> {
  const database = db ?? getDb();
  const counts = {} as Record<CatalogSource, number>;
  for (const source of CATALOG_SOURCES) {
    try {
      const rows = database
        .prepare(
          `SELECT model_id, input, output, cache_read, cache_write,
                  effective_from, effective_to, last_seen_at, released_on
             FROM model_price_ledger WHERE source = ?`,
        )
        .all(source) as LedgerRow[];
      const entries: CatalogEntry[] = rows.map((r) => ({
        id: r.model_id,
        source,
        input: r.input,
        output: r.output,
        cacheRead: r.cache_read,
        cacheWrite: r.cache_write,
        fetchedAt: r.last_seen_at,
        effectiveFrom: r.effective_from,
        effectiveTo: r.effective_to,
        releasedOn: r.released_on,
      }));
      const current = entries.filter((e) => e.effectiveTo === null || e.effectiveTo === undefined);
      setPriceCatalog(source, current);
      setPriceHistory(source, entries);
      counts[source] = current.length;
    } catch {
      counts[source] = 0;
    }
  }
  return counts;
}

// Web and worker are separate processes over one SQLite file, so the web side
// has to re-read periodically to pick up what the worker synced. Cheap — a few
// thousand rows off a local file.
const HYDRATE_TTL_MS = 60_000;
let lastHydrate = 0;
let bootstrapping = false;

/**
 * Make sure the in-memory catalog is fresh enough to price against. Safe and
 * cheap to call at the top of any server route that computes cost.
 *
 * On a database that has never synced there is nothing to hydrate, so we kick
 * off a background sync and let this request fall back to the built-in table.
 * We never block a page render on upstream HTTP fetches.
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
    void syncPricing(database, { trigger: 'bootstrap' })
      .catch(() => { /* stale-or-table fallback is the designed behaviour */ })
      .finally(() => { bootstrapping = false; });
  }
}

/** Seconds since the newest confirmed row for a source, or null when we have none. */
export function catalogAge(source: CatalogSource, db?: Database.Database): number | null {
  const database = db ?? getDb();
  try {
    const row = database
      .prepare('SELECT MAX(last_seen_at) AS t FROM model_price_ledger WHERE source = ?')
      .get(source) as { t: number | null };
    if (!row?.t) return null;
    return Math.floor(Date.now() / 1000) - row.t;
  } catch {
    return null;
  }
}

/** Sync only when any book is missing or older than maxAgeSeconds. */
export async function syncPricingIfStale(
  maxAgeSeconds = 24 * 60 * 60,
  db?: Database.Database,
  opts: SyncOptions = {},
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
  return syncPricing(database, opts);
}

// ---------------------------------------------------------------------------
// Unpriced models — the reason to sync that is not a clock
// ---------------------------------------------------------------------------

export interface UnpricedModel {
  model: string;
  tokens: number;
  lastSeen: string;
}

/**
 * Models with real tokens in the window that no oracle can price. Fable 5.1
 * shipped at 18:03 UTC on a day our daily sync had run at 13:41; every token
 * until the next tick would have read `unknown`. This is the check that turns
 * that into a trigger instead of a wait.
 */
export function unpricedModels(db?: Database.Database, sinceHours = 24): UnpricedModel[] {
  const database = db ?? getDb();
  const since = new Date(Date.now() - sinceHours * 3600_000).toISOString();
  const rows = database
    .prepare(
      `SELECT model,
              SUM(input_tokens + output_tokens + cache_read_tokens + cache_creation_tokens) AS tokens,
              MAX(timestamp) AS last_seen
         FROM messages
        WHERE model IS NOT NULL AND model != '' AND timestamp >= ?
        GROUP BY model`,
    )
    .all(since) as Array<{ model: string; tokens: number; last_seen: string }>;
  const out: UnpricedModel[] = [];
  for (const r of rows) {
    if (!r.tokens) continue;
    if (SYNTHETIC_MODELS.has(r.model.toLowerCase())) continue;
    const p = resolvePrice(r.model);
    if (p && p.source !== 'unknown' && p.source !== 'table') continue;
    out.push({ model: r.model, tokens: r.tokens, lastSeen: r.last_seen });
  }
  return out;
}

let lastUnpricedSync = 0;

/**
 * If any recent model is unpriced, sync now — at most once per `minIntervalMs`
 * so a model no oracle carries (Hermes-3 8B) cannot turn into a fetch storm.
 * Returns null when nothing was unpriced or the throttle held.
 */
export async function syncIfUnpriced(
  db?: Database.Database,
  minIntervalMs = 60 * 60 * 1000,
  opts: Omit<SyncOptions, 'trigger'> = {},
): Promise<{ unpriced: UnpricedModel[]; results: SyncResult[] } | null> {
  const database = db ?? getDb();
  const unpriced = unpricedModels(database);
  if (!unpriced.length) return null;
  const now = Date.now();
  if (now - lastUnpricedSync < minIntervalMs) return null;
  lastUnpricedSync = now;
  const results = await syncPricing(database, { ...opts, trigger: 'unpriced' });
  return { unpriced, results };
}

// ---------------------------------------------------------------------------
// Reading the book back
// ---------------------------------------------------------------------------

export interface SyncRunRow {
  id: number;
  source: CatalogSource;
  trigger: SyncTrigger;
  started_at: number;
  finished_at: number | null;
  ok: number;
  models: number;
  added: number;
  changed: number;
  unchanged: number;
  delisted: number;
  error: string | null;
}

/** Most recent register entries, newest first. */
export function recentSyncRuns(db?: Database.Database, limit = 50): SyncRunRow[] {
  const database = db ?? getDb();
  return database
    .prepare('SELECT * FROM pricing_sync_runs ORDER BY started_at DESC, id DESC LIMIT ?')
    .all(limit) as SyncRunRow[];
}

export interface LedgerChangeRow {
  source: CatalogSource;
  model_id: string;
  input: number;
  output: number;
  cache_read: number;
  cache_write: number;
  effective_from: number;
  effective_to: number | null;
  /** Price this row replaced, when it did. */
  prev_input: number | null;
  prev_output: number | null;
  prev_cache_read: number | null;
  prev_cache_write: number | null;
}

/**
 * Every price that changed hands in the window — a row opened after
 * `sinceSeconds` that closed an earlier one. Brand-new ids are not changes;
 * see pricing_sync_runs.added for those.
 */
export function recentPriceChanges(db?: Database.Database, sinceSeconds = 30 * 86400, limit = 500): LedgerChangeRow[] {
  const database = db ?? getDb();
  const since = Math.floor(Date.now() / 1000) - sinceSeconds;
  return database
    .prepare(
      `SELECT n.source, n.model_id, n.input, n.output, n.cache_read, n.cache_write,
              n.effective_from, n.effective_to,
              p.input AS prev_input, p.output AS prev_output,
              p.cache_read AS prev_cache_read, p.cache_write AS prev_cache_write
         FROM model_price_ledger n
         JOIN model_price_ledger p
           ON p.source = n.source AND p.model_id = n.model_id AND p.effective_to = n.effective_from
        WHERE n.effective_from >= ?
        ORDER BY n.effective_from DESC
        LIMIT ?`,
    )
    .all(since, limit) as LedgerChangeRow[];
}

export interface LedgerHistoryRow extends LedgerRow {
  source: CatalogSource;
  delisted_at: number | null;
}

/**
 * Full price history for one upstream id across every book, oldest first.
 * This is the step series a price chart draws: each row is a level held from
 * effective_from until effective_to (or now).
 */
export function priceHistory(modelId: string, db?: Database.Database): LedgerHistoryRow[] {
  const database = db ?? getDb();
  return database
    .prepare(
      `SELECT source, model_id, input, output, cache_read, cache_write,
              effective_from, effective_to, last_seen_at, released_on, delisted_at
         FROM model_price_ledger
        WHERE lower(model_id) = lower(?)
        ORDER BY source, effective_from`,
    )
    .all(modelId) as LedgerHistoryRow[];
}
