import { describe, it, expect } from 'vitest';
import { buildCacheKey, sha256short } from './providence-key';

const base = { document_root: 'repo@abc123', question_text: 'what does gaugeColor do?' };

describe('sha256short', () => {
  it('is the first sixteen hex characters of a SHA-256', async () => {
    const hash = await sha256short('hello');
    expect(hash).toHaveLength(16);
    expect(hash).toMatch(/^[0-9a-f]{16}$/);
    // Pinned: this is a stored format, so changing it orphans every row.
    expect(hash).toBe('2cf24dba5fb0a30e');
  });
});

describe('buildCacheKey', () => {
  it('gives the same key for the same question', async () => {
    const a = await buildCacheKey(base);
    const b = await buildCacheKey({ ...base });
    expect(a.cache_key).toBe(b.cache_key);
    expect(a.question_hash).toBe(await sha256short(base.question_text));
  });

  it('changes when any tier-1 input changes', async () => {
    // Each of these changes the answer, so each has to change the key or a
    // reader gets a cached answer produced under different conditions.
    const { cache_key } = await buildCacheKey(base);
    for (const differing of [
      { ...base, question_text: 'something else' },
      { ...base, document_root: 'other-repo' },
      { ...base, model_id: 'hermes-3-8b' },
      { ...base, model_revision: 'r2' },
      { ...base, quantization: 'q4' },
      { ...base, conversation_hash: 'abc' },
      { ...base, seed: 7 },
    ]) {
      expect((await buildCacheKey(differing)).cache_key, JSON.stringify(differing)).not.toBe(cache_key);
    }
  });

  it('separates a single question from the same question mid-conversation', async () => {
    // The whole reason conversation_hash exists: the same final question
    // after different history is a different question.
    const alone = await buildCacheKey(base);
    const inContext = await buildCacheKey({ ...base, conversation_hash: 'deadbeef' });
    expect(inContext.cache_key).not.toBe(alone.cache_key);
    // But the question itself is unchanged, so its hash is too.
    expect(inContext.question_hash).toBe(alone.question_hash);
  });

  it('treats an absent field as empty rather than omitting it', async () => {
    // Omitting would shift the remaining fields left, so a record with no
    // quantization could collide with one that has no model_revision.
    const missingQuant = await buildCacheKey({ ...base, model_revision: 'r1', quantization: null });
    const missingRev = await buildCacheKey({ ...base, model_revision: null, quantization: 'r1' });
    expect(missingQuant.cache_key).not.toBe(missingRev.cache_key);
  });

  it('reads a seed of 0 as a seed, not as absent', async () => {
    // The classic falsy bug, and here it silently merges two runs.
    const zero = await buildCacheKey({ ...base, seed: 0 });
    const none = await buildCacheKey({ ...base, seed: null });
    expect(zero.cache_key).not.toBe(none.cache_key);
  });

  it('agrees whether the seed arrives as a number or as a query string', async () => {
    // The writer POSTs JSON and gets a number; the reader parses a URL and
    // gets a string. They must land on the same key or nothing ever hits.
    const fromWriter = await buildCacheKey({ ...base, seed: 42 });
    const fromReader = await buildCacheKey({ ...base, seed: '42' });
    expect(fromReader.cache_key).toBe(fromWriter.cache_key);
  });

  it('ignores tier-2 metadata it is not given', async () => {
    // Temperature, backend and node_id describe how an answer was produced,
    // not what was asked, so they are stored for audit and stay out of the key.
    const withExtras = await buildCacheKey({ ...base, ...{ temperature: 0.7, backend: 'vllm' } } as never);
    expect(withExtras.cache_key).toBe((await buildCacheKey(base)).cache_key);
  });
});
