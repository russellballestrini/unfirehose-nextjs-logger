import { describe, it, expect, beforeEach, vi } from 'vitest';
import { createTestDb } from '@unturf/unfirehose/test/db-helper';

/**
 * The providence cache: a question, an answer, and everything needed to
 * tell whether the same question would get the same answer again.
 *
 * A cached answer is only reusable if the conditions that produced it are
 * the same, so the cache key covers the model, its revision, its
 * quantization, the seed and the conversation it happened in. Getting that
 * wrong does not fail — it silently serves an answer from a different
 * model, which is the one outcome a provenance record exists to prevent.
 */

const db = createTestDb();
vi.mock('@unturf/unfirehose/db/schema', async (original) => ({
  ...(await original<Record<string, unknown>>()),
  getDb: () => db,
}));

const { GET, POST, DELETE } = await import('./route');

const post = (body: unknown) => POST({ json: async () => body } as never);
const get = (query = '') =>
  GET({ nextUrl: { searchParams: new URLSearchParams(query) } } as never);
const del = (query: string) =>
  DELETE({ nextUrl: { searchParams: new URLSearchParams(query) } } as never);

const record = (over: Record<string, unknown> = {}) => ({
  document_root: 'sha256:root', document_uri: 'https://unturf.com/docs/a',
  question_text: 'what does gaugeColor do?', answer_text: 'it maps a percentage to a colour',
  model_id: 'qwen3-coder', backend: 'vllm', node_id: 'cammy', ...over,
});

beforeEach(() => {
  db.prepare('DELETE FROM providence_cache').run();
});

describe('POST', () => {
  it('refuses a record missing any of the four things that make it one', async () => {
    for (const missing of ['document_root', 'document_uri', 'question_text', 'answer_text']) {
      const body = record();
      delete (body as Record<string, unknown>)[missing];
      const res = await post(body);
      expect(res.status).toBe(400);
      expect((await res.json()).error).toContain(missing);
    }
  });

  it('stores a record and hands back its key', async () => {
    const res = await post(record());
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body).toMatchObject({ hit: false });
    expect(body.cache_key).toMatch(/^[0-9a-f]{16,}$/);
  });

  it('counts a repeat as a hit rather than storing it twice', async () => {
    const first = await (await post(record())).json();
    const second = await (await post(record())).json();
    expect(second).toMatchObject({ id: first.id, cache_key: first.cache_key, hit: true });
    expect(db.prepare('SELECT COUNT(*) c FROM providence_cache').get()).toEqual({ c: 1 });
    expect(db.prepare('SELECT hit_count h FROM providence_cache').get()).toEqual({ h: 1 });
  });

  it('treats a different model as a different record', async () => {
    // The same question of a different model is a different answer. One
    // key for both serves whichever was cached first.
    const a = await (await post(record())).json();
    const b = await (await post(record({ model_id: 'claude-opus-5' }))).json();
    expect(b.cache_key).not.toBe(a.cache_key);
  });

  it('separates two revisions of the same model', async () => {
    const a = await (await post(record())).json();
    const b = await (await post(record({ model_revision: '2026-09-01' }))).json();
    expect(b.cache_key).not.toBe(a.cache_key);
  });

  it('separates a quantized model from the one it was quantized from', async () => {
    // Same weights, different arithmetic, different answers.
    const a = await (await post(record())).json();
    const b = await (await post(record({ quantization: 'q4_K_M' }))).json();
    expect(b.cache_key).not.toBe(a.cache_key);
  });

  it('separates two seeds', async () => {
    const a = await (await post(record({ seed: 1 }))).json();
    const b = await (await post(record({ seed: 2 }))).json();
    expect(b.cache_key).not.toBe(a.cache_key);
  });

  it('separates the same question asked in two conversations', async () => {
    const a = await (await post(record({ conversation_hash: 'convo-a' }))).json();
    const b = await (await post(record({ conversation_hash: 'convo-b' }))).json();
    expect(b.cache_key).not.toBe(a.cache_key);
  });

  it('does not key on which document the question came from', async () => {
    // The root is the content; the uri is where it happened to be served.
    // Two mirrors of the same document must share a cached answer.
    const a = await (await post(record())).json();
    const b = await (await post(record({ document_uri: 'https://mirror.example/docs/a' }))).json();
    expect(b).toMatchObject({ id: a.id, hit: true });
  });

  it('defaults the fields a minimal caller leaves out', async () => {
    await post(record());
    const row = db.prepare('SELECT source_type, privacy_mode, merkle_proof FROM providence_cache').get() as
      { source_type: string; privacy_mode: string; merkle_proof: string };
    expect(row).toMatchObject({ source_type: 'web', privacy_mode: 'transparent' });
    expect(JSON.parse(row.merkle_proof)).toEqual([]);
  });

  it('keeps the sampling settings that produced the answer', async () => {
    // Temperature alone is enough to make an answer unreproducible, and
    // this record is the only place it is written down.
    await post(record({ temperature: 0.7, top_p: 0.95, top_k: 40, max_tokens: 2048, inference_ms: 812 }));
    expect(db.prepare('SELECT temperature, top_p, top_k, max_tokens, inference_ms FROM providence_cache').get())
      .toEqual({ temperature: 0.7, top_p: 0.95, top_k: 40, max_tokens: 2048, inference_ms: 812 });
  });
});

describe('GET', () => {
  it('answers with nothing rather than everything for an unknown filter', async () => {
    await post(record());
    expect(await (await get('uri=https://nowhere.invalid')).json()).toMatchObject({ total: 0, rows: [] });
  });

  it('filters by each field it advertises', async () => {
    await post(record());
    await post(record({ document_uri: 'https://unturf.com/docs/b', question_text: 'and this one?', node_id: 'guile' }));
    for (const [q, n] of [
      ['uri=https://unturf.com/docs/a', 1], ['root=sha256:root', 2],
      ['node_id=guile', 1], ['backend=vllm', 2], ['model_id=qwen3-coder', 2],
    ] as const) {
      expect((await (await get(q)).json()).total).toBe(n);
    }
  });

  it('caps a limit somebody set too high', async () => {
    // The rows carry full answer text; an unbounded query is megabytes.
    await post(record());
    expect((await (await get('limit=100000')).json()).rows.length).toBeLessThanOrEqual(200);
  });

  it('returns the newest first, which is the one worth seeing', async () => {
    await post(record());
    await post(record({ question_text: 'a later question' }));
    const { rows } = await (await get('root=sha256:root')).json();
    expect(rows).toHaveLength(2);
  });
});

describe('DELETE', () => {
  it('refuses to delete without being told what', async () => {
    await post(record());
    expect((await del('')).status).toBe(400);
    expect(db.prepare('SELECT COUNT(*) c FROM providence_cache').get()).toEqual({ c: 1 });
  });

  it('deletes one record by id', async () => {
    const { id } = await (await post(record())).json();
    expect(await (await del(`id=${id}`)).json()).toEqual({ deleted: 1 });
  });

  it('deletes every record for a document', async () => {
    await post(record());
    await post(record({ question_text: 'another question' }));
    expect(await (await del('uri=https://unturf.com/docs/a')).json()).toEqual({ deleted: 2 });
  });

  it('reports deleting nothing rather than failing', async () => {
    expect(await (await del('id=9999')).json()).toEqual({ deleted: 0 });
  });
});
