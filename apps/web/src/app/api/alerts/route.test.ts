import { describe, it, expect, vi } from 'vitest';
import { NextRequest } from 'next/server';

vi.mock('@unturf/unfirehose/db/ingest', () => ({
  getRecentAlerts: vi.fn().mockReturnValue([{ id: 1, metric: 'output_tokens' }]),
  getUnacknowledgedAlerts: vi.fn().mockReturnValue([{ id: 2, acknowledged: 0 }]),
  getAlertThresholds: vi.fn().mockReturnValue([{ id: 1, window_minutes: 5, metric: 'output_tokens', threshold_value: 200000 }]),
  acknowledgeAlert: vi.fn(),
  updateAlertThreshold: vi.fn(),
  acknowledgeAlertsForThreshold: vi.fn().mockReturnValue(3),
  calibrateAlertThresholds: vi.fn().mockReturnValue([{ id: 1, window_minutes: 5, metric: 'output_tokens', previous: 200000, p95: 100000, threshold: 150000, samples: 10, acknowledged: 3 }]),
  getAlertDailyCounts: vi.fn().mockReturnValue([{ day: '2026-09-03', window_minutes: 15, metric: 'total_tokens', count: 4, unacknowledged: 2, peak: 45 }]),
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

  it('updates a threshold and acknowledges alerts open against the old value', async () => {
    const res = await POST(req('/api/alerts', {
      method: 'POST',
      body: JSON.stringify({ action: 'update_threshold', id: 1, value: 100000, enabled: true }),
    }));
    const data = await res.json();
    expect(data.ok).toBe(true);
    expect(data.acknowledged).toBe(3);
  });

  it('leaves alerts alone when only the enabled flag changes', async () => {
    const res = await POST(req('/api/alerts', {
      method: 'POST',
      body: JSON.stringify({ action: 'update_threshold', id: 1, value: 200000, enabled: false }),
    }));
    const data = await res.json();
    expect(data.acknowledged).toBe(0);
  });

  it('calibrates thresholds from history', async () => {
    const res = await POST(req('/api/alerts', {
      method: 'POST',
      body: JSON.stringify({ action: 'calibrate', days: 7 }),
    }));
    const data = await res.json();
    expect(data.ok).toBe(true);
    expect(data.results[0].threshold).toBe(150000);
  });

  it('returns daily breach counts when filter=daily', async () => {
    const res = await GET(req('/api/alerts?filter=daily&days=14'));
    const data = await res.json();
    expect(data[0].count).toBe(4);
  });

  it('returns 400 for unknown action', async () => {
    const res = await POST(req('/api/alerts', {
      method: 'POST',
      body: JSON.stringify({ action: 'unknown' }),
    }));
    expect(res.status).toBe(400);
  });
});
