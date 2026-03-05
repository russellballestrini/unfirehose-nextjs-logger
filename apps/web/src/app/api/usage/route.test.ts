import { describe, it, expect, vi } from 'vitest';
import { NextRequest } from 'next/server';

vi.mock('@unfirehose/core/db/ingest', () => ({
  getUsageTimeline: vi.fn().mockReturnValue([
    { minute: '2026-03-03T14:00', input_tokens: 1000, output_tokens: 500 },
  ]),
  getUsageByProject: vi.fn().mockReturnValue([
    { name: 'proj-1', input_tokens: 5000, output_tokens: 2000 },
  ]),
}));

const { GET } = await import('./route');

function req(url: string) {
  return new NextRequest(new URL(url, 'http://localhost:3000'));
}

describe('GET /api/usage', () => {
  it('returns timeline data by default', async () => {
    const res = await GET(req('/api/usage'));
    const data = await res.json();
    expect(data).toHaveLength(1);
    expect(data[0].minute).toBe('2026-03-03T14:00');
  });

  it('returns project data when view=projects', async () => {
    const res = await GET(req('/api/usage?view=projects'));
    const data = await res.json();
    expect(data).toHaveLength(1);
    expect(data[0].name).toBe('proj-1');
  });
});
