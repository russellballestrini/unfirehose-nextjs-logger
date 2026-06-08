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

// Watts = observed spike during active inference. Cost per hour at $0.33/kWh:
// 4090 = $0.142/h, 3090 = $0.0825/h.
export const SELF_HOST_HARDWARE: Record<string, SelfHostHardware> = {
  '4090': { watts: 430, tokensPerSecond: 70,  label: 'RTX 4090' },
  '3090': { watts: 250, tokensPerSecond: 100, label: 'RTX 3090' },
};

// Model-name → hardware key, used for cost ESTIMATION only (watts × throughput).
// Attribution to a specific node comes from endpoint/provider — see hostForMessage.
export const MODEL_HARDWARE_HINT: Array<{ pattern: RegExp; hardware: string }> = [
  { pattern: /qwen/i,   hardware: '4090' },
  { pattern: /hermes/i, hardware: '3090' },
];

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
export const CLOUD_PROVIDERS = new Set(['anthropic', 'openai', 'google', 'openrouter', 'hf-inference']);

// $/kWh — override via UNFIREHOSE_KWH_RATE_USD env var. Default = CT residential.
export function getKwhRate(): number {
  const raw = process.env.UNFIREHOSE_KWH_RATE_USD;
  const v = raw ? parseFloat(raw) : NaN;
  return Number.isFinite(v) && v > 0 ? v : 0.33;
}

export function selfHostCost(model: string, totalTokens: number): number {
  if (!totalTokens) return 0;
  const hwKey = hardwareForModel(model);
  if (!hwKey) return 0;
  const hw = SELF_HOST_HARDWARE[hwKey];
  if (!hw) return 0;
  const seconds = totalTokens / hw.tokensPerSecond;
  const kwh = (hw.watts * seconds) / 3600 / 1000;
  return kwh * getKwhRate();
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
