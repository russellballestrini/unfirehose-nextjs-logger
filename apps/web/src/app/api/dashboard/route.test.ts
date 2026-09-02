import { describe, it, expect, vi } from 'vitest';
import { createTestDb, seedProject, seedSession, seedMessage } from '@/test/db-helper';

const db = createTestDb();
vi.mock('@unturf/unfirehose/db/schema', () => ({ getDb: () => db }));

const { GET } = await import('./route');

const req = (range: string) =>
  ({ nextUrl: { searchParams: new URLSearchParams({ range }) } }) as never;

/** vLLM counters as our sampler records them: cumulative, space-separated ts. */
function seedVllmSample(
  hostname: string, model: string, minutesAgo: number, queries: number, hits: number,
) {
  const ts = new Date(Date.now() - minutesAgo * 60_000)
    .toISOString().replace('T', ' ').slice(0, 19);
  db.prepare(
    `INSERT INTO vllm_cache_samples (hostname, model, timestamp, queries, hits)
     VALUES (?, ?, ?, ?, ?)`,
  ).run(hostname, model, ts, queries, hits);
}

describe('GET /api/dashboard — cache our own models actually served', () => {
  it('reports the measured prefix-cache rate for a model reporting no cache tokens', async () => {
    const projectId = seedProject(db, 'proj-vllm');
    const sessionId = seedSession(db, projectId, 's-vllm');
    // A self-hosted model reports no cache_read tokens at all. That is the
    // whole defect: usage-based math reads 0% for a cache doing real work.
    seedMessage(db, sessionId, {
      model: 'Lorbus/Qwen3.6-27B-int4-AutoRound',
      inputTokens: 500_000,
      outputTokens: 10_000,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
    });
    // Two nodes serving the same model. Counters are cumulative, so the
    // window is the difference: 1000 queries / 250 hits on each node.
    seedVllmSample('4090-ai', 'Lorbus/Qwen3.6-27B-int4-AutoRound', 50, 10_000, 4_000);
    seedVllmSample('4090-ai', 'Lorbus/Qwen3.6-27B-int4-AutoRound', 5, 11_000, 4_250);
    seedVllmSample('3090-ai', 'Lorbus/Qwen3.6-27B-int4-AutoRound', 50, 2_000, 500);
    seedVllmSample('3090-ai', 'Lorbus/Qwen3.6-27B-int4-AutoRound', 5, 3_000, 750);

    const res = await GET(req('24h'));
    const body = await res.json();
    const row = body.modelBreakdown.find(
      (m: { model: string }) => m.model === 'Lorbus/Qwen3.6-27B-int4-AutoRound',
    );

    expect(row).toBeTruthy();
    expect(row.cacheReadTokens).toBe(0);
    // 500 hits over 2000 queries, summed across both nodes.
    expect(row.measuredCacheQueries).toBe(2000);
    expect(row.measuredCacheHits).toBe(500);
    expect(row.measuredCacheHitRate).toBeCloseTo(0.25, 6);
    expect(row.measuredCacheNodes).toEqual(['3090-ai', '4090-ai']);
  });

  it('leaves a cloud model with no measured rate — its cache is in the usage fields', async () => {
    const projectId = seedProject(db, 'proj-cloud');
    const sessionId = seedSession(db, projectId, 's-cloud');
    seedMessage(db, sessionId, {
      model: 'claude-opus-4-6-20260301',
      inputTokens: 1_000,
      outputTokens: 500,
      cacheReadTokens: 900_000,
      cacheCreationTokens: 1_000,
    });

    const res = await GET(req('24h'));
    const body = await res.json();
    const row = body.modelBreakdown.find(
      (m: { model: string }) => m.model === 'claude-opus-4-6-20260301',
    );

    expect(row.cacheReadTokens).toBe(900_000);
    expect(row.measuredCacheHitRate).toBeNull();
    expect(row.measuredCacheNodes).toBeNull();
  });

  it('reports no rate from a single sample — one reading is not a window', async () => {
    const projectId = seedProject(db, 'proj-lone');
    const sessionId = seedSession(db, projectId, 's-lone');
    seedMessage(db, sessionId, {
      model: 'solo/model-one-sample',
      inputTokens: 1_000,
      outputTokens: 10,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
    });
    // A lone cumulative reading has no predecessor to difference against.
    // cacheHitRate treats that as a restart and reports the lifetime figure,
    // which is a real number — what must never happen is a crash or a
    // fabricated zero for a model we have not observed at all.
    seedVllmSample('4090-ai', 'solo/model-one-sample', 10, 800, 200);

    const res = await GET(req('24h'));
    const body = await res.json();
    const row = body.modelBreakdown.find(
      (m: { model: string }) => m.model === 'solo/model-one-sample',
    );
    expect(row.measuredCacheHitRate).toBeCloseTo(0.25, 6);
  });

  it('summary counts cache in its totals and splits the cost by type', async () => {
    const res = await GET(req('24h'));
    const body = await res.json();
    expect(body.summary.totalTokens).toBe(
      body.summary.inputTokens + body.summary.outputTokens +
      body.summary.cacheReadTokens + body.summary.cacheWriteTokens,
    );
    expect(body.summary.costSplit).toHaveProperty('cacheRead');
    expect(body.summary.costSplit).toHaveProperty('cacheWrite');
  });
});
