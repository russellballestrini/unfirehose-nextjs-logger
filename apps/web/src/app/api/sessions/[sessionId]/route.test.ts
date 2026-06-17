import { describe, it, expect, vi } from 'vitest';
import { NextRequest } from 'next/server';

vi.mock('@unturf/unfirehose/session-paths', () => ({
  harnessFor: () => ({
    adapter: {
      name: 'mock',
      sessionFile: (slug: string, sessionId: string) => `/mock/${slug}/${sessionId}.jsonl`,
      normalize: (raw: any) => raw,
    },
    slug: 'proj',
  }),
}));

vi.mock('fs/promises', () => ({
  stat: vi.fn().mockResolvedValue({ size: 1024 }),
}));

vi.mock('@unturf/unfirehose/jsonl-reader', () => ({
  streamJsonl: async function* () {
    yield { type: 'message', role: 'user', content: [{ type: 'text', text: 'hello' }] };
    yield { type: 'message', role: 'assistant', content: [{ type: 'text', text: 'hi' }] };
  },
}));

const { GET } = await import('./route');

function req(url: string) {
  return new NextRequest(new URL(url, 'http://localhost:3000'));
}

describe('GET /api/sessions/:sessionId', () => {
  it('returns 400 when project param is missing', async () => {
    const res = await GET(req('/api/sessions/abc'), { params: Promise.resolve({ sessionId: 'abc' }) });
    expect(res.status).toBe(400);
  });

  it('returns canonical unfirehose/1.0 entries with count, offset, limit', async () => {
    const res = await GET(
      req('/api/sessions/abc?project=proj'),
      { params: Promise.resolve({ sessionId: 'abc' }) },
    );
    const data = await res.json();
    expect(res.status).toBe(200);
    expect(data.entries).toHaveLength(2);
    expect(data.entries[0].role).toBe('user');
    expect(data.entries[1].role).toBe('assistant');
    expect(data.count).toBe(2);
    expect(data.offset).toBe(0);
  });

  it('filters by role via the types= query param', async () => {
    const res = await GET(
      req('/api/sessions/abc?project=proj&types=assistant'),
      { params: Promise.resolve({ sessionId: 'abc' }) },
    );
    const data = await res.json();
    expect(data.entries).toHaveLength(1);
    expect(data.entries[0].role).toBe('assistant');
  });

  it('returns NDJSON stream when stream=true', async () => {
    const res = await GET(
      req('/api/sessions/abc?project=proj&stream=true'),
      { params: Promise.resolve({ sessionId: 'abc' }) },
    );
    expect(res.headers.get('Content-Type')).toBe('application/x-ndjson');
  });
});
