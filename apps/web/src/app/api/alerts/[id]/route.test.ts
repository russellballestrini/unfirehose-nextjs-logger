import { describe, it, expect, vi } from 'vitest';
import { NextRequest } from 'next/server';

vi.mock('@sexy-logger/core/db/ingest', () => ({
  getAlertById: vi.fn().mockImplementation((id: number) => {
    if (id === 1) return {
      id: 1, triggered_at: '2026-03-03T14:30:00Z', alert_type: 'threshold_breach',
      window_minutes: 5, metric: 'output_tokens', threshold_value: 200000,
      actual_value: 300000, project_name: null, details: '{"windowStart":"2026-03-03T14:25"}',
      acknowledged: 0,
    };
    return undefined;
  }),
  getUsageByProjectInWindow: vi.fn().mockReturnValue([
    { name: 'proj', display_name: 'proj', input_tokens: 1000, output_tokens: 500, cache_read_tokens: 0, cache_creation_tokens: 0, message_count: 5 },
  ]),
  getModelBreakdownInWindow: vi.fn().mockReturnValue([
    { model: 'claude-opus-4-6', message_count: 5, input_tokens: 1000, output_tokens: 500, cache_read_tokens: 0, cache_creation_tokens: 0 },
  ]),
  getActiveSessionsInWindow: vi.fn().mockReturnValue([]),
  getThinkingBlocksInWindow: vi.fn().mockReturnValue([]),
  getTimelineInWindow: vi.fn().mockReturnValue([]),
  getUserPromptsInWindow: vi.fn().mockReturnValue([]),
}));

const { GET } = await import('./route');

function req(url: string) {
  return new NextRequest(new URL(url, 'http://localhost:3000'));
}

describe('GET /api/alerts/:id', () => {
  it('returns 400 for non-numeric id', async () => {
    const res = await GET(req('/api/alerts/abc'), { params: Promise.resolve({ id: 'abc' }) });
    expect(res.status).toBe(400);
  });

  it('returns 404 when alert does not exist', async () => {
    const res = await GET(req('/api/alerts/999'), { params: Promise.resolve({ id: '999' }) });
    expect(res.status).toBe(404);
  });

  it('returns full alert detail with window queries', async () => {
    const res = await GET(req('/api/alerts/1'), { params: Promise.resolve({ id: '1' }) });
    const data = await res.json();
    expect(res.status).toBe(200);
    expect(data.alert.id).toBe(1);
    expect(data.window.start).toBe('2026-03-03T14:25');
    expect(data.projectBreakdown).toHaveLength(1);
    expect(data.modelBreakdown).toHaveLength(1);
    expect(data.totals).toBeDefined();
    expect(data.stats).toBeDefined();
  });
});
