// Reading vLLM's Prometheus metrics — specifically, the prefix cache.
//
// Our token pages reported "cache efficiency" as cacheRead / input, computed
// from Anthropic-style usage fields. For a self-hosted model those fields are
// zero: vLLM does not report per-request cache_read tokens, so a cache that is
// demonstrably working showed as no caching at all. Measured 2026-08-26, the
// 4090 had served 10.9B prefix-cache queries with 630M hits — a real 5.8% hit
// rate against a dashboard reading of nothing.
//
// vLLM exposes it as COUNTERS, not a rate:
//
//   vllm:prefix_cache_queries_total{model_name="..."}  10931263819
//   vllm:prefix_cache_hits_total{model_name="..."}       630469280
//
// Counters are the right shape and we keep them that way. A hit rate is a
// property of a WINDOW — the lifetime ratio tells you nothing about whether
// caching is working now, and a gauge sampled at one instant tells you nothing
// about the period between samples. Store the counters, difference them.

/** One model's cache counters at a point in time, as vLLM reported them. */
export interface VllmCacheSample {
  model: string;
  /** Tokens looked up in the prefix cache, cumulative. */
  queries: number;
  /** Tokens served from it, cumulative. */
  hits: number;
  /** KV cache utilization 0..1, a gauge — instantaneous, not cumulative. */
  kvUsage?: number;
  /** vLLM's own report of whether prefix caching is even on. */
  prefixCachingEnabled?: boolean;
  /** KV cache capacity in tokens, from cache_config_info. */
  kvCacheSizeTokens?: number;
}

const METRIC_LINE = /^([a-zA-Z_:][a-zA-Z0-9_:]*)(?:\{([^}]*)\})?\s+([-+0-9.eE]+|NaN|\+Inf|-Inf)\s*$/;

/** Parse `key="value",key2="value2"` into an object. */
export function parseLabels(raw: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!raw) return out;
  // Values may contain commas and escaped quotes, so walk rather than split.
  const re = /([a-zA-Z_][a-zA-Z0-9_]*)\s*=\s*"((?:[^"\\]|\\.)*)"/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(raw)) !== null) {
    out[m[1]] = m[2].replace(/\\(.)/g, '$1');
  }
  return out;
}

function toNumber(v: string): number | null {
  if (v === 'NaN') return null;
  if (v === '+Inf' || v === '-Inf') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/**
 * Extract per-model prefix cache counters from a Prometheus exposition body.
 *
 * Tolerates the `_created` companions vLLM emits alongside every counter —
 * those are unix timestamps, not values, and summing them into `queries`
 * would produce numbers in the billions that look plausible and are nonsense.
 */
export function parseVllmCacheMetrics(body: string): VllmCacheSample[] {
  const byModel = new Map<string, VllmCacheSample>();
  const config: { prefixCachingEnabled?: boolean; kvCacheSizeTokens?: number } = {};
  const get = (model: string): VllmCacheSample => {
    let s = byModel.get(model);
    if (!s) {
      s = { model, queries: 0, hits: 0 };
      byModel.set(model, s);
    }
    return s;
  };

  for (const raw of body.split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const m = METRIC_LINE.exec(line);
    if (!m) continue;
    const [, name, labelStr, valueStr] = m;
    if (!name.startsWith('vllm:')) continue;

    const labels = parseLabels(labelStr);
    const value = toNumber(valueStr);

    // cache_config_info carries no model_name — it describes the engine, and
    // a vLLM process serves one model. Held aside and applied to every sample
    // once parsing finishes, rather than dropped for lacking a label.
    if (name === 'vllm:cache_config_info') {
      if (labels.enable_prefix_caching) {
        config.prefixCachingEnabled = labels.enable_prefix_caching === 'True';
      }
      const size = Number(labels.kv_cache_size_tokens);
      if (Number.isFinite(size)) config.kvCacheSizeTokens = size;
      if (labels.model_name) {
        const s2 = get(labels.model_name);
        if (config.prefixCachingEnabled !== undefined) s2.prefixCachingEnabled = config.prefixCachingEnabled;
        if (config.kvCacheSizeTokens !== undefined) s2.kvCacheSizeTokens = config.kvCacheSizeTokens;
      }
      continue;
    }

    const model = labels.model_name;
    if (!model) continue;

    switch (name) {
      case 'vllm:prefix_cache_queries_total':
        if (value !== null) get(model).queries = value;
        break;
      case 'vllm:prefix_cache_hits_total':
        if (value !== null) get(model).hits = value;
        break;
      case 'vllm:kv_cache_usage_perc':
        if (value !== null) get(model).kvUsage = value;
        break;
      default:
        break;   // `_created` and everything else deliberately ignored
    }
  }

  const out = [...byModel.values()];
  for (const s of out) {
    if (s.prefixCachingEnabled === undefined && config.prefixCachingEnabled !== undefined) {
      s.prefixCachingEnabled = config.prefixCachingEnabled;
    }
    if (s.kvCacheSizeTokens === undefined && config.kvCacheSizeTokens !== undefined) {
      s.kvCacheSizeTokens = config.kvCacheSizeTokens;
    }
  }
  return out;
}

export interface CacheHitRate {
  model: string;
  /** Hits / queries over the interval, 0..1. Null when nothing was queried. */
  hitRate: number | null;
  /** Tokens looked up during the interval. */
  queries: number;
  /** Tokens served from cache during the interval. */
  hits: number;
}

/**
 * Hit rate between two counter samples.
 *
 * Differencing rather than dividing the lifetime totals, because a hit rate is
 * a property of a window: a box that cached well all week and badly today
 * still shows a healthy lifetime ratio, which is the opposite of useful.
 *
 * A counter that went backwards means vLLM restarted and reset it. That is
 * reported as a fresh window (the later value taken as the delta) rather than
 * a negative rate — losing one interval beats emitting a nonsense number.
 */
export function cacheHitRate(
  before: VllmCacheSample | undefined,
  after: VllmCacheSample,
): CacheHitRate {
  const restarted =
    !before || after.queries < before.queries || after.hits < before.hits;
  const queries = restarted ? after.queries : after.queries - before.queries;
  const hits = restarted ? after.hits : after.hits - before.hits;
  return {
    model: after.model,
    queries,
    hits,
    hitRate: queries > 0 ? Math.min(1, hits / queries) : null,
  };
}

/**
 * Fraction of prompt tokens served from cache, from usage accounting.
 *
 * This is what a hit rate means for a cloud provider that bills cache reads
 * separately: of everything we sent as prompt, how much did not have to be
 * processed fresh.
 *
 * The tokens page previously showed `cacheRead / input` and labelled it
 * "cache efficiency Nx". That is not a rate — it has fresh input in the
 * denominator instead of total prompt, so it is unbounded and reads as a
 * multiplier. A run with 90% cache hits reported "9x", which is the same
 * number a reader would get from a 900% hit rate.
 */
export function usageCacheHitRate(input: number, cacheRead: number): number | null {
  const prompt = input + cacheRead;
  return prompt > 0 ? cacheRead / prompt : null;
}
