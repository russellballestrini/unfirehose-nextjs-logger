import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';
import { createTestDb } from '@unturf/unfirehose/test/db-helper';

/**
 * Real-user web vitals: the browser posts one sample per metric per page
 * load, and the performance page reads percentiles per page back. Against
 * a real migrated database.
 */
const db = createTestDb();
vi.mock('@unturf/unfirehose/db/schema', () => ({ getDb: () => db }));

const { GET, POST } = await import('./route');

const post = (body: unknown) =>
  POST(new NextRequest('http://localhost/api/metrics', { method: 'POST', body: typeof body === 'string' ? body : JSON.stringify(body) }));
const get = async (qs = '') => (await GET(new NextRequest(`http://localhost/api/metrics${qs}`))).json();

const sample = { pathname: '/live', metric: 'LCP', value: 1200, rating: 'good' };

beforeEach(() => { db.prepare('DELETE FROM web_vitals').run(); });

describe('POST /api/metrics', () => {
  it('records a valid sample, with its session when given', async () => {
    const res = await post({ ...sample, sessionId: 'tab-1' });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(db.prepare('SELECT pathname, metric, value, rating, session_id FROM web_vitals').get())
      .toEqual({ pathname: '/live', metric: 'LCP', value: 1200, rating: 'good', session_id: 'tab-1' });
  });

  it('refuses a sample missing a field, or with a field of the wrong type', async () => {
    for (const bad of [{ ...sample, pathname: undefined }, { ...sample, value: '1200' }, { ...sample, rating: 3 }, { ...sample, metric: null }]) {
      const res = await post(bad);
      expect(res.status).toBe(400);
      expect((await res.json()).error).toBe('missing required field');
    }
  });

  it('refuses a metric or rating outside the web-vitals vocabulary', async () => {
    const m = await post({ ...sample, metric: 'FID' });
    expect(m.status).toBe(400);
    expect((await m.json()).error).toBe('unknown metric FID');
    const r = await post({ ...sample, rating: 'great' });
    expect(r.status).toBe(400);
    expect((await r.json()).error).toBe('unknown rating great');
  });

  it('answers 500 for a body that is not JSON', async () => {
    expect((await post('{nope')).status).toBe(500);
    expect(db.prepare('SELECT COUNT(*) c FROM web_vitals').get()).toEqual({ c: 0 });
  });
});

describe('GET /api/metrics', () => {
  const insert = (pathname: string, metric: string, value: number, ts = Date.now()) =>
    db.prepare('INSERT INTO web_vitals (ts, pathname, metric, value, rating) VALUES (?, ?, ?, ?, ?)').run(ts, pathname, metric, value, 'good');

  it('reads nothing as no aggregates', async () => {
    expect(await get()).toEqual({ days: 7, totalSamples: 0, aggregates: [] });
  });

  it('interpolates percentiles per page and metric, busiest page first', async () => {
    for (const v of [100, 200, 300, 400, 500]) insert('/busy', 'TTFB', v);
    insert('/busy', 'CLS', 0.125);
    insert('/quiet', 'LCP', 900);
    const body = await get();
    expect(body.totalSamples).toBe(7);
    expect(body.aggregates.map((a: { pathname: string }) => a.pathname)).toEqual(['/busy', '/quiet']);
    expect(body.aggregates[0].metrics.TTFB).toEqual({ count: 5, p50: 300, p75: 400, p95: 480 });
    // One sample is every percentile; values round to two places.
    expect(body.aggregates[0].metrics.CLS).toEqual({ count: 1, p50: 0.13, p75: 0.13, p95: 0.13 });
    expect(body.aggregates[1].metrics.LCP).toEqual({ count: 1, p50: 900, p75: 900, p95: 900 });
  });

  it('reads only the window asked for, clamped to 1..90 days', async () => {
    insert('/old', 'LCP', 1, Date.now() - 10 * 86_400_000);
    insert('/new', 'LCP', 2);
    expect((await get()).aggregates.map((a: { pathname: string }) => a.pathname)).toEqual(['/new']);
    const wide = await get('?days=30');
    expect(wide.days).toBe(30);
    expect(wide.totalSamples).toBe(2);
    expect((await get('?days=0')).days).toBe(1);
    expect((await get('?days=1000')).days).toBe(90);
  });
});
