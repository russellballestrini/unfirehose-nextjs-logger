import { describe, it, expect, vi } from 'vitest';
import { createTestDb, seedProject, seedSession, seedMessage, seedContentBlock } from '@/test/db-helper';

vi.mock('fs/promises', () => ({
  readFile: vi.fn().mockResolvedValue(JSON.stringify({
    dailyActivity: [],
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

describe('GET /api/tokens', () => {
  it('returns model breakdown with cost calculations', async () => {
    const projectId = seedProject(db, 'proj-a');
    const sessionId = seedSession(db, projectId, 's1');
    db.prepare('UPDATE sessions SET harness = ? WHERE id = ?')
      .run('claude-code', sessionId);
    const messageId = seedMessage(db, sessionId, {
      model: 'claude-opus-4-6',
      inputTokens: 1_000_000,
      outputTokens: 500_000,
    });
    seedContentBlock(db, messageId, { blockType: 'text' });
    seedContentBlock(db, messageId, {
      position: 1, blockType: 'tool_use', toolName: 'Bash',
    });

    const req = new Request('http://localhost/api/tokens');
    const { NextRequest } = await import('next/server');
    const res = await GET(new NextRequest(req));
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
  });
});
