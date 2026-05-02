// Anthropic API pricing per million tokens.
// Single source of truth — imported by every route that computes cost.
// Cache read ≈ 10% of input. Cache write ≈ 125% of input.

export interface ModelPrice {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

export const PRICING: Record<string, ModelPrice> = {
  // Opus tier
  'claude-opus-4-7':            { input: 5, output: 25, cacheRead: 0.50, cacheWrite: 6.25 },
  'claude-opus-4-6':            { input: 5, output: 25, cacheRead: 0.50, cacheWrite: 6.25 },
  'claude-opus-4-5-20251101':   { input: 5, output: 25, cacheRead: 0.50, cacheWrite: 6.25 },

  // Sonnet tier
  'claude-sonnet-4-6':          { input: 3, output: 15, cacheRead: 0.30, cacheWrite: 3.75 },
  'claude-sonnet-4-5-20250929': { input: 3, output: 15, cacheRead: 0.30, cacheWrite: 3.75 },
  'claude-sonnet-4-20250514':   { input: 3, output: 15, cacheRead: 0.30, cacheWrite: 3.75 },

  // Haiku tier
  'claude-haiku-4-5-20251001':  { input: 1, output:  5, cacheRead: 0.10, cacheWrite: 1.25 },
};

export function calcCost(
  model: string,
  input: number,
  output: number,
  cacheRead: number,
  cacheWrite: number,
): number {
  const p = PRICING[model];
  if (!p) return 0;
  return (
    (input      / 1_000_000) * p.input +
    (output     / 1_000_000) * p.output +
    (cacheRead  / 1_000_000) * p.cacheRead +
    (cacheWrite / 1_000_000) * p.cacheWrite
  );
}
