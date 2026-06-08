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

// Self-hosted hardware power+throughput. cost ≈ tokens × watts / tok/s / 3600s/h / 1000W/kW × $/kWh
export interface SelfHostHardware {
  watts: number;            // typical inference draw
  tokensPerSecond: number;  // typical decode throughput
  label: string;
}

export const SELF_HOST_HARDWARE: Record<string, SelfHostHardware> = {
  '4090': { watts: 400, tokensPerSecond: 70,  label: 'RTX 4090' },
  '3090': { watts: 300, tokensPerSecond: 100, label: 'RTX 3090' },
};

// Model-name pattern → hardware key. First match wins.
export const SELF_HOST_MAP: Array<{ pattern: RegExp; hardware: string }> = [
  { pattern: /qwen/i,   hardware: '4090' },
  { pattern: /hermes/i, hardware: '3090' },
];

// Hardware key → mesh_snapshots.hostname. Lets us join model usage to real
// nvidia-smi watt readings. Eyeball-edit when fox moves a model between nodes.
export const SELF_HOST_NODE: Record<string, string> = {
  '4090': 'ai.foxhop.net',
  '3090': '3090-ai.foxhop.net',
};

export function hostForModel(model: string): string | null {
  for (const m of SELF_HOST_MAP) {
    if (m.pattern.test(model)) return SELF_HOST_NODE[m.hardware] ?? null;
  }
  return null;
}

// $/kWh — override via UNFIREHOSE_KWH_RATE_USD env var. Default = CT residential.
export function getKwhRate(): number {
  const raw = process.env.UNFIREHOSE_KWH_RATE_USD;
  const v = raw ? parseFloat(raw) : NaN;
  return Number.isFinite(v) && v > 0 ? v : 0.33;
}

export function selfHostCost(model: string, totalTokens: number): number {
  if (!totalTokens) return 0;
  for (const m of SELF_HOST_MAP) {
    if (m.pattern.test(model)) {
      const hw = SELF_HOST_HARDWARE[m.hardware];
      if (!hw) return 0;
      const seconds = totalTokens / hw.tokensPerSecond;
      const kwh = (hw.watts * seconds) / 3600 / 1000;
      return kwh * getKwhRate();
    }
  }
  return 0;
}

export function calcCost(
  model: string,
  input: number,
  output: number,
  cacheRead: number,
  cacheWrite: number,
): number {
  const p = PRICING[model];
  if (p) {
    return (
      (input      / 1_000_000) * p.input +
      (output     / 1_000_000) * p.output +
      (cacheRead  / 1_000_000) * p.cacheRead +
      (cacheWrite / 1_000_000) * p.cacheWrite
    );
  }
  return selfHostCost(model, input + output + cacheRead + cacheWrite);
}
