// Model pricing — per million tokens.
// Single source of truth. Imported by every route that computes cost.
//
// Prices come from a ledger synced off five public oracles (see pricing-sync.ts):
//
//   openrouter — openrouter.ai/api/v1/models. List price. What Anthropic,
//                Qwen, xAI et al. actually bill when we call them direct.
//   modelsdev  — models.dev/api.json. Community catalog, 190 providers,
//                carries release dates. Fastest to list a launch-day model.
//   litellm    — LiteLLM's model_prices_and_context_window.json. 2,400+ chat
//                rows keyed by the bare vendor name we actually log.
//   llmprices  — llm-prices.com. Small, hand-curated, no cache-write column.
//   nous       — inference-api.nousresearch.com/v1/models. Same catalog,
//                resold cheaper (~0.8x on frontier, deeper on their own
//                Hermes line). What we pay when we route through Nous.
//
// Five books instead of one is the point, not redundancy for its own sake: a
// price that only one feed reports is a claim, a price four feeds agree on is
// a fact, and priceConsensus() below tells the two apart.
//
// This module stays PURE — no DB, no network. It is a published npm export and
// reachable from client components. The current catalog is injected via
// setPriceCatalog() and the full history via setPriceHistory(); PRICING below
// is the cold-start fallback, used only on a database that has never synced.
// It is deliberately not extended for new models — the ledger is the book.

export interface ModelPrice {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

/** Where a price came from. Surfaced to the UI so a number is never anonymous. */
export type PriceSource =
  | 'openrouter'  // openrouter.ai list price
  | 'modelsdev'   // models.dev community catalog
  | 'litellm'     // LiteLLM price json
  | 'llmprices'   // llm-prices.com
  | 'nous'        // Nous Portal resale price
  | 'table'       // built-in fallback below
  | 'energy'      // self-hosted; electricity, not an invoice
  | 'synthetic'   // test fixture; genuinely $0
  | 'free'        // real model, real tokens, priced at $0 by its provider
  | 'unknown';    // we could not price this — never silently render as $0

/**
 * Oracles we sync, in the order we prefer them when no source is requested.
 *
 * This is LIST-price order: what a direct call to the vendor bills. Nous is
 * last because it is a reseller quoting its own margin, not the vendor's
 * price — it only comes first for traffic that actually routed through Nous
 * (see NOUS_PREFERENCE).
 */
export type CatalogSource = 'openrouter' | 'modelsdev' | 'litellm' | 'llmprices' | 'nous';
export const CATALOG_SOURCES: CatalogSource[] = ['openrouter', 'modelsdev', 'litellm', 'llmprices', 'nous'];

/** Sources that quote the vendor's list price. Consensus is measured over these. */
export const LIST_PRICE_SOURCES: CatalogSource[] = ['openrouter', 'modelsdev', 'litellm', 'llmprices'];

/** Preference for traffic that routed through Nous: their price first, list after. */
export const NOUS_PREFERENCE: CatalogSource[] = ['nous', ...LIST_PRICE_SOURCES];

function emptyBySource<T>(make: () => T): Record<CatalogSource, T> {
  const out = {} as Record<CatalogSource, T>;
  for (const s of CATALOG_SOURCES) out[s] = make();
  return out;
}

// Cold-start fallback. Anthropic list price per million tokens.
// Deliberately small — the catalog supersedes this within a minute of boot.
// Every entry here must also exist upstream; this table exists so a cold or
// offline dashboard shows approximately-right numbers, not zeros.
export const PRICING: Record<string, ModelPrice> = {
  // Fable tier (most capable widely-released; above Opus)
  'claude-fable-5':             { input: 10, output: 50, cacheRead: 1.00, cacheWrite: 12.50 },

  // Opus tier
  'claude-opus-5':              { input: 5, output: 25, cacheRead: 0.50, cacheWrite: 6.25 },
  'claude-opus-4-8':            { input: 5, output: 25, cacheRead: 0.50, cacheWrite: 6.25 },
  'claude-opus-4-7':            { input: 5, output: 25, cacheRead: 0.50, cacheWrite: 6.25 },
  'claude-opus-4-6':            { input: 5, output: 25, cacheRead: 0.50, cacheWrite: 6.25 },
  'claude-opus-4-5-20251101':   { input: 5, output: 25, cacheRead: 0.50, cacheWrite: 6.25 },

  // Sonnet tier
  'claude-sonnet-5':            { input: 3, output: 15, cacheRead: 0.30, cacheWrite: 3.75 },
  'claude-sonnet-4-6':          { input: 3, output: 15, cacheRead: 0.30, cacheWrite: 3.75 },
  'claude-sonnet-4-5-20250929': { input: 3, output: 15, cacheRead: 0.30, cacheWrite: 3.75 },
  'claude-sonnet-4-20250514':   { input: 3, output: 15, cacheRead: 0.30, cacheWrite: 3.75 },

  // Haiku tier
  'claude-haiku-4-5':           { input: 1, output:  5, cacheRead: 0.10, cacheWrite: 1.25 },
  'claude-haiku-4-5-20251001':  { input: 1, output:  5, cacheRead: 0.10, cacheWrite: 1.25 },
};

// ---------------------------------------------------------------------------
// Catalog
// ---------------------------------------------------------------------------

export interface CatalogEntry extends ModelPrice {
  /** Upstream id, e.g. `anthropic/claude-opus-5`. */
  id: string;
  source: CatalogSource;
  /** Unix seconds the row was fetched (last confirmed, for a ledger row). */
  fetchedAt: number;
  /** Unix seconds this price was first observed. Ledger rows carry it. */
  effectiveFrom?: number;
  /** Unix seconds a later observation superseded it; null/undefined = current. */
  effectiveTo?: number | null;
  /** Upstream release date (YYYY-MM-DD) when the feed reports one. */
  releasedOn?: string | null;
}

// source -> upstream id -> price. Module-level so a pure function can read it.
let catalog: Record<CatalogSource, Map<string, CatalogEntry>> = emptyBySource(() => new Map());

// source -> upstream id -> every price ever observed, oldest first. This is
// the book that lets a June token be billed at June's price.
let history: Record<CatalogSource, Map<string, CatalogEntry[]>> = emptyBySource(() => new Map());

/** Replace the in-memory catalog for one oracle. Called after sync/hydrate. */
export function setPriceCatalog(source: CatalogSource, entries: CatalogEntry[]): void {
  const m = new Map<string, CatalogEntry>();
  for (const e of entries) m.set(e.id.toLowerCase(), e);
  catalog[source] = m;
}

/**
 * Replace the in-memory price history for one oracle. Entries may arrive in
 * any order; they are grouped by id and sorted by effectiveFrom. An entry
 * without effectiveFrom is treated as effective since its fetchedAt.
 */
export function setPriceHistory(source: CatalogSource, entries: CatalogEntry[]): void {
  const m = new Map<string, CatalogEntry[]>();
  for (const e of entries) {
    const key = e.id.toLowerCase();
    const row = { ...e, effectiveFrom: e.effectiveFrom ?? e.fetchedAt };
    const list = m.get(key);
    if (list) list.push(row); else m.set(key, [row]);
  }
  for (const list of m.values()) list.sort((a, b) => (a.effectiveFrom! - b.effectiveFrom!));
  history[source] = m;
}

/** Drop every injected price — tests use this to prove the fallbacks. */
export function clearPriceCatalogs(): void {
  catalog = emptyBySource(() => new Map());
  history = emptyBySource(() => new Map());
}

export function catalogSize(source: CatalogSource): number {
  return catalog[source].size;
}

export function historySize(source: CatalogSource): number {
  let n = 0;
  for (const list of history[source].values()) n += list.length;
  return n;
}

/**
 * Accept a timestamp as ISO-8601, unix seconds, or unix milliseconds and
 * return unix seconds. Undefined/invalid means "now" to every caller.
 */
export function toUnixSeconds(at: number | string | Date | null | undefined): number | undefined {
  if (at === null || at === undefined || at === '') return undefined;
  if (at instanceof Date) return Number.isFinite(at.getTime()) ? Math.floor(at.getTime() / 1000) : undefined;
  if (typeof at === 'string') {
    const n = Number(at);
    if (Number.isFinite(n) && /^\d+(\.\d+)?$/.test(at.trim())) return toUnixSeconds(n);
    const ms = Date.parse(at);
    return Number.isFinite(ms) ? Math.floor(ms / 1000) : undefined;
  }
  if (!Number.isFinite(at)) return undefined;
  // Anything past year 2286 in seconds is really milliseconds.
  return at > 1e11 ? Math.floor(at / 1000) : Math.floor(at);
}

/**
 * The price in force for one catalog id at one instant, from the history
 * book. Returns the row whose [effectiveFrom, effectiveTo) covers `at`. When
 * `at` predates our first observation there is no evidence of any other
 * price, so the earliest row is returned and flagged `backdated` — the caller
 * decides whether to trust it. Undefined when we hold no history for the id.
 */
export function priceAt(
  source: CatalogSource,
  id: string,
  at: number,
): { entry: CatalogEntry; backdated: boolean } | undefined {
  const rows = history[source].get(id.toLowerCase());
  if (!rows?.length) return undefined;
  for (const r of rows) {
    const from = r.effectiveFrom ?? r.fetchedAt;
    const to = r.effectiveTo ?? null;
    if (from <= at && (to === null || to > at)) return { entry: r, backdated: false };
  }
  const first = rows[0];
  if (at < (first.effectiveFrom ?? first.fetchedAt)) return { entry: first, backdated: true };
  // Inside a gap between a closed row and the next open one — should not
  // happen with a well-formed ledger, but fall back to the latest row rather
  // than to nothing.
  return { entry: rows[rows.length - 1], backdated: true };
}

export function catalogStats(): Record<CatalogSource, { models: number; fetchedAt: number | null }> {
  const out = {} as Record<CatalogSource, { models: number; fetchedAt: number | null }>;
  for (const s of CATALOG_SOURCES) {
    let newest: number | null = null;
    for (const e of catalog[s].values()) {
      if (newest === null || e.fetchedAt > newest) newest = e.fetchedAt;
    }
    out[s] = { models: catalog[s].size, fetchedAt: newest };
  }
  return out;
}

// ---------------------------------------------------------------------------
// Alias resolution — our logged model names onto upstream catalog ids
// ---------------------------------------------------------------------------

/**
 * Explicit pins. Take precedence over every derived rule below.
 *
 * `stealth/ox-alpha` was a cloaked model, listed at $0 while in evaluation,
 * which would have let real inference vanish from our cost line. It de-cloaked
 * on 2026-08-26 as `z-ai/glm-5.3-flash`, and the `stealth/ox-alpha` id was
 * removed from the catalog outright — so the pin is now MORE necessary, not
 * less: our history is full of a model id no oracle lists any more.
 *
 * The interim pin was Qwen 3.6 27B, picked as a nearest-price guess, and it
 * was 4.7x too expensive: the same 28-day window costs $5.00 on glm-5.3-flash
 * against the $23.58 that guess implied. Worth remembering the next time a
 * cloaked model needs a stand-in — a plausible neighbour is not a price.
 */
// Keys are the model names exactly as we log them. Matching is
// case-insensitive — see ALIAS_LOOKUP below — so write them the way they
// actually appear, not pre-lowercased.
export const MODEL_ALIASES: Record<string, string> = {
  'stealth/ox-alpha':  'z-ai/glm-5.3-flash',
  'ox-alpha':          'z-ai/glm-5.3-flash',

  // Our own build of Qwen 3.6 27B. The quantized artifact is not a separate
  // product and neither oracle lists it, so it prices at the base model's
  // hosted rate — which is exactly the question the market column asks:
  // what would these tokens have cost had we not run them ourselves.
  'Lorbus/Qwen3.6-27B-int4-AutoRound': 'qwen/qwen3.6-27b',

  // Variant strings the oracles do not carry under their own name.
  'grok-4.20-0309-non-reasoning': 'x-ai/grok-4.20',
};

// Case-insensitive view of the pins above, built once.
const ALIAS_LOOKUP: Record<string, string> = Object.fromEntries(
  Object.entries(MODEL_ALIASES).map(([k, v]) => [k.toLowerCase(), v.toLowerCase()]),
);

/** Test fixtures. Real rows in our DB, but not real spend. Priced $0, labelled. */
export const SYNTHETIC_MODELS = new Set([
  'mock-1m',
  'fake-model-1',
  '<synthetic>',
]);

// Vendor prefixes we strip when a self-hosted repo name wraps an upstream model,
// e.g. `Lorbus/Qwen3.6-27B-int4-AutoRound` -> `qwen3.6-27b`.
const QUANT_SUFFIX = /-(int[48]|fp8|fp16|bf16|gptq|awq|gguf|q[2-8]_[a-z0-9_]+|autoround|dynamic|ud)\b/gi;

// A local weights file rather than a served model: `...-Q4_K_XL.gguf`,
// `hf.co/bartowski/Foo-GGUF:Q4`. Stripped before we try to match upstream.
const WEIGHTS_FILE_SUFFIX = /\.(gguf|safetensors|bin|pt)\b/gi;
const REPO_TAG_SUFFIX = /:[a-z0-9_.-]+$/i;
const HF_HOST_PREFIX = /^hf\.co\//i;

/**
 * Normalize one of our logged model names toward an upstream catalog id.
 * Returns candidates most-specific first — the caller tries each in order.
 *
 * Handles:
 *   claude-opus-5[1m]                     -> anthropic/claude-opus-5
 *   claude-opus-4-8                       -> anthropic/claude-opus-4.8
 *   Lorbus/Qwen3.6-27B-int4-AutoRound     -> qwen/qwen3.6-27b
 *   solidrust/Hermes-3-Llama-3.1-8B-AWQ   -> nousresearch/hermes-3-llama-3.1-8b
 */
export function aliasCandidates(model: string): string[] {
  const hit = aliasMemo.get(model);
  if (hit) return hit;
  const out = computeAliasCandidates(model);
  // Bounded: we log a few dozen distinct model names, not thousands. A
  // runaway set of names (a fuzzing harness, say) must not grow this forever.
  if (aliasMemo.size >= ALIAS_MEMO_MAX) aliasMemo.clear();
  aliasMemo.set(model, out);
  return out;
}

// Routes price tens of thousands of (session, model, day) rows per request
// now that cost is booked per day; the dozen regexes below were most of that
// time. The result depends only on the name, so it is cached by name.
const ALIAS_MEMO_MAX = 4096;
const aliasMemo = new Map<string, string[]>();

function computeAliasCandidates(model: string): string[] {
  const out: string[] = [];
  const push = (s: string) => {
    const v = s.toLowerCase().trim();
    if (v && !out.includes(v)) out.push(v);
  };

  const raw = model.trim();
  push(raw);

  // Explicit pin, checked against both the raw name and the bare name.
  const pinned = ALIAS_LOOKUP[raw.toLowerCase()];
  if (pinned) out.unshift(pinned.toLowerCase());

  // Strip a trailing context-window tag: `claude-opus-5[1m]`.
  const noTag = raw.replace(/\[[^\]]*\]$/, '');
  push(noTag);

  const pinnedNoTag = ALIAS_LOOKUP[noTag.toLowerCase()];
  if (pinnedNoTag) out.unshift(pinnedNoTag.toLowerCase());

  // Peel a local-weights name back to the model it is a build of:
  //   hf.co/bartowski/NousResearch_NousCoder-14B-GGUF:Q4 -> nouscoder-14b
  //   Qwen3.6-27B-UD-Q4_K_XL.gguf                        -> qwen3.6-27b
  const noHost = noTag.replace(HF_HOST_PREFIX, '');
  const noFile = noHost.replace(WEIGHTS_FILE_SUFFIX, '').replace(REPO_TAG_SUFFIX, '');

  // Drop a vendor/repo prefix: `Lorbus/Qwen3.6-27B...` -> `Qwen3.6-27B...`
  let bare = noFile.includes('/') ? noFile.slice(noFile.lastIndexOf('/') + 1) : noFile;
  // Some repos join vendor and model with an underscore:
  // `NousResearch_NousCoder-14B`. Only split when the part before the
  // underscore is a plain vendor word — otherwise this eats quantization
  // markers like `Q4_K_XL`, which are underscores inside the model name.
  const us = bare.indexOf('_');
  if (us > 2 && /^[A-Za-z]+$/.test(bare.slice(0, us))) {
    bare = bare.slice(us + 1);
  }

  // Drop quantization suffixes, repeatedly — `-UD-Q4_K_XL` is two of them.
  let dequant = bare;
  for (let i = 0; i < 4; i++) {
    const next = dequant.replace(QUANT_SUFFIX, '').replace(/-+$/, '');
    if (next === dequant) break;
    dequant = next;
  }

  for (const stem of [bare, dequant]) {
    if (!stem) continue;
    push(stem);

    // Anthropic names log as `claude-opus-4-8`; OpenRouter uses
    // `claude-opus-4.8`, while models.dev and LiteLLM keep our dashed form.
    const dotted = stem.replace(/^(claude-[a-z]+)-(\d+)-(\d+)/i, '$1-$2.$3');
    push(dotted);
    push(`anthropic/${dotted}`);
    if (/^claude-/i.test(stem)) push(`anthropic/${stem}`);

    // Qwen / Hermes families carry a known vendor namespace upstream.
    if (/^qwen/i.test(stem)) push(`qwen/${stem}`);
    if (/^hermes/i.test(stem)) push(`nousresearch/${stem}`);
    if (/^grok/i.test(stem)) push(`x-ai/${stem}`);
  }

  return out;
}

/**
 * Promotional discounts to unwind, so the catalog reports LIST price.
 *
 * OpenRouter runs limited-time discounts and its /models endpoint returns the
 * discounted number with nothing to mark it — no flag, no original, no expiry
 * that means anything (`expiration_date` reads 2098-12-31). Nous carries an
 * `original` field, but that is only OpenRouter's current price before Nous's
 * own resale margin, so it does not recover the pre-promo rate either.
 *
 * A promo price is the wrong basis for this dashboard. Cost here informs where
 * work should run, and a model that is briefly half price is not a model that
 * is cheap — routing toward it on a discount that expires next month is how a
 * bill doubles without anything changing. So we record list price and label
 * the promo, rather than quietly booking the discount as if it were permanent.
 *
 * `multiplier` converts catalog price to list: 2 undoes 50% off.
 *
 * These are hand-entered because no API exposes them. Each carries who said so
 * and when, and removing an entry when a promo ends is a one-line change that
 * makes the price fall rather than silently doubling it.
 */
export interface PromoAdjustment {
  multiplier: number;
  reason: string;
  notedOn: string;
}

export const PROMO_DISCOUNTS: Record<string, PromoAdjustment> = {
  'z-ai/glm-5.3-flash': {
    multiplier: 2,
    reason: '50% launch discount on OpenRouter; list is $0.15/$0.50 per M (fox)',
    notedOn: '2026-08-26',
  },
};

const PROMO_LOOKUP: Record<string, PromoAdjustment> = Object.fromEntries(
  Object.entries(PROMO_DISCOUNTS).map(([k, v]) => [k.toLowerCase(), v]),
);

/** List price for a catalog entry, with any known promo unwound. */
export function undiscount(id: string, price: ModelPrice): {
  price: ModelPrice; promo: PromoAdjustment | null;
} {
  const adj = PROMO_LOOKUP[id.toLowerCase()];
  if (!adj || !(adj.multiplier > 0)) return { price, promo: null };
  return {
    price: {
      input: price.input * adj.multiplier,
      output: price.output * adj.multiplier,
      cacheRead: price.cacheRead * adj.multiplier,
      cacheWrite: price.cacheWrite * adj.multiplier,
    },
    promo: adj,
  };
}

export interface ResolvedPrice extends ModelPrice {
  source: PriceSource;
  /** Upstream id we matched, when the price came from a catalog. */
  matchedId?: string;
  /** Set when a promotional discount was unwound to reach list price. */
  promo?: PromoAdjustment | null;
  /** Unix seconds this price took effect, when resolved from the ledger. */
  effectiveFrom?: number;
  /** Unix seconds it was superseded; null while current. */
  effectiveTo?: number | null;
  /**
   * True when `at` predates every price we hold for this model and we used
   * the earliest one. The number is our best evidence, not a record.
   */
  backdated?: boolean;
}

function fromEntry(hit: CatalogEntry, source: CatalogSource, backdated: boolean): ResolvedPrice {
  const isFree = !hit.input && !hit.output && !hit.cacheRead && !hit.cacheWrite;
  // Report list price, not whatever promo is running today — see
  // PROMO_DISCOUNTS for why a temporary discount is the wrong basis here.
  const { price, promo } = undiscount(hit.id, hit);
  return {
    input: price.input,
    output: price.output,
    cacheRead: price.cacheRead,
    cacheWrite: price.cacheWrite,
    source: isFree ? 'free' : source,
    matchedId: hit.id,
    promo,
    effectiveFrom: hit.effectiveFrom ?? hit.fetchedAt,
    effectiveTo: hit.effectiveTo ?? null,
    backdated,
  };
}

/**
 * Resolve a price for one of our model names.
 *
 * `prefer` orders the oracles. Default is list-price order (OpenRouter first):
 * what we actually pay on a direct Anthropic call. Pass NOUS_PREFERENCE for
 * traffic that genuinely routed through Nous.
 *
 * `at` — a timestamp (ISO, unix s or ms). When given, the price in force at
 * that instant is returned from the history book, so a token spent in June is
 * billed at June's price whatever the catalog says today. Without it, or when
 * no history has been loaded, the current catalog answers.
 *
 * Falls back to the built-in table, then gives up — and says so, rather than
 * returning zeros that render as "free".
 */
export function resolvePrice(
  model: string,
  prefer: CatalogSource[] = CATALOG_SOURCES,
  at?: number | string | Date | null,
): ResolvedPrice | undefined {
  if (!model) return undefined;
  if (SYNTHETIC_MODELS.has(model.toLowerCase())) {
    return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, source: 'synthetic' };
  }

  const candidates = aliasCandidates(model);
  const atSec = toUnixSeconds(at);

  for (const source of prefer) {
    // History first when a time was asked for. A source with no history
    // loaded falls through to its current catalog rather than to nothing.
    if (atSec !== undefined && history[source].size) {
      for (const c of candidates) {
        const found = priceAt(source, c, atSec);
        if (found) return fromEntry(found.entry, source, found.backdated);
      }
    }
    const m = catalog[source];
    if (!m.size) continue;
    for (const c of candidates) {
      const hit = m.get(c);
      if (hit) return fromEntry(hit, source, false);
    }
  }

  // Cold-start / offline fallback.
  const t = PRICING[model] ?? PRICING[model.replace(/\[[^\]]*\]$/, '')];
  if (t) return { ...t, source: 'table' };

  return undefined;
}

// ---------------------------------------------------------------------------
// Consensus — do the books agree?
// ---------------------------------------------------------------------------

export interface ConsensusQuote {
  source: CatalogSource;
  matchedId: string;
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

export interface PriceConsensus {
  model: string;
  /** Every list-price oracle that could price this model. */
  quotes: ConsensusQuote[];
  /** Nous, reported separately — it is a resale price and expected to differ. */
  resale: ConsensusQuote | null;
  /** How many independent list-price books agree with the preferred one. */
  corroborated: number;
  /** Largest relative gap on input or output across the quotes. 0 = unanimous. */
  spread: number;
  /** True when every list-price quote sits within `tolerance` of the others. */
  agree: boolean;
}

/** Relative spread within which two quotes count as the same price. */
export const CONSENSUS_TOLERANCE = 0.01;

/**
 * Ask every list-price oracle for the same model and say whether they agree.
 *
 * This is the double-entry check. With one oracle, a wrong price wins by
 * default. With several, a disagreement is visible and gets a human look
 * before it becomes a number on a dashboard. Only input and output are
 * compared: cache tiers are reported inconsistently across feeds (llm-prices
 * carries no cache-write at all) and a missing column is not a disagreement.
 */
export function priceConsensus(
  model: string,
  at?: number | string | Date | null,
): PriceConsensus {
  const quotes: ConsensusQuote[] = [];
  let resale: ConsensusQuote | null = null;
  for (const source of CATALOG_SOURCES) {
    const r = resolvePrice(model, [source], at);
    if (!r || r.source === 'table' || r.source === 'synthetic' || !r.matchedId) continue;
    const q: ConsensusQuote = {
      source, matchedId: r.matchedId,
      input: r.input, output: r.output, cacheRead: r.cacheRead, cacheWrite: r.cacheWrite,
    };
    if (source === 'nous') resale = q; else quotes.push(q);
  }

  let spread = 0;
  for (const field of ['input', 'output'] as const) {
    const vals = quotes.map((q) => q[field]);
    const max = Math.max(...vals, 0);
    const min = Math.min(...vals, max);
    if (max > 0) spread = Math.max(spread, (max - min) / max);
  }

  const preferred = quotes[0];
  const corroborated = preferred
    ? quotes.filter((q) => q !== preferred && close(q, preferred)).length
    : 0;

  return { model, quotes, resale, corroborated, spread, agree: spread <= CONSENSUS_TOLERANCE };
}

function close(a: ConsensusQuote, b: ConsensusQuote): boolean {
  const rel = (x: number, y: number) => (Math.max(x, y) === 0 ? 0 : Math.abs(x - y) / Math.max(x, y));
  return rel(a.input, b.input) <= CONSENSUS_TOLERANCE && rel(a.output, b.output) <= CONSENSUS_TOLERANCE;
}

/**
 * Back-compat shim. Existing callers use this as a boolean "is this a cloud
 * model we can price" test as well as for the price itself, so it must keep
 * returning undefined for anything we cannot price.
 */
export function priceForModel(model: string): ModelPrice | undefined {
  const r = resolvePrice(model);
  if (!r) return undefined;
  if (r.source === 'synthetic') return undefined;
  return { input: r.input, output: r.output, cacheRead: r.cacheRead, cacheWrite: r.cacheWrite };
}

// ---------------------------------------------------------------------------
// Self-hosted energy cost
// ---------------------------------------------------------------------------

export interface SelfHostHardware {
  watts: number;                   // typical inference draw
  tokensPerSecond: number;         // decode throughput (memory-bandwidth bound, serial)
  prefillTokensPerSecond: number;  // prompt ingestion (compute bound, batched)
  label: string;
}

// Watts = observed spike during active inference. Cost per hour at $0.33/kWh:
// 4090 = $0.142/h, 3090 = $0.0825/h.
//
// Prefill and decode are NOT the same rate and must not share a constant.
// Prefill processes the prompt as one batched matmul — thousands of tok/s.
// Decode emits one token at a time against the full KV cache — tens of tok/s.
// Billing prefill at the decode rate overstates local GPU time by ~40x, which
// is precisely the number that decides whether moving work off Claude pays.
export const SELF_HOST_HARDWARE: Record<string, SelfHostHardware> = {
  '4090': { watts: 430, tokensPerSecond: 70,  prefillTokensPerSecond: 3000, label: 'RTX 4090' },
  '3090': { watts: 250, tokensPerSecond: 100, prefillTokensPerSecond: 2000, label: 'RTX 3090' },
};

// A cache-read token skips prefill compute and is served from the KV cache —
// effectively a memory fetch. Treated as this multiple of the prefill rate.
export const CACHE_READ_SPEEDUP = 10;

// Model-name → hardware key, used for cost ESTIMATION only (watts × throughput).
// Attribution to a specific node comes from endpoint/provider — see hostForMessage.
export const MODEL_HARDWARE_HINT: Array<{ pattern: RegExp; hardware: string }> = [
  { pattern: /qwen/i,   hardware: '4090' },
  { pattern: /hermes/i, hardware: '3090' },
];

/**
 * Models we know are CLOUD-served, whatever the row's provider column says.
 *
 * `provider` is not trustworthy on its own. A schema backfill stamps
 * provider='local' onto every uncloseai-harness message (see db/schema.ts),
 * which encodes "uncloseai served it" — not "our GPU served it". uncloseai-cli
 * routes to OpenRouter and Nous as well as to our own boxes, so that column
 * marks plenty of cloud traffic as local.
 *
 * `stealth/ox-alpha` is the case in point: 4,206 messages, 63M tokens, every
 * row provider='local', and it runs on OpenRouter and Nous Portal. Listing it
 * here keeps it out of the electricity model and on an invoice, where it belongs.
 */
export const CLOUD_SERVED_MODELS = new Set([
  'stealth/ox-alpha',
  'ox-alpha',
  'qwen/qwen3.6-27b',
  'qwen/qwen3.8-27b',
]);

/**
 * Marks of a model we downloaded and run ourselves: a quantization suffix, or
 * a vendor/repo path that is not an upstream catalog namespace.
 * `Lorbus/Qwen3.6-27B-int4-AutoRound` and `solidrust/Hermes-3-Llama-3.1-8B-AWQ`
 * are local artifacts; `qwen/qwen3.6-27b` is a hosted product.
 */
export const SELF_HOSTED_MODEL_PATTERNS: RegExp[] = [
  /-(int[48]|fp8|gptq|awq|gguf|autoround)\b/i,
  /\bq[45]_[a-z0-9_]+\b/i,
];

/**
 * Did our own hardware serve this? Evidence in order of strength:
 *   1. endpoint maps to a mesh node we track   → yes, and we know which
 *   2. model is on the known-cloud list        → no
 *   3. model looks like a local quantized artifact → yes
 *   4. provider names a cloud vendor           → no
 * Anything else is unknown, and unknown is not self-hosted — we would rather
 * miss a saving than invent electricity spend.
 */
export function isSelfHosted(
  model: string,
  endpoint?: string | null,
  provider?: string | null,
): boolean {
  if (hostForMessage(model, endpoint, provider)) return true;
  const key = (model ?? '').toLowerCase();
  if (CLOUD_SERVED_MODELS.has(key)) return false;
  if (SELF_HOSTED_MODEL_PATTERNS.some((p) => p.test(model))) return true;
  if (provider && CLOUD_PROVIDERS.has(provider)) return false;
  return false;
}

// Endpoint hostname → mesh node hostname. Source of truth for self-host attribution.
// Edit when fox stands up a new inference box.
export const ENDPOINT_TO_NODE: Record<string, string> = {
  'ai.foxhop.net':       'ai.foxhop.net',
  '3090-ai.foxhop.net':  '3090-ai.foxhop.net',
};

function hardwareForModel(model: string): string | null {
  for (const m of MODEL_HARDWARE_HINT) {
    if (m.pattern.test(model)) return m.hardware;
  }
  return null;
}

/**
 * Resolve the mesh node that served a message — strict endpoint-based.
 * Returns null when the endpoint URL isn't known or doesn't map to a node we
 * track. The UI drops the ⚡{host} badge in that case; provider="local" with
 * no endpoint becomes a generic "self-hosted, node unknown" state for the
 * dashboard to render however it wants.
 */
export function hostForMessage(
  _model: string | null | undefined,
  endpoint: string | null | undefined,
  _provider: string | null | undefined,
): string | null {
  if (!endpoint) return null;
  try {
    const url = new URL(endpoint);
    return ENDPOINT_TO_NODE[url.hostname] ?? null;
  } catch {
    return null;
  }
}

/**
 * Cloud providers that are explicitly NOT self-hosted. Used to suppress
 * the ⚡badge when the model name happens to contain "qwen" or "hermes"
 * but the call hit a remote inference API.
 */
export const CLOUD_PROVIDERS = new Set(['anthropic', 'openai', 'google', 'openrouter', 'hf-inference', 'nous']);

// $/kWh. One default for the whole system — pages used to carry their own
// `DEFAULT_KWH_RATE = 0.31` while this module used 0.33, so the same node's
// energy cost differed depending on which page you were looking at.
export const DEFAULT_KWH_RATE = 0.33;

// Override via UNFIREHOSE_KWH_RATE_USD env var. Default = CT residential.
export function getKwhRate(): number {
  const raw = typeof process !== 'undefined' ? process.env?.UNFIREHOSE_KWH_RATE_USD : undefined;
  const v = raw ? parseFloat(raw) : NaN;
  return Number.isFinite(v) && v > 0 ? v : DEFAULT_KWH_RATE;
}

/** GPU-seconds a token mix costs on one hardware profile. */
export function selfHostSeconds(
  hw: SelfHostHardware,
  input: number,
  output: number,
  cacheRead: number,
  cacheWrite: number,
): number {
  const prefill = (input + cacheWrite) / hw.prefillTokensPerSecond;
  const cached  = cacheRead / (hw.prefillTokensPerSecond * CACHE_READ_SPEEDUP);
  const decode  = output / hw.tokensPerSecond;
  return prefill + cached + decode;
}

/**
 * Electricity cost of serving a token mix on our own hardware.
 *
 * Prior versions took a single `totalTokens` and divided by the decode rate.
 * That signature is kept below as `selfHostCost` for callers that only have a
 * total, but it now assumes a decode-heavy mix and is strictly a worst case —
 * prefer selfHostCostSplit when the breakdown is available.
 */
export function selfHostCostSplit(
  model: string,
  input: number,
  output: number,
  cacheRead: number,
  cacheWrite: number,
): number {
  const hwKey = hardwareForModel(model);
  if (!hwKey) return 0;
  const hw = SELF_HOST_HARDWARE[hwKey];
  if (!hw) return 0;
  const seconds = selfHostSeconds(hw, input, output, cacheRead, cacheWrite);
  if (!seconds) return 0;
  const kwh = (hw.watts * seconds) / 3600 / 1000;
  return kwh * getKwhRate();
}

/** Legacy total-only form. Treats every token as decode — an upper bound. */
export function selfHostCost(model: string, totalTokens: number): number {
  if (!totalTokens) return 0;
  return selfHostCostSplit(model, 0, totalTokens, 0, 0);
}

// ---------------------------------------------------------------------------
// Cost
// ---------------------------------------------------------------------------

export interface CostBreakdown {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  /** What we actually pay. Invoice for cloud, electricity for self-hosted. */
  total: number;
  /**
   * What these tokens would cost at oracle rates, whoever served them. For a
   * cloud model this equals `total`. For a self-hosted model it is the market
   * price we did NOT pay.
   */
  market: number;
  /** market - total, floored at 0. Non-zero only for self-hosted rows. */
  avoided: number;
  source: PriceSource;
  /** Upstream catalog id we priced against, when there was one. */
  matchedId?: string;
  /** True when this row was served on our own hardware. */
  selfHosted: boolean;
  /**
   * Set when a promotional discount was unwound to reach list price. The UI
   * marks these, because the figure deliberately differs from what the
   * provider bills today and a reader should be able to see why.
   */
  promo?: PromoAdjustment | null;
  /** See ResolvedPrice.backdated — the price predates our ledger. */
  backdated?: boolean;
}

function applyPrice(
  p: ModelPrice,
  input: number,
  output: number,
  cacheRead: number,
  cacheWrite: number,
) {
  const i  = (input      / 1_000_000) * p.input;
  const o  = (output     / 1_000_000) * p.output;
  const cr = (cacheRead  / 1_000_000) * p.cacheRead;
  const cw = (cacheWrite / 1_000_000) * p.cacheWrite;
  return { input: i, output: o, cacheRead: cr, cacheWrite: cw, total: i + o + cr + cw };
}

export interface CostOptions {
  /** Oracle preference order. Defaults to OpenRouter-first (list price). */
  prefer?: CatalogSource[];
  /**
   * Force self-hosted accounting. When omitted we infer it from the hardware
   * hint, which is a name-regex and can be wrong for cloud-served Qwen — the
   * dashboard knows the provider and should pass this explicitly.
   */
  selfHosted?: boolean;
  /**
   * When the tokens were spent. Prices are looked up as of this instant so a
   * closed day's cost does not move when an oracle changes its number later.
   * Omit for "price at today's rate".
   */
  at?: number | string | Date | null;
}

/**
 * Split equivalent USD cost per token class, plus market and avoided cost.
 *
 * Self-hosted rows attribute electricity to `total` and leave the per-class
 * fields at 0 — energy does not separate cleanly by input vs output — while
 * `market` carries the oracle price of the same tokens. That pairing is the
 * whole point: it shows what our own hardware saved instead of burying an
 * electricity figure in a column full of invoices.
 */
export function calcCostBreakdown(
  model: string,
  input: number,
  output: number,
  cacheRead: number,
  cacheWrite: number,
  opts: CostOptions = {},
): CostBreakdown {
  const zero = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
  const resolved = resolvePrice(model, opts.prefer ?? CATALOG_SOURCES, opts.at);
  const selfHosted = opts.selfHosted ?? hardwareForModel(model) !== null;

  if (resolved?.source === 'synthetic') {
    return { ...zero, total: 0, market: 0, avoided: 0, source: 'synthetic', selfHosted: false };
  }

  const marketBreak = resolved ? applyPrice(resolved, input, output, cacheRead, cacheWrite) : null;

  if (selfHosted) {
    const energy = selfHostCostSplit(model, input, output, cacheRead, cacheWrite);
    const market = marketBreak?.total ?? 0;
    return {
      ...zero,
      total: energy,
      market,
      avoided: Math.max(0, market - energy),
      source: 'energy',
      matchedId: resolved?.matchedId,
      promo: resolved?.promo ?? null,
      backdated: resolved?.backdated ?? false,
      selfHosted: true,
    };
  }

  if (marketBreak && resolved) {
    return {
      input: marketBreak.input,
      output: marketBreak.output,
      cacheRead: marketBreak.cacheRead,
      cacheWrite: marketBreak.cacheWrite,
      total: marketBreak.total,
      market: marketBreak.total,
      avoided: 0,
      source: resolved.source,
      matchedId: resolved.matchedId,
      promo: resolved.promo ?? null,
      backdated: resolved.backdated ?? false,
      selfHosted: false,
    };
  }

  // Neither oracle nor table nor hardware hint. Report unknown — the UI must
  // render this distinctly from $0 so a missing price cannot masquerade as free.
  return { ...zero, total: 0, market: 0, avoided: 0, source: 'unknown', selfHosted: false };
}

export function calcCost(
  model: string,
  input: number,
  output: number,
  cacheRead: number,
  cacheWrite: number,
  opts: CostOptions = {},
): number {
  return calcCostBreakdown(model, input, output, cacheRead, cacheWrite, opts).total;
}

// ---------------------------------------------------------------------------
// The one entry point
// ---------------------------------------------------------------------------

/**
 * One usage row as our database records it. Whatever a caller's query looks
 * like, it can shape its rows into this.
 */
export interface UsageRow {
  model: string | null | undefined;
  input?: number | null;
  output?: number | null;
  cacheRead?: number | null;
  cacheWrite?: number | null;
  provider?: string | null;
  endpoint?: string | null;
  /**
   * When the tokens were spent — a message timestamp, a day (`2026-06-01`),
   * unix seconds or ms. Prices are booked as of this instant. Callers that
   * aggregate over a window should aggregate per day and pass the day, or
   * the sum silently reprices old tokens at today's rate.
   */
  at?: number | string | Date | null;
}

/**
 * THE cost function. Every page, route and report goes through this.
 *
 * It exists because the decisions AROUND the arithmetic are what drift, not the
 * arithmetic itself. Whether a row is self-hosted, which oracle to price it
 * against, how a missing price is reported — each caller used to answer those
 * for itself, and they answered differently:
 *
 *   /api/projects/activity   one blended Opus rate for every model  → $14
 *   /api/projects/[p]/full   per-model catalog price                → $0.70
 *   /api/alerts/[id]         a second copy of the blended rate
 *   /usage/alert/[id]        rates typed inline in JSX
 *
 * Same tokens, four numbers. Route everything here and there is one number,
 * right or wrong in one place.
 */
export function costForUsage(row: UsageRow): CostBreakdown {
  const model = row.model ?? '';
  if (!model) {
    return {
      input: 0, output: 0, cacheRead: 0, cacheWrite: 0,
      total: 0, market: 0, avoided: 0, source: 'unknown', selfHosted: false,
    };
  }
  return calcCostBreakdown(
    model,
    row.input ?? 0,
    row.output ?? 0,
    row.cacheRead ?? 0,
    row.cacheWrite ?? 0,
    {
      selfHosted: isSelfHosted(model, row.endpoint, row.provider),
      // Traffic that actually routed through Nous prices at Nous rates;
      // everything else prices at list.
      prefer: row.provider === 'nous' ? NOUS_PREFERENCE : CATALOG_SOURCES,
      at: row.at,
    },
  );
}

/** Sum costForUsage over many rows. The shape every dashboard needs. */
export function costForUsageRows(rows: Iterable<UsageRow>): CostBreakdown {
  const acc: CostBreakdown = {
    input: 0, output: 0, cacheRead: 0, cacheWrite: 0,
    total: 0, market: 0, avoided: 0, source: 'unknown', selfHosted: false,
  };
  let any = false;
  for (const r of rows) {
    const c = costForUsage(r);
    acc.input += c.input;
    acc.output += c.output;
    acc.cacheRead += c.cacheRead;
    acc.cacheWrite += c.cacheWrite;
    acc.total += c.total;
    acc.market += c.market;
    acc.avoided += c.avoided;
    acc.selfHosted = acc.selfHosted || c.selfHosted;
    acc.backdated = acc.backdated || !!c.backdated;
    // A mixed set has no single source; report the first real one we saw,
    // and the id and promo it was priced against.
    if (!any && c.source !== 'unknown') {
      acc.source = c.source;
      acc.matchedId = c.matchedId;
      acc.promo = c.promo ?? null;
      any = true;
    }
  }
  return acc;
}
