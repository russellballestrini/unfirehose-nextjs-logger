import { describe, it, expect, beforeEach } from 'vitest';
import {
  setPriceCatalog,
  resolvePrice,
  priceForModel,
  aliasCandidates,
  undiscount,
  calcCostBreakdown,
  isSelfHosted,
  selfHostSeconds,
  selfHostCostSplit,
  SELF_HOST_HARDWARE,
  type CatalogEntry,
} from './pricing.js';

// Real prices, as served by both oracles on 2026-08-25. Per MILLION tokens.
const OPENROUTER: CatalogEntry[] = [
  { id: 'anthropic/claude-opus-5',  source: 'openrouter', input: 5,  output: 25, cacheRead: 0.5, cacheWrite: 6.25, fetchedAt: 0 },
  { id: 'anthropic/claude-opus-4.8', source: 'openrouter', input: 5,  output: 25, cacheRead: 0.5, cacheWrite: 6.25, fetchedAt: 0 },
  { id: 'anthropic/claude-fable-5', source: 'openrouter', input: 10, output: 50, cacheRead: 1.0, cacheWrite: 12.5, fetchedAt: 0 },
  { id: 'qwen/qwen3.6-27b',         source: 'openrouter', input: 0.32, output: 3.2, cacheRead: 0, cacheWrite: 0, fetchedAt: 0 },
  // ox-alpha de-cloaked as glm-5.3-flash on 2026-08-26 and the stealth id was
  // dropped from the catalog — deliberately absent here, so the pin is doing
  // real work rather than papering over a $0 listing that still exists.
  { id: 'z-ai/glm-5.3-flash',       source: 'openrouter', input: 0.075, output: 0.25, cacheRead: 0.015, cacheWrite: 0, fetchedAt: 0 },
];

const NOUS: CatalogEntry[] = [
  { id: 'anthropic/claude-opus-5',  source: 'nous', input: 4, output: 20, cacheRead: 0.4, cacheWrite: 5, fetchedAt: 0 },
  { id: 'qwen/qwen3.6-27b',         source: 'nous', input: 0.256, output: 2.56, cacheRead: 0, cacheWrite: 0, fetchedAt: 0 },
];

beforeEach(() => {
  setPriceCatalog('openrouter', OPENROUTER);
  setPriceCatalog('nous', NOUS);
});

describe('alias resolution', () => {
  it('maps claude-opus-5 onto the anthropic namespace', () => {
    expect(aliasCandidates('claude-opus-5')).toContain('anthropic/claude-opus-5');
  });

  it('strips a context-window tag', () => {
    expect(aliasCandidates('claude-opus-5[1m]')).toContain('anthropic/claude-opus-5');
  });

  it('converts our dashed version to the upstream dotted one', () => {
    expect(aliasCandidates('claude-opus-4-8')).toContain('anthropic/claude-opus-4.8');
  });

  it('strips vendor prefix and quantization from a self-hosted repo name', () => {
    expect(aliasCandidates('Lorbus/Qwen3.6-27B-int4-AutoRound')).toContain('qwen/qwen3.6-27b');
  });

  it('puts an explicit pin ahead of the model own id', () => {
    const c = aliasCandidates('stealth/ox-alpha');
    expect(c[0]).toBe('z-ai/glm-5.3-flash');
  });
});

describe('the defect this fixes: opus-5 priced at $0', () => {
  it('prices claude-opus-5 from the catalog', () => {
    const p = resolvePrice('claude-opus-5');
    expect(p?.source).toBe('openrouter');
    expect(p?.input).toBe(5);
    expect(p?.output).toBe(25);
  });

  it('bills a real opus-5 window instead of reporting free', () => {
    // 28-day window measured from ~/.unfirehose/unfirehose.db on 2026-08-25.
    const c = calcCostBreakdown('claude-opus-5', 151_310, 28_513_535, 12_136_423_346, 144_394_447);
    // cache read dominates: 12,136M x $0.50/M
    expect(c.cacheRead).toBeCloseTo(6068.21, 1);
    expect(c.total).toBeGreaterThan(7000);
    expect(c.source).toBe('openrouter');
  });

  it('never reports a priced model as costing nothing', () => {
    const c = calcCostBreakdown('claude-opus-5', 1_000_000, 1_000_000, 0, 0);
    expect(c.total).toBeGreaterThan(0);
  });
});

describe('oracle preference', () => {
  it('defaults to OpenRouter list price', () => {
    expect(resolvePrice('claude-opus-5')?.input).toBe(5);
  });

  it('uses Nous resale price when asked', () => {
    expect(resolvePrice('claude-opus-5', ['nous'])?.input).toBe(4);
  });

  it('falls back to the next oracle when one lacks the model', () => {
    // fable-5 is in our OpenRouter fixture but not the Nous one.
    expect(resolvePrice('claude-fable-5', ['nous', 'openrouter'])?.input).toBe(10);
  });

  it('falls back to the built-in table when no catalog is loaded', () => {
    setPriceCatalog('openrouter', []);
    setPriceCatalog('nous', []);
    const p = resolvePrice('claude-opus-5');
    expect(p?.source).toBe('table');
    expect(p?.input).toBe(5);
  });
});

describe('ox-alpha pinning', () => {
  it('prices against the model it de-cloaked as, at LIST not promo', () => {
    const p = resolvePrice('stealth/ox-alpha');
    expect(p?.matchedId).toBe('z-ai/glm-5.3-flash');
    // Catalog says 0.075 — that is a 50% launch discount. List is 0.15.
    expect(p?.input).toBe(0.15);
    expect(p?.output).toBe(0.5);
    expect(p?.promo?.multiplier).toBe(2);
  });

  it('still resolves now that the stealth id is gone from the catalog', () => {
    // The pin is load-bearing: without it this model has no price at all,
    // because no oracle lists `stealth/ox-alpha` any more.
    expect(resolvePrice('stealth/ox-alpha')?.source).toBe('openrouter');
  });

  it('is cloud-served, not self-hosted, despite provider=local', () => {
    expect(isSelfHosted('stealth/ox-alpha', null, 'local')).toBe(false);
  });

  it('turns 63M real tokens into a defensible number', () => {
    const c = calcCostBreakdown('stealth/ox-alpha', 63_242_450, 1_043_717, 0, 0, {
      selfHosted: false,
    });
    // 63.24M x $0.15/M + 1.04M x $0.50/M — list, not the launch discount
    expect(c.total).toBeCloseTo(9.49 + 0.52, 1);
    expect(c.total).toBeGreaterThan(0);
  });

  it('costs far less than the interim Qwen guess implied', () => {
    // The stand-in was 4.7x too expensive. A plausible neighbour is not a price.
    const real = calcCostBreakdown('stealth/ox-alpha', 63_242_450, 1_043_717, 0, 0,
      { selfHosted: false }).total;
    const qwenGuess = (63_242_450 / 1e6) * 0.32 + (1_043_717 / 1e6) * 3.2;
    expect(qwenGuess / real).toBeGreaterThan(2);
  });
});

describe('self-host detection', () => {
  it('treats a quantized repo artifact as self-hosted', () => {
    expect(isSelfHosted('Lorbus/Qwen3.6-27B-int4-AutoRound', null, 'local')).toBe(true);
    expect(isSelfHosted('solidrust/Hermes-3-Llama-3.1-8B-AWQ', null, 'hermes')).toBe(true);
  });

  it('treats a bare upstream catalog id as cloud', () => {
    expect(isSelfHosted('qwen/qwen3.6-27b', null, 'local')).toBe(false);
    expect(isSelfHosted('qwen/qwen3.8-27b', null, 'local')).toBe(false);
  });

  it('trusts a known endpoint over everything else', () => {
    expect(isSelfHosted('claude-opus-5', 'https://ai.foxhop.net/v1', null)).toBe(true);
  });

  it('does not guess self-hosted from an unknown name', () => {
    expect(isSelfHosted('some/unknown-model', null, null)).toBe(false);
  });
});

describe('prefill and decode are billed at their own rates', () => {
  const hw = SELF_HOST_HARDWARE['4090'];

  it('does not charge prompt tokens at the decode rate', () => {
    const prefillHeavy = selfHostSeconds(hw, 1_000_000, 0, 0, 0);
    const decodeHeavy  = selfHostSeconds(hw, 0, 1_000_000, 0, 0);
    expect(decodeHeavy).toBeGreaterThan(prefillHeavy * 10);
  });

  it('keeps a real 28-day Qwen window inside 28 days of GPU time', () => {
    // The old math billed 1,091.9M prefill tokens at 70 tok/s = 183 GPU-days
    // inside a 28-day window. Physically impossible.
    const seconds = selfHostSeconds(hw, 1_091_954_235, 14_972_952, 0, 0);
    const days = seconds / 86_400;
    expect(days).toBeLessThan(28);
  });

  it('costs a self-hosted window far below the old inflated figure', () => {
    const cost = selfHostCostSplit('Lorbus/Qwen3.6-27B-int4-AutoRound', 1_091_954_235, 14_972_952, 0, 0);
    expect(cost).toBeGreaterThan(0);
    expect(cost).toBeLessThan(100); // old math produced $623.31
  });
});

describe('market and avoided cost', () => {
  it('reports what our own hardware saved', () => {
    const c = calcCostBreakdown(
      'Lorbus/Qwen3.6-27B-int4-AutoRound',
      1_091_954_235, 14_972_952, 0, 0,
      { selfHosted: true },
    );
    expect(c.source).toBe('energy');
    expect(c.market).toBeGreaterThan(c.total);   // cloud would have cost more
    expect(c.avoided).toBeCloseTo(c.market - c.total, 6);
  });

  it('leaves avoided at zero for cloud rows', () => {
    const c = calcCostBreakdown('claude-opus-5', 1_000_000, 1_000_000, 0, 0);
    expect(c.avoided).toBe(0);
    expect(c.market).toBe(c.total);
  });
});

describe('zero is never ambiguous', () => {
  it('labels test fixtures synthetic', () => {
    for (const m of ['mock-1m', 'fake-model-1', '<synthetic>']) {
      const c = calcCostBreakdown(m, 200, 50, 0, 0);
      expect(c.source).toBe('synthetic');
      expect(c.total).toBe(0);
    }
  });

  it('reports an unpriceable model as unknown, not as free', () => {
    const c = calcCostBreakdown('some/model-nobody-lists', 1_000_000, 1_000_000, 0, 0);
    expect(c.source).toBe('unknown');
  });

  it('keeps priceForModel undefined for synthetic models', () => {
    expect(priceForModel('mock-1m')).toBeUndefined();
  });
});

describe('local weights filenames resolve to the model they build', () => {
  it('peels a GGUF filename back to the base model', () => {
    expect(aliasCandidates('Qwen3.6-27B-UD-Q4_K_XL.gguf')).toContain('qwen/qwen3.6-27b');
  });

  it('peels an hf.co repo path with a quant tag', () => {
    const c = aliasCandidates('hf.co/bartowski/NousResearch_NousCoder-14B-GGUF:Q4');
    expect(c).toContain('nouscoder-14b');
  });

  it('strips a vendor prefix and an FP8 marker', () => {
    expect(aliasCandidates('adamo1139/Hermes-3-Llama-3.1-8B-FP8-Dynamic'))
      .toContain('nousresearch/hermes-3-llama-3.1-8b');
  });

  it('prices a real 76M-token GGUF window instead of dropping it', () => {
    const c = calcCostBreakdown('Qwen3.6-27B-UD-Q4_K_XL.gguf', 76_000_000, 59_863, 0, 0, {
      selfHosted: true,
    });
    expect(c.market).toBeGreaterThan(0);
    expect(c.source).toBe('energy');
  });
});


describe('promotional discounts are unwound to list price', () => {
  it('does not book a limited-time discount as the permanent price', () => {
    // OpenRouter's /models returns the promo number with nothing to mark it:
    // no flag, no original, and expiration_date reads 2098-12-31. Left alone,
    // a model that is briefly half price looks permanently cheap, and routing
    // toward it is how a bill doubles when the promo ends.
    const p = resolvePrice('z-ai/glm-5.3-flash')!;
    expect(p.input).toBe(0.15);        // catalog holds 0.075
    expect(p.promo).not.toBeNull();
    expect(p.promo?.notedOn).toBe('2026-08-26');
  });

  it('leaves a model with no known promo untouched', () => {
    const p = resolvePrice('claude-opus-5')!;
    expect(p.input).toBe(5);
    expect(p.promo ?? null).toBeNull();
  });

  it('undiscount is a no-op for an unlisted model', () => {
    const before = { input: 1, output: 2, cacheRead: 3, cacheWrite: 4 };
    const { price, promo } = undiscount('some/model', before);
    expect(price).toEqual(before);
    expect(promo).toBeNull();
  });

  it('scales every token class, not just input', () => {
    const { price } = undiscount('z-ai/glm-5.3-flash',
      { input: 1, output: 2, cacheRead: 3, cacheWrite: 4 });
    expect(price).toEqual({ input: 2, output: 4, cacheRead: 6, cacheWrite: 8 });
  });
});

// ---------------------------------------------------------------------------
// The history book — pure, no DB. The ledger tests in pricing-sync.test.ts
// prove the same properties end to end.
// ---------------------------------------------------------------------------

import {
  setPriceHistory,
  clearPriceCatalogs,
  priceAt,
  toUnixSeconds,
  priceConsensus,
  costForUsage,
  costForUsageRows,
  CATALOG_SOURCES,
  LIST_PRICE_SOURCES,
  NOUS_PREFERENCE,
  type UsageRow,
} from './pricing.js';

describe('price history', () => {
  const JUNE = Date.UTC(2026, 5, 1) / 1000;
  const SEPT = Date.UTC(2026, 8, 1) / 1000;
  const OPUS_HISTORY: CatalogEntry[] = [
    // Deliberately out of order — setPriceHistory sorts.
    { id: 'anthropic/claude-opus-5', source: 'openrouter', input: 10, output: 50, cacheRead: 1, cacheWrite: 12.5, fetchedAt: SEPT, effectiveFrom: SEPT, effectiveTo: null },
    { id: 'anthropic/claude-opus-5', source: 'openrouter', input: 5,  output: 25, cacheRead: 0.5, cacheWrite: 6.25, fetchedAt: SEPT, effectiveFrom: JUNE, effectiveTo: SEPT },
  ];

  beforeEach(() => {
    clearPriceCatalogs();
    setPriceCatalog('openrouter', [OPUS_HISTORY[0]]);
    setPriceHistory('openrouter', OPUS_HISTORY);
  });

  it('accepts ISO, unix seconds and unix milliseconds', () => {
    expect(toUnixSeconds('2026-06-01T00:00:00Z')).toBe(JUNE);
    expect(toUnixSeconds('2026-06-01')).toBe(JUNE);
    expect(toUnixSeconds(JUNE)).toBe(JUNE);
    expect(toUnixSeconds(JUNE * 1000)).toBe(JUNE);
    expect(toUnixSeconds(String(JUNE))).toBe(JUNE);
    expect(toUnixSeconds(new Date(JUNE * 1000))).toBe(JUNE);
    expect(toUnixSeconds(undefined)).toBeUndefined();
    expect(toUnixSeconds('not a date')).toBeUndefined();
  });

  it('returns the row whose range covers the instant', () => {
    expect(priceAt('openrouter', 'anthropic/claude-opus-5', JUNE + 86400)!.entry.input).toBe(5);
    expect(priceAt('openrouter', 'anthropic/claude-opus-5', SEPT)!.entry.input).toBe(10);
    // Range end is exclusive: the last second of the old price is still old.
    expect(priceAt('openrouter', 'anthropic/claude-opus-5', SEPT - 1)!.entry.input).toBe(5);
  });

  it('backdates to the earliest row before the book opened, and says so', () => {
    const r = priceAt('openrouter', 'anthropic/claude-opus-5', JUNE - 86400)!;
    expect(r.entry.input).toBe(5);
    expect(r.backdated).toBe(true);
  });

  it('resolvePrice with `at` reads history; without it reads the catalog', () => {
    expect(resolvePrice('claude-opus-5', undefined, '2026-07-01')).toMatchObject({ input: 5, effectiveFrom: JUNE, effectiveTo: SEPT, backdated: false });
    expect(resolvePrice('claude-opus-5')).toMatchObject({ input: 10, source: 'openrouter' });
  });

  it('falls through to the current catalog for a source with no history', () => {
    setPriceCatalog('nous', [{ id: 'anthropic/claude-opus-5', source: 'nous', input: 4, output: 20, cacheRead: 0.4, cacheWrite: 5, fetchedAt: 0 }]);
    expect(resolvePrice('claude-opus-5', ['nous'], '2026-07-01')).toMatchObject({ input: 4, source: 'nous' });
  });

  it('a window summed per day does not move when today\'s price does', () => {
    const rows: UsageRow[] = [
      { model: 'claude-opus-5', input: 1_000_000, at: '2026-06-10' },
      { model: 'claude-opus-5', input: 1_000_000, at: '2026-09-10' },
    ];
    const booked = costForUsageRows(rows);
    expect(booked.total).toBe(15);              // 5 + 10
    expect(booked.backdated).toBe(false);
    // The same tokens, summed first and priced today, would say 20.
    expect(costForUsage({ model: 'claude-opus-5', input: 2_000_000 }).total).toBe(20);
  });
});

describe('consensus', () => {
  beforeEach(() => {
    clearPriceCatalogs();
    setPriceCatalog('openrouter', [{ id: 'anthropic/claude-fable-5.1', source: 'openrouter', input: 10, output: 50, cacheRead: 0.25, cacheWrite: 12.5, fetchedAt: 0 }]);
    setPriceCatalog('modelsdev',  [{ id: 'anthropic/claude-fable-5-1', source: 'modelsdev',  input: 10, output: 50, cacheRead: 0.25, cacheWrite: 12.5, fetchedAt: 0 }]);
    setPriceCatalog('litellm',    [{ id: 'claude-fable-5-1',           source: 'litellm',    input: 10, output: 50, cacheRead: 0.25, cacheWrite: 12.5, fetchedAt: 0 }]);
    setPriceCatalog('llmprices',  [{ id: 'anthropic/claude-fable-5-1', source: 'llmprices',  input: 10, output: 50, cacheRead: 0.25, cacheWrite: 0,    fetchedAt: 0 }]);
    setPriceCatalog('nous',       [{ id: 'anthropic/claude-fable-5.1', source: 'nous',       input: 8,  output: 40, cacheRead: 0.2,  cacheWrite: 10,   fetchedAt: 0 }]);
  });

  it('preference order is list price first and Nous last', () => {
    expect(CATALOG_SOURCES[0]).toBe('openrouter');
    expect(CATALOG_SOURCES[CATALOG_SOURCES.length - 1]).toBe('nous');
    expect(LIST_PRICE_SOURCES).not.toContain('nous');
    expect(NOUS_PREFERENCE[0]).toBe('nous');
  });

  it('a missing cache-write column is not a disagreement', () => {
    const c = priceConsensus('claude-fable-5-1');
    expect(c.quotes).toHaveLength(4);
    expect(c.agree).toBe(true);
    expect(c.spread).toBe(0);
    expect(c.corroborated).toBe(3);
    expect(c.resale?.source).toBe('nous');
  });

  it('a one-cent rounding difference still agrees; a 3x does not', () => {
    setPriceCatalog('litellm', [{ id: 'claude-fable-5-1', source: 'litellm', input: 10.05, output: 50, cacheRead: 0, cacheWrite: 0, fetchedAt: 0 }]);
    expect(priceConsensus('claude-fable-5-1').agree).toBe(true);
    setPriceCatalog('litellm', [{ id: 'claude-fable-5-1', source: 'litellm', input: 30, output: 150, cacheRead: 0, cacheWrite: 0, fetchedAt: 0 }]);
    const c = priceConsensus('claude-fable-5-1');
    expect(c.agree).toBe(false);
    expect(c.corroborated).toBe(2);
  });

  it('a synthetic model has no quotes and nothing to agree on', () => {
    const c = priceConsensus('mock-1m');
    expect(c.quotes).toEqual([]);
    expect(c.agree).toBe(true);
  });
});
