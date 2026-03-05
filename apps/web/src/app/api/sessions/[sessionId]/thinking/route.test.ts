import { describe, it, expect, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { Readable } from 'stream';

vi.mock('@unfirehose/core/claude-paths', () => ({
  claudePaths: {
    sessionFile: (p: string, s: string) => `/mock/${p}/${s}.jsonl`,
  },
}));

const jsonlContent = [
  JSON.stringify({ type: 'user', sessionId: 's1', message: { role: 'user', content: 'explain this' } }),
  JSON.stringify({
    type: 'assistant', sessionId: 's1', timestamp: '2026-03-03T14:00:00Z',
    message: { role: 'assistant', model: 'claude-opus-4-6', content: [{ type: 'thinking', thinking: 'Let me analyze...' }] },
  }),
].join('\n');

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

  it('returns thinking excerpts from session file', async () => {
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
