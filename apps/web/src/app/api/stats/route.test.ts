import { describe, it, expect, vi } from 'vitest';

vi.mock('fs/promises', () => ({
  readFile: vi.fn().mockResolvedValue(JSON.stringify({
    totalSessions: 10,
    totalMessages: 100,
    dailyActivity: [],
    modelUsage: {},
  })),
}));

vi.mock('@sexy-logger/core/claude-paths', () => ({
  claudePaths: { statsCache: '/mock/.claude/stats-cache.json' },
}));

const { GET } = await import('./route');

describe('GET /api/stats', () => {
  it('returns parsed stats cache JSON', async () => {
    const res = await GET();
    const data = await res.json();
    expect(res.status).toBe(200);
    expect(data.totalSessions).toBe(10);
    expect(data.totalMessages).toBe(100);
  });
});
