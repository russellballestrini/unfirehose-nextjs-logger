import { describe, it, expect, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { createTestDb } from '@unturf/unfirehose/test/db-helper';

const db = createTestDb();
vi.mock('@unturf/unfirehose/db/schema', () => ({ getDb: () => db }));

const { GET, POST } = await import('./route');

const post = (body: unknown) => POST(new NextRequest('http://localhost/api/db/health', { method: 'POST', body: JSON.stringify(body) }));

describe('/api/db/health', () => {
  it('GET answers before any snapshot exists, with live sizes and no table breakdown', async () => {
    const body = await (await GET()).json();
    expect(body.snapshot).toBeNull();
    expect(body.dbBytes).toBeGreaterThan(0);
    expect(body.freelistBytes).toBe(0);
    expect(body.retention).toMatchObject({ days: null, minDays: 30 });
    expect(body.cold).toEqual({ blocks: 0, rawBytes: 0, storedBytes: 0 });
    expect(body.lowDiskBytes).toBe(10 * 1024 ** 3);
  });

  it('POST measure records today and GET then serves its tables', async () => {
    const res = await post({ action: 'measure' });
    expect(res.status).toBe(200);
    const measured = await res.json();
    expect(measured.measuredMs).toBeGreaterThanOrEqual(0);
    expect(measured.snapshot.method).toBe('dbstat');
    const body = await (await GET()).json();
    expect(body.snapshot.tables.map((t: { name: string }) => t.name)).toContain('content_blocks');
    expect(body.history).toHaveLength(1);
  });

  it('POST refuses anything else', async () => {
    expect((await post({ action: 'vacuum' })).status).toBe(400);
  });
});
