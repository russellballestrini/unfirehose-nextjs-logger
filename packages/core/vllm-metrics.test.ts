import { describe, it, expect } from 'vitest';
import {
  parseVllmCacheMetrics,
  parseLabels,
  cacheHitRate,
  usageCacheHitRate,
} from './vllm-metrics.js';

// Verbatim from 4090-ai.foxhop.net:18888/metrics on 2026-08-26, trimmed to the
// cache lines. The `_created` companions are included on purpose: they are unix
// timestamps sitting next to the counters, and reading one as a value gives a
// number in the billions that looks entirely plausible.
const REAL = `
# HELP vllm:prefix_cache_queries_total Prefix cache queries, in terms of number of queried tokens.
# TYPE vllm:prefix_cache_queries_total counter
vllm:prefix_cache_queries_total{engine="0",model_name="Lorbus/Qwen3.6-27B-int4-AutoRound"} 1.0931263819e+10
# HELP vllm:prefix_cache_queries_created Prefix cache queries, in terms of number of queried tokens.
# TYPE vllm:prefix_cache_queries_created gauge
vllm:prefix_cache_queries_created{engine="0",model_name="Lorbus/Qwen3.6-27B-int4-AutoRound"} 1.7869106011177013e+09
vllm:prefix_cache_hits_total{engine="0",model_name="Lorbus/Qwen3.6-27B-int4-AutoRound"} 6.3046928e+08
vllm:prefix_cache_hits_created{engine="0",model_name="Lorbus/Qwen3.6-27B-int4-AutoRound"} 1.7869106011177013e+09
vllm:kv_cache_usage_perc{engine="0",model_name="Lorbus/Qwen3.6-27B-int4-AutoRound"} 0.0
vllm:cache_config_info{block_size="1568",cache_dtype="fp8",enable_prefix_caching="True",engine="0",kv_cache_size_tokens="66901",num_gpu_blocks="49"} 1.0
`;

describe('parsing real vLLM output', () => {
  const samples = parseVllmCacheMetrics(REAL);

  it('finds the model', () => {
    expect(samples).toHaveLength(1);
    expect(samples[0].model).toBe('Lorbus/Qwen3.6-27B-int4-AutoRound');
  });

  it('reads counters in scientific notation', () => {
    expect(samples[0].queries).toBe(10_931_263_819);
    expect(samples[0].hits).toBe(630_469_280);
  });

  it('ignores the _created timestamps sitting beside the counters', () => {
    // 1.7869106011177013e+09 is a unix time. Read as a counter it is a
    // believable 1.8B and would silently corrupt every rate computed from it.
    expect(samples[0].queries).not.toBe(1_786_910_601);
    expect(samples[0].hits).not.toBe(1_786_910_601);
  });

  it('applies engine-level cache config to the model', () => {
    // cache_config_info carries no model_name — one vLLM process, one model.
    expect(samples[0].prefixCachingEnabled).toBe(true);
    expect(samples[0].kvCacheSizeTokens).toBe(66_901);
  });

  it('keeps kv usage as the gauge it is', () => {
    expect(samples[0].kvUsage).toBe(0);
  });

  it('gives the lifetime rate our node actually had', () => {
    const s = samples[0];
    expect((s.hits / s.queries) * 100).toBeCloseTo(5.77, 1);
  });
});

describe('parseLabels', () => {
  it('handles commas inside values', () => {
    expect(parseLabels('a="x,y",b="z"')).toEqual({ a: 'x,y', b: 'z' });
  });
  it('handles escaped quotes', () => {
    expect(parseLabels('a="he said \\"hi\\""')).toEqual({ a: 'he said "hi"' });
  });
  it('tolerates no labels', () => {
    expect(parseLabels(undefined)).toEqual({});
  });
});

describe('cacheHitRate — a rate belongs to a window', () => {
  const base = { model: 'm', queries: 1_000_000, hits: 500_000 };

  it('differences counters rather than dividing lifetimes', () => {
    const after = { model: 'm', queries: 1_100_000, hits: 510_000 };
    const r = cacheHitRate(base, after);
    expect(r.queries).toBe(100_000);
    expect(r.hits).toBe(10_000);
    expect(r.hitRate).toBeCloseTo(0.1);          // recent window is 10%…
    expect(after.hits / after.queries).toBeCloseTo(0.46);  // …lifetime says 46%
  });

  it('treats a counter reset as a fresh window, never a negative rate', () => {
    const after = { model: 'm', queries: 2_000, hits: 800 };
    const r = cacheHitRate(base, after);
    expect(r.hitRate).toBeCloseTo(0.4);
    expect(r.queries).toBe(2_000);
  });

  it('reports null rather than 0 when nothing was queried', () => {
    const r = cacheHitRate(base, { ...base });
    expect(r.queries).toBe(0);
    expect(r.hitRate).toBeNull();
  });

  it('treats a first sample as the whole window', () => {
    const r = cacheHitRate(undefined, base);
    expect(r.hitRate).toBeCloseTo(0.5);
  });

  it('clamps a rate above 1 rather than reporting 130% hits', () => {
    const r = cacheHitRate({ model: 'm', queries: 0, hits: 0 }, { model: 'm', queries: 10, hits: 13 });
    expect(r.hitRate).toBe(1);
  });
});

describe('usageCacheHitRate — the fix for the tokens page', () => {
  it('is a fraction of prompt, not a multiple of fresh input', () => {
    // The old page computed cacheRead / input and printed it as "Nx".
    const input = 151_310;
    const cacheRead = 12_136_423_346;
    const old = cacheRead / input;                       // 80,209x
    const correct = usageCacheHitRate(input, cacheRead)!;
    expect(old).toBeGreaterThan(1000);
    expect(correct).toBeLessThanOrEqual(1);
    expect(correct * 100).toBeCloseTo(100, 0);
  });

  it('never exceeds 1', () => {
    expect(usageCacheHitRate(1, 1_000_000)!).toBeLessThanOrEqual(1);
  });

  it('is 0 when nothing was cached, not undefined', () => {
    expect(usageCacheHitRate(1_091_954_235, 0)).toBe(0);
  });

  it('is null when there was no prompt at all', () => {
    expect(usageCacheHitRate(0, 0)).toBeNull();
  });

  it('reads 50% when half the prompt came from cache', () => {
    expect(usageCacheHitRate(500, 500)).toBeCloseTo(0.5);
  });
});
