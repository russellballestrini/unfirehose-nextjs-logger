import { describe, it, expect, vi } from 'vitest';

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

const mockAll = vi.fn();
vi.mock('@unturf/unfirehose/db/schema', () => ({
  getDb: () => ({
    prepare: () => ({ all: mockAll }),
  }),
}));

const { GET } = await import('./route');

describe('GET /api/tokens', () => {
  it('returns model breakdown with cost calculations', async () => {
    // Query order: sessions-map, perSessionModel, toolRows, blockTypes
    // (dailyByHarness is derived in JS from perSessionModel.last_ts — no SQL.)
    mockAll
      .mockReturnValueOnce([{ id: 1, harness: 'claude-code' }])
      .mockReturnValueOnce([
        { session_id: 1, model: 'claude-opus-4-6', input_tokens: 1000000, output_tokens: 500000, cache_read_tokens: 0, cache_creation_tokens: 0, messages: 5, last_ts: '2026-03-10T12:00:00Z' },
      ])
      .mockReturnValueOnce([{ tool_name: 'Bash', model: 'claude-opus-4-6', session_id: 1, count: 50 }])
      .mockReturnValueOnce([{ block_type: 'text', count: 100 }]);

    const req = new Request('http://localhost/api/tokens');
    const { NextRequest } = await import('next/server');
    const res = await GET(new NextRequest(req));
    const data = await res.json();
    expect(res.status).toBe(200);
    expect(data.modelBreakdown).toHaveLength(1);
    expect(data.modelBreakdown[0].costUSD).toBeGreaterThan(0);
    expect(data.toolCalls).toHaveLength(1);
    expect(data.blockTypes).toHaveLength(1);
  });
});
