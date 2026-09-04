import { describe, it, expect, vi } from 'vitest';

vi.mock('@unturf/unfirehose/db/ingest', () => ({
  ingestAll: vi.fn().mockResolvedValue({
    projectsAdded: 1, sessionsAdded: 2, messagesAdded: 10,
    blocksAdded: 20, filesScanned: 3, alertsTriggered: 0,
  }),
  getDbStats: vi.fn().mockReturnValue({
    projects: 5, sessions: 10, messages: 100, contentBlocks: 200,
    thinkingBlocks: 30, totalTokensStored: 50000, alerts: 2,
  }),
}));

const { GET, POST } = await import('./route');

describe('/api/ingest', () => {
  it('reports what the database holds', async () => {
    const data = await (await GET()).json();
    expect(data.projects).toBe(5);
    expect(data.messages).toBe(100);
  });

  it('runs a pass and reports both what landed and what is there now', async () => {
    const data = await (await POST()).json();
    expect(data.ingested.messagesAdded).toBe(10);
    expect(data.db.projects).toBe(5);
  });
});
