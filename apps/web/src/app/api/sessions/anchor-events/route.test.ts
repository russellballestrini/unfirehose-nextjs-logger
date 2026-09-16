import { describe, it, expect, vi } from 'vitest';
import { NextRequest } from 'next/server';

const events = vi.fn();
vi.mock('@unturf/unfirehose/db/schema', () => ({ getDb: () => ({}) }));
vi.mock('@unturf/unfirehose/db/provenance-ingest', () => ({ getRecentAnchorEvents: (...a: unknown[]) => events(...a) }));

const { GET } = await import('./route');

describe('GET /api/sessions/anchor-events', () => {
  it('passes a clamped window, limit and kind through and returns the feed', async () => {
    events.mockReturnValue([{ id: 1, session_uuid: 's', seq: 3, kind: 'rewritten' }]);
    const res = await GET(new NextRequest('http://x/api/sessions/anchor-events?hours=48&limit=5000&kind=rewritten'));
    const body = await res.json();
    expect(events).toHaveBeenCalledWith({}, { hours: 48, limit: 1000, kind: 'rewritten' });
    expect(body).toEqual({ hours: 48, events: [{ id: 1, session_uuid: 's', seq: 3, kind: 'rewritten' }] });
    // Defaults: 24 h, 100 rows, every kind.
    events.mockReturnValue([]);
    await GET(new NextRequest('http://x/api/sessions/anchor-events?hours=junk'));
    expect(events).toHaveBeenLastCalledWith({}, { hours: 24, limit: 100, kind: undefined });
  });
});
