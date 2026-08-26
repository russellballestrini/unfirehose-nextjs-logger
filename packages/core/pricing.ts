// Model pricing — per million tokens.
// Single source of truth. Imported by every route that computes cost.
//
// Prices come from a catalog synced off two public oracles (see pricing-sync.ts):
//
//   openrouter — openrouter.ai/api/v1/models. List price. What Anthropic,
//                Qwen, xAI et al. actually bill when we call them direct.
//   nous       — inference-api.nousresearch.com/v1/models. Same catalog,
//                resold cheaper (~0.8x on frontier, deeper on their own
//                Hermes line). What we pay when we route through Nous.
//
// This module stays PURE — no DB, no network. It is a published npm export and
// reachable from client components. The catalog is injected via
// setPriceCatalog(); PRICING below is the cold-start fallback, used before the
// first sync lands and whenever both oracles are unreachable.

export interface ModelPrice {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

/** Where a price came from. Surfaced to the UI so a number is never anonymous. */
export type PriceSource =
  | 'openrouter'  // openrouter.ai list price
  | 'nous'        // Nous Portal resale price
  | 'table'       // built-in fallback below
  | 'energy'      // self-hosted; electricity, not an invoice
  | 'synthetic'   // test fixture; genuinely $0
  | 'free'        // real model, real tokens, priced at $0 by its provider
  | 'unknown';    // we could not price this — never silently render as $0

/** Oracles we sync, in the order we prefer them when no source is requested. */
export type CatalogSource = 'openrouter' | 'nous';
export const CATALOG_SOURCES: CatalogSource[] = ['openrouter', 'nous'];

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
  /** Unix seconds the row was fetched. */
  fetchedAt: number;
}

// source -> upstream id -> price. Module-level so a pure function can read it.
const catalog: Record<CatalogSource, Map<string, CatalogEntry>> = {
  openrouter: new Map(),
  nous: new Map(),
};

/** Replace the in-memory catalog for one oracle. Called after sync/hydrate. */
export function setPriceCatalog(source: CatalogSource, entries: CatalogEntry[]): void {
  const m = new Map<string, CatalogEntry>();
  for (const e of entries) m.set(e.id.toLowerCase(), e);
  catalog[source] = m;
}

export function catalogSize(source: CatalogSource): number {
  return catalog[source].size;
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

    // Anthropic names log as `claude-opus-4-8`; upstream uses `claude-opus-4.8`.
    const dotted = stem.replace(/^(claude-[a-z]+)-(\d+)-(\d+)/i, '$1-$2.$3');
    push(dotted);
    push(`anthropic/${dotted}`);

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
}

/**
 * Resolve a price for one of our model names.
 *
 * `prefer` orders the oracles. Default is OpenRouter-first: it is list price,
 * which is what we actually pay on a direct Anthropic call. Pass
 * `['nous','openrouter']` for traffic that genuinely routed through Nous.
 *
 * Falls back to the built-in table, then gives up — and says so, rather than
 * returning zeros that render as "free".
 */
export function resolvePrice(
  model: string,
  prefer: CatalogSource[] = CATALOG_SOURCES,
): ResolvedPrice | undefined {
  if (!model) return undefined;
  if (SYNTHETIC_MODELS.has(model.toLowerCase())) {
    return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, source: 'synthetic' };
  }

  const candidates = aliasCandidates(model);
  for (const source of prefer) {
    const m = catalog[source];
    if (!m.size) continue;
    for (const c of candidates) {
      const hit = m.get(c);
      if (!hit) continue;
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
      };
    }
  }

  // Cold-start / offline fallback.
  const t = PRICING[model] ?? PRICING[model.replace(/\[[^\]]*\]$/, '')];
  if (t) return { ...t, source: 'table' };

  return undefined;
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
  const resolved = resolvePrice(model, opts.prefer ?? CATALOG_SOURCES);
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
      prefer: row.provider === 'nous' ? ['nous', 'openrouter'] : ['openrouter', 'nous'],
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
    // A mixed set has no single source; report the first real one we saw.
    if (!any && c.source !== 'unknown') { acc.source = c.source; any = true; }
  }
  return acc;
}
