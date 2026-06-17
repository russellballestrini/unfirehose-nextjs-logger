import { describe, it, expect, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { Readable } from 'stream';

// unfirehose/1.0: agnt-style JSONL goes through the harness adapter's passthrough.
const jsonlContent = [
  JSON.stringify({
    $schema: 'unfirehose/1.0',
    type: 'message',
    role: 'user',
    sessionId: 's1',
    content: [{ type: 'text', text: 'explain this' }],
  }),
  JSON.stringify({
    $schema: 'unfirehose/1.0',
    type: 'message',
    role: 'assistant',
    sessionId: 's1',
    timestamp: '2026-03-03T14:00:00Z',
    model: 'claude-opus-4-6',
    content: [{ type: 'reasoning', text: 'Let me analyze...' }],
  }),
].join('\n');

vi.mock('@unturf/unfirehose/session-paths', () => ({
  harnessFor: () => ({
    adapter: {
      name: 'mock',
      sessionFile: (slug: string, sessionId: string) => `/mock/${slug}/${sessionId}.jsonl`,
      normalize: (raw: any) => (raw?.type === 'message' ? raw : null),
    },
    slug: 'proj',
  }),
}));

vi.mock('fs', () => ({
  createReadStream: vi.fn().mockReturnValue(Readable.from([jsonlContent])),
}));

const { GET } = await import('./route');

function req(url: string) {
  return new NextRequest(new URL(url, 'http://localhost:3000'));
}

describe('GET /api/sessions/:sessionId/thinking', () => {
  it('returns 400 when project param is missing', async () => {
    const res = await GET(req('/api/sessions/s1/thinking'), { params: Promise.resolve({ sessionId: 's1' }) });
    expect(res.status).toBe(400);
  });

  it('returns reasoning excerpts from session file', async () => {
    const res = await GET(
      req('/api/sessions/s1/thinking?project=proj'),
      { params: Promise.resolve({ sessionId: 's1' }) },
    );
    const data = await res.json();
    expect(res.status).toBe(200);
    expect(data).toHaveLength(1);
    expect(data[0].thinking).toContain('Let me analyze');
    expect(data[0].precedingPrompt).toContain('explain this');
  });
});
