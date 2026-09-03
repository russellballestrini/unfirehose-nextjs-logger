import { describe, it, expect } from 'vitest';
import {
  structuralPrefixReuse,
  structuralPrefixReuseBySession,
  VLLM_BLOCK_TOKENS,
} from './prefix-reuse.js';

describe('structural prefix reuse', () => {
  it('the first call in a session can reuse nothing', () => {
    expect(structuralPrefixReuse([1000])).toEqual({ prompt: 1000, reusable: 0, rate: 0 });
  });

  it('a growing conversation reuses the previous prompt entire', () => {
    // 1024 fresh (64 whole blocks), then 1600 of which those 1024 were
    // already sent. Block-aligned on purpose so flooring is not the subject.
    const r = structuralPrefixReuse([1024, 1600]);
    expect(r.prompt).toBe(2624);
    expect(r.reusable).toBe(1024);
  });

  it('floors to vLLM block size — the cache matches whole blocks', () => {
    // 1005 shared, block 16 → 62 blocks → 992, not 1005.
    const r = structuralPrefixReuse([1005, 2000]);
    expect(r.reusable).toBe(992);
    expect(1005 % VLLM_BLOCK_TOKENS).not.toBe(0);
  });

  it('a shrinking prompt only shares what both calls hold', () => {
    // Context was trimmed: 5000 then 800. At most 800 can have been held.
    const r = structuralPrefixReuse([5000, 800]);
    expect(r.reusable).toBe(800);
  });

  it('never claims reuse across a session boundary', () => {
    // Two separate conversations of the same shape. Pairing them across the
    // boundary would invent a shared prefix that never existed.
    const together = structuralPrefixReuse([1024, 1600, 1024, 1600]);
    const apart = structuralPrefixReuseBySession([[1024, 1600], [1024, 1600]]);
    expect(apart.reusable).toBe(2048);
    expect(together.reusable).toBeGreaterThan(apart.reusable);
  });

  it('ignores calls that reported no prompt at all', () => {
    const r = structuralPrefixReuse([1024, 0, 1600]);
    expect(r.prompt).toBe(2624);
    expect(r.reusable).toBe(1024);
  });

  it('reports no rate when there were no prompt tokens', () => {
    expect(structuralPrefixReuse([]).rate).toBeNull();
    expect(structuralPrefixReuse([0, 0]).rate).toBeNull();
  });

  it('reproduces the measured Qwen window', () => {
    // 2026-08-27..09-03: 791,265,227 prompt tokens over 2,247 sessions came
    // to 727,463,680 reusable — 91.9%. The shape, not the total, is the
    // claim under test: a long agent loop is nearly all re-send.
    const loop = [];
    for (let n = 1; n <= 200; n++) loop.push(n * 5000);
    const r = structuralPrefixReuse(loop);
    expect(r.rate).toBeGreaterThan(0.9);
    expect(r.rate).toBeLessThan(1);
  });
});
