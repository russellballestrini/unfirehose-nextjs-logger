import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createTestDb, seedProject, seedSession, seedMessage, seedContentBlock } from '@unturf/unfirehose/test/db-helper';

vi.mock('fs/promises', () => ({
  stat: vi.fn().mockResolvedValue({ mtimeMs: 1 }),
  readFile: vi.fn().mockResolvedValue(JSON.stringify({
    dailyActivity: [{ date: '2026-10-14', messageCount: 3 }],
    dailyModelTokens: [],
    modelUsage: {},
  })),
}));

vi.mock('@unturf/unfirehose/claude-paths', () => ({
  claudePaths: { statsCache: '/mock/.claude/stats-cache.json' },
}));

// A real in-memory database rather than a stub returning canned rows in a
// fixed order. That stub answered queries positionally — first call gets the
// sessions map, second the per-session models, and so on — so it was pinned
// to the route's query ORDER and COUNT, neither of which the route promises.
// The route grew to five queries against four canned answers, the fifth read
// `undefined`, and the failure said "expected 500 to be 200" while pointing
// at nothing. Seeded rows survive reordering, and a query the test never
// anticipated returns empty instead of exploding.
const db = createTestDb();
vi.mock('@unturf/unfirehose/db/schema', () => ({ getDb: () => db }));

const { GET } = await import('./route');
const { storePayload } = await import('@unturf/unfirehose/precomputed');

const req = async (qs = '') => {
  const { NextRequest } = await import('next/server');
  return new NextRequest(new Request(`http://localhost/api/tokens${qs}`));
};

const DAY = 86400_000;
const iso = (msAgo: number) => new Date(Date.now() - msAgo).toISOString();

function seedToolSession(project: string, harness: string, model: string, tool: string) {
  const projectId = seedProject(db, project);
  const sessionId = seedSession(db, projectId, `s-${project}`);
  db.prepare('UPDATE sessions SET harness = ? WHERE id = ?').run(harness, sessionId);
  const messageId = seedMessage(db, sessionId, { model, inputTokens: 1_000_000, outputTokens: 500_000 });
  seedContentBlock(db, messageId, { blockType: 'text' });
  seedContentBlock(db, messageId, { position: 1, blockType: 'tool_use', toolName: tool });
  return sessionId;
}

/**
 * The route serves what the worker stored, so a payload built by an earlier
 * test would answer a later one and hide the rows it just seeded.
 */
beforeEach(() => {
  db.prepare('DELETE FROM content_blocks').run();
  db.prepare('DELETE FROM messages').run();
  db.prepare('DELETE FROM sessions').run();
  db.prepare('DELETE FROM projects').run();
  db.prepare("DELETE FROM settings WHERE key LIKE 'tokens_%'").run();
});

describe('GET /api/tokens', () => {
  it('returns model breakdown with cost calculations', async () => {
    seedToolSession('proj-a', 'claude-code', 'claude-opus-4-6', 'Bash');

    const res = await GET(await req());
    const data = await res.json();
    expect(res.status).toBe(200);
    expect(data.modelBreakdown).toHaveLength(1);
    expect(data.modelBreakdown[0].costUSD).toBeGreaterThan(0);
    expect(data.toolCalls).toHaveLength(1);
    expect(data.toolCalls[0].tool_name).toBe('Bash');
    // Two, because the seeded tool call IS a content block and carries its
    // own block_type. The canned fixtures set tool rows and block types from
    // separate lists and could hold a shape real rows cannot: one block type
    // alongside a tool call that belonged to no block.
    expect(data.blockTypes.map((b: { block_type: string }) => b.block_type).sort())
      .toEqual(['text', 'tool_use']);
    // The stats-cache file rides along, whichever way the payload came.
    expect(data.dailyActivity).toEqual([{ date: '2026-10-14', messageCount: 3 }]);
    expect(data.dailyModelTokens).toEqual([]);
  });

  // The first request for a range nobody warmed builds it, and leaves it
  // for the next request — the dashboard contract.
  it('builds a range on first request and serves the store on the second', async () => {
    seedToolSession('proj-a', 'claude-code', 'claude-opus-4-6', 'Bash');

    const first = await GET(await req());
    expect(first.headers.get('Server-Timing')).toMatch(/^built;/);
    expect(first.headers.get('X-Computed-At')).toBeNull();

    const second = await GET(await req());
    expect(second.headers.get('Server-Timing')).toMatch(/^stored;/);
    expect(second.headers.get('X-Computed-At')).toBeTruthy();
    expect((await second.json()).modelBreakdown).toHaveLength(1);
  });

  // What the Tokens page actually sends: `from` as an instant, standing for
  // the range it was computed from. The worker stored that range.
  it('serves the stored range a `from` stands for, drift and all', async () => {
    storePayload('tokens_7d', { modelBreakdown: [{ model: 'from-the-worker' }], toolCalls: [] });

    const res = await GET(await req(`?from=${encodeURIComponent(iso(7 * DAY + 2 * 3600_000))}`));
    const data = await res.json();
    expect(res.status).toBe(200);
    expect(res.headers.get('Server-Timing')).toMatch(/^stored;/);
    expect(res.headers.get('X-Computed-At')).toBeTruthy();
    expect(data.modelBreakdown).toEqual([{ model: 'from-the-worker' }]);
    expect(data.dailyActivity).toHaveLength(1);
  });

  it('serves a stored payload however old it is — expiry never rebuilds here', async () => {
    storePayload('tokens_all', { modelBreakdown: [{ model: 'stale-but-served' }] });
    db.prepare("UPDATE settings SET value = ? WHERE key = 'tokens_all_at'").run('2020-01-01T00:00:00.000Z');

    const res = await GET(await req());
    expect(res.headers.get('Server-Timing')).toMatch(/^stored;/);
    expect(res.headers.get('X-Computed-At')).toBe('2020-01-01T00:00:00.000Z');
    expect((await res.json()).modelBreakdown).toEqual([{ model: 'stale-but-served' }]);
  });

  // A project filter is one of thousands; it is never stored, and it must
  // not be answered by the lifetime payload that happens to be stored.
  it('a project filter builds live, scoped to that project', async () => {
    seedToolSession('proj-a', 'claude-code', 'model-a', 'Bash');
    seedToolSession('proj-b', 'uncloseai', 'model-b', 'Edit');
    storePayload('tokens_all', { modelBreakdown: [{ model: 'wrong-answer' }] });

    const res = await GET(await req('?project=proj-b'));
    const data = await res.json();
    expect(res.headers.get('Server-Timing')).toMatch(/^live;/);
    expect(res.headers.get('X-Computed-At')).toBeNull();
    expect(data.modelBreakdown.map((m: { model: string }) => m.model)).toEqual(['model-b']);
    expect(data.toolCalls).toEqual([{ tool_name: 'Edit', count: 1 }]);
    expect(data.harnessData.map((h: { harness: string }) => h.harness)).toEqual(['uncloseai']);
  });

  it('a window between ranges, or with a `to`, builds live and stores nothing', async () => {
    seedToolSession('proj-a', 'claude-code', 'model-a', 'Bash');

    const between = await GET(await req(`?from=${encodeURIComponent(iso(10 * DAY))}`));
    expect(between.headers.get('Server-Timing')).toMatch(/^live;/);
    expect((await between.json()).modelBreakdown).toHaveLength(1);

    const bounded = await GET(await req(`?from=${encodeURIComponent(iso(10 * DAY))}&to=${encodeURIComponent(iso(5 * DAY))}`));
    expect(bounded.headers.get('Server-Timing')).toMatch(/^live;/);
    expect((await bounded.json()).modelBreakdown).toHaveLength(0);

    expect(db.prepare("SELECT COUNT(*) AS n FROM settings WHERE key LIKE 'tokens_%'").get()).toEqual({ n: 0 });
  });
});
