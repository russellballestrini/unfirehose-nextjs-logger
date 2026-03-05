import { describe, it, expect, vi } from 'vitest';
import { NextRequest } from 'next/server';

vi.mock('@unfirehose/core/db/ingest', () => ({
  getRecentAlerts: vi.fn().mockReturnValue([{ id: 1, metric: 'output_tokens' }]),
  getUnacknowledgedAlerts: vi.fn().mockReturnValue([{ id: 2, acknowledged: 0 }]),
  getAlertThresholds: vi.fn().mockReturnValue([{ id: 1, window_minutes: 5 }]),
  acknowledgeAlert: vi.fn(),
  updateAlertThreshold: vi.fn(),
}));

const { GET, POST } = await import('./route');

function req(url: string, init?: RequestInit) {
  return new NextRequest(new URL(url, 'http://localhost:3000'), init);
}

describe('GET /api/alerts', () => {
  it('returns recent alerts by default', async () => {
    const res = await GET(req('/api/alerts'));
    const data = await res.json();
    expect(data).toHaveLength(1);
    expect(data[0].metric).toBe('output_tokens');
  });

  it('returns unacknowledged alerts when filter=unacknowledged', async () => {
    const res = await GET(req('/api/alerts?filter=unacknowledged'));
    const data = await res.json();
    expect(data).toHaveLength(1);
    expect(data[0].acknowledged).toBe(0);
  });

  it('returns thresholds when filter=thresholds', async () => {
    const res = await GET(req('/api/alerts?filter=thresholds'));
    const data = await res.json();
    expect(data).toHaveLength(1);
    expect(data[0].window_minutes).toBe(5);
  });
});

describe('POST /api/alerts', () => {
  it('acknowledges an alert', async () => {
    const res = await POST(req('/api/alerts', {
      method: 'POST',
      body: JSON.stringify({ action: 'acknowledge', id: 1 }),
    }));
    const data = await res.json();
    expect(data.ok).toBe(true);
  });

  it('updates a threshold', async () => {
    const res = await POST(req('/api/alerts', {
      method: 'POST',
      body: JSON.stringify({ action: 'update_threshold', id: 1, value: 100000, enabled: true }),
    }));
    const data = await res.json();
    expect(data.ok).toBe(true);
  });

  it('returns 400 for unknown action', async () => {
    const res = await POST(req('/api/alerts', {
      method: 'POST',
      body: JSON.stringify({ action: 'unknown' }),
    }));
    expect(res.status).toBe(400);
  });
});
