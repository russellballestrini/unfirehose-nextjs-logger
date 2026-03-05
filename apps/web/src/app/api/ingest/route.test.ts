import { describe, it, expect, vi } from 'vitest';

vi.mock('@unfirehose/core/db/ingest', () => ({
  ingestAll: vi.fn().mockResolvedValue({
    projectsAdded: 1, sessionsAdded: 2, messagesAdded: 10, blocksAdded: 20, filesScanned: 3, alertsTriggered: 0,
  }),
  getDbStats: vi.fn().mockReturnValue({
    projects: 5, sessions: 10, messages: 100, contentBlocks: 200, thinkingBlocks: 30, totalTokensStored: 50000, alerts: 2,
  }),
}));

const { GET, POST } = await import('./route');

describe('GET /api/ingest', () => {
  it('returns db stats', async () => {
    const res = await GET();
    const data = await res.json();
    expect(res.status).toBe(200);
    expect(data.projects).toBe(5);
    expect(data.messages).toBe(100);
  });
});

describe('POST /api/ingest', () => {
  it('calls ingestAll and returns result with db stats', async () => {
    const res = await POST();
    const data = await res.json();
    expect(res.status).toBe(200);
    expect(data.ingested.messagesAdded).toBe(10);
    expect(data.db.projects).toBe(5);
  });
});
