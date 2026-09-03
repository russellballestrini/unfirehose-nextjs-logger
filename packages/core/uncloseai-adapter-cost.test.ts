import { describe, it, expect } from 'vitest';
import { normalizeNativeEntry } from '@unturf/unfirehose/uncloseai-adapter';

// The 2026-09-02 Gemini defect ran the whole length of this chain: the
// gateway quoted a price, uncloseai logged it, and every mapping between
// there and the database dropped it on the floor.
describe('a quoted price survives the adapter chain', () => {
  const entry = (usage: any) => ({
    type: 'message', role: 'assistant', content: [], model: 'google/gemini-3.8-flash', usage,
  });

  it('carries costUSD through to the intermediate shape', () => {
    const n: any = normalizeNativeEntry(entry({
      inputTokens: 900, outputTokens: 100, costUSD: 0.00042,
    }));
    expect(n.message.usage.cost_usd).toBe(0.00042);
  });

  it('leaves an unquoted call null, never zero', () => {
    const n: any = normalizeNativeEntry(entry({ inputTokens: 900, outputTokens: 100 }));
    expect(n.message.usage.cost_usd).toBeNull();
  });
});
