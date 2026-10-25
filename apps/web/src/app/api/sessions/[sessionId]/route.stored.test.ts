import { describe, it, expect, vi } from 'vitest';
import { NextRequest } from 'next/server';

// A harness in a format of its own (Codex, Gemini CLI, Continue): no session
// file to stream, so the viewer reads the rows ingest stored.
vi.mock('@unturf/unfirehose/session-paths', () => ({
  harnessFor: () => ({
    adapter: {
      name: 'gemini-cli',
      stored: true,
      sessionFile: () => { throw new Error('no session file'); },
      normalize: () => null,
    },
    slug: 'proj',
  }),
}));

const known = new Set(['abc']);
vi.mock('@unturf/unfirehose/db/schema', () => ({
  getDb: () => ({ prepare: () => ({ get: (id: string) => (known.has(id) ? { 1: 1 } : undefined) }) }),
}));
vi.mock('@unturf/unfirehose/db/session-messages', () => ({
  storedSessionMessages: () => [
    { type: 'message', role: 'user', content: [{ type: 'text', text: 'hello' }] },
    { type: 'message', role: 'assistant', content: [{ type: 'text', text: 'hi' }] },
  ],
}));
const stat = vi.fn();
vi.mock('fs/promises', () => ({ stat }));

const { GET } = await import('./route');
const req = (url: string) => new NextRequest(new URL(url, 'http://localhost:3000'));

describe('GET /api/sessions/:sessionId for a stored harness', () => {
  it('reads the session from our database, never the disk', async () => {
    const res = await GET(req('/api/sessions/abc?project=gemini-cli:proj&types=assistant'), { params: Promise.resolve({ sessionId: 'abc' }) });
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.entries).toEqual([{ type: 'message', role: 'assistant', content: [{ type: 'text', text: 'hi' }] }]);
    expect(stat).not.toHaveBeenCalled();
  });

  it('is a 404 for a session ingest has not stored', async () => {
    const res = await GET(req('/api/sessions/zzz?project=gemini-cli:proj'), { params: Promise.resolve({ sessionId: 'zzz' }) });
    expect(res.status).toBe(404);
  });
});
