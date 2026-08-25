import { describe, it, expect, beforeEach } from 'vitest';
import {
  setPriceCatalog,
  resolvePrice,
  priceForModel,
  aliasCandidates,
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
  { id: 'stealth/ox-alpha',         source: 'openrouter', input: 0,  output: 0,  cacheRead: 0, cacheWrite: 0, fetchedAt: 0 },
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
    expect(c[0]).toBe('qwen/qwen3.6-27b');
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

describe('ox-alpha shadow pricing', () => {
  it('prices against qwen3.6-27b rather than its own $0 preview listing', () => {
    const p = resolvePrice('stealth/ox-alpha');
    expect(p?.matchedId).toBe('qwen/qwen3.6-27b');
    expect(p?.input).toBe(0.32);
  });

  it('is cloud-served, not self-hosted, despite provider=local', () => {
    expect(isSelfHosted('stealth/ox-alpha', null, 'local')).toBe(false);
  });

  it('turns 63M real tokens into a defensible number', () => {
    const c = calcCostBreakdown('stealth/ox-alpha', 63_242_450, 1_043_717, 0, 0, {
      selfHosted: false,
    });
    // 63.24M x $0.32/M + 1.04M x $3.20/M
    expect(c.total).toBeCloseTo(20.24 + 3.34, 1);
    expect(c.total).toBeGreaterThan(0);
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
