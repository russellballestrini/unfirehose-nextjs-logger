import { describe, it, expect, vi } from 'vitest';
import { NextRequest } from 'next/server';

vi.mock('@sexy-logger/core/db/ingest', () => ({
  getProjectActivity: vi.fn().mockReturnValue([
    { name: 'proj-1', display_name: 'Project 1', user_messages: 20, assistant_messages: 18, total_input: 1000000, total_output: 500000, total_cache_read: 100000, total_cache_write: 50000 },
  ]),
  getProjectRecentPrompts: vi.fn().mockReturnValue([
    { prompt: 'What is the status?', timestamp: '2026-03-03T14:00:00Z', session_uuid: 's1' },
  ]),
}));

const { GET } = await import('./route');

function req(url: string) {
  return new NextRequest(new URL(url, 'http://localhost:3000'));
}

describe('GET /api/projects/activity', () => {
  it('returns enriched activity with cost_estimate', async () => {
    const res = await GET(req('/api/projects/activity?days=30'));
    const data = await res.json();
    expect(res.status).toBe(200);
    expect(data).toHaveLength(1);
    expect(data[0].cost_estimate).toBeGreaterThan(0);
  });

  it('returns single project with recent prompts when project param provided', async () => {
    const res = await GET(req('/api/projects/activity?project=proj-1'));
    const data = await res.json();
    expect(data.recentPrompts).toHaveLength(1);
    expect(data.recentPrompts[0].prompt).toContain('status');
  });
});
