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
    // Query order: harnessModelRows, harnessSessionRows, toolRows, dailyByHarness, blockTypes
    mockAll
      .mockReturnValueOnce([
        { harness: 'claude-code', model: 'claude-opus-4-6', input_tokens: 1000000, output_tokens: 500000, cache_read_tokens: 0, cache_creation_tokens: 0, sessions: 1 },
      ])
      .mockReturnValueOnce([{ harness: 'claude-code', sessions: 1 }])
      .mockReturnValueOnce([{ tool_name: 'Bash', model: 'claude-opus-4-6', harness: 'claude-code', count: 50 }])
      .mockReturnValueOnce([{ date: '2026-03-10', harness: 'claude-code', tokens: 1500000, messages: 10 }])
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
