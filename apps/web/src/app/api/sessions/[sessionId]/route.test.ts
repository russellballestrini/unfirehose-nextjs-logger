import { describe, it, expect, vi } from 'vitest';
import { NextRequest } from 'next/server';

vi.mock('@sexy-logger/core/claude-paths', () => ({
  claudePaths: {
    sessionFile: (project: string, sessionId: string) => `/mock/${project}/${sessionId}.jsonl`,
  },
}));

vi.mock('fs/promises', () => ({
  stat: vi.fn().mockResolvedValue({ size: 1024 }),
}));

vi.mock('@sexy-logger/core/jsonl-reader', () => ({
  collectJsonl: vi.fn().mockResolvedValue([
    { type: 'user', message: { content: 'hello' } },
    { type: 'assistant', message: { content: [{ type: 'text', text: 'hi' }] } },
  ]),
  createJsonlReadableStream: vi.fn().mockReturnValue(new ReadableStream({
    start(controller) { controller.close(); },
  })),
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

  it('returns JSON entries with count, offset, limit', async () => {
    const res = await GET(
      req('/api/sessions/abc?project=proj'),
      { params: Promise.resolve({ sessionId: 'abc' }) },
    );
    const data = await res.json();
    expect(res.status).toBe(200);
    expect(data.entries).toHaveLength(2);
    expect(data.count).toBe(2);
    expect(data.offset).toBe(0);
  });

  it('returns NDJSON stream when stream=true', async () => {
    const res = await GET(
      req('/api/sessions/abc?project=proj&stream=true'),
      { params: Promise.resolve({ sessionId: 'abc' }) },
    );
    expect(res.headers.get('Content-Type')).toBe('application/x-ndjson');
  });
});
