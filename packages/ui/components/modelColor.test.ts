import { describe, it, expect } from 'vitest';
import { getModelColor } from './modelColor';

// Every model this database held on 2026-09-04. The old hardcoded map matched
// none of the first six, which is how the donut went grey.
const LIVE_MODELS = [
  'claude-opus-5', 'claude-fable-5-1', 'claude-opus-4-8', 'claude-sonnet-5',
  'Lorbus/Qwen3.6-27B-int4-AutoRound', 'google/gemini-3.8-flash',
  'grok-4.20-0309-non-reasoning', 'claude-opus-4-7', 'claude-opus-4-6',
  'claude-sonnet-4-6', 'claude-haiku-4-5', 'meituan/longcat-2.0:free',
  'hermes-3-8b', 'stealth/ox-alpha', 'qwen3.6:27b',
];

const hueOf = (c: string) => Number(/hsl\((\d+)/.exec(c)![1]);

describe('getModelColor', () => {
  it('gives every live model a colour, and never the fallback grey', () => {
    for (const m of LIVE_MODELS) {
      const c = getModelColor(m);
      expect(c, m).toMatch(/^hsl\(\d+ \d+% \d+%\)$/);
      expect(c, m).not.toBe('hsl(220 9% 46%)');
    }
  });

  it('is stable — the same model is the same colour every call', () => {
    for (const m of LIVE_MODELS) expect(getModelColor(m)).toBe(getModelColor(m));
  });

  it('separates siblings within a family', () => {
    const opus = ['claude-opus-5', 'claude-opus-4-8', 'claude-opus-4-7', 'claude-opus-4-6'];
    expect(new Set(opus.map(getModelColor)).size).toBe(opus.length);
  });

  it('keeps a family recognisable: opus purple, sonnet green, haiku amber', () => {
    for (const m of ['claude-opus-5', 'claude-opus-4-6']) {
      expect(Math.abs(hueOf(getModelColor(m)) - 275), m).toBeLessThanOrEqual(12);
    }
    for (const m of ['claude-sonnet-5', 'claude-sonnet-4-6']) {
      expect(Math.abs(hueOf(getModelColor(m)) - 158), m).toBeLessThanOrEqual(12);
    }
    expect(Math.abs(hueOf(getModelColor('claude-haiku-4-5')) - 43)).toBeLessThanOrEqual(12);
  });

  it('reads a vendor out of a prefixed or suffixed id', () => {
    // The same family however the harness spells it.
    for (const q of ['qwen3.6:27b', 'Lorbus/Qwen3.6-27B-int4-AutoRound', 'qwen/qwen3.8-27b']) {
      expect(Math.abs(hueOf(getModelColor(q)) - 190), q).toBeLessThanOrEqual(12);
    }
  });

  it('a model nobody has heard of still gets a distinct, stable colour', () => {
    const a = getModelColor('some-vendor/brand-new-model-9');
    const b = getModelColor('another-vendor/unheard-of-2');
    expect(a).toMatch(/^hsl\(\d+ 62% 64%\)$/);
    expect(a).not.toBe(b);
    expect(getModelColor('some-vendor/brand-new-model-9')).toBe(a);
  });

  it('only a missing model is grey', () => {
    expect(getModelColor('')).toBe('hsl(220 9% 46%)');
    expect(getModelColor(null)).toBe('hsl(220 9% 46%)');
    expect(getModelColor(undefined)).toBe('hsl(220 9% 46%)');
  });

  it('the live set is visually distinguishable — no two share a colour', () => {
    expect(new Set(LIVE_MODELS.map(getModelColor)).size).toBe(LIVE_MODELS.length);
  });
});
