import { describe, it, expect, vi } from 'vitest';
import { NextRequest } from 'next/server';

vi.mock('@sexy-logger/core/claude-paths', () => ({
  claudePaths: {
    sessionsIndex: (p: string) => `/mock/${p}/sessions-index.json`,
    projectDir: (p: string) => `/mock/${p}`,
  },
}));

vi.mock('fs/promises', () => ({
  readFile: vi.fn().mockResolvedValue(JSON.stringify({
    originalPath: '/home/fox/git/test',
    entries: [
      { sessionId: 's1', modified: '2026-03-03T14:00:00Z', messageCount: 10 },
      { sessionId: 's2', modified: '2026-03-02T10:00:00Z', messageCount: 5 },
    ],
  })),
  readdir: vi.fn().mockResolvedValue([]),
}));

const { GET } = await import('./route');

function req(url: string) {
  return new NextRequest(new URL(url, 'http://localhost:3000'));
}

describe('GET /api/projects/:project/sessions', () => {
  it('returns sessions from sessions-index.json', async () => {
    const res = await GET(req('/api/projects/test/sessions'), { params: Promise.resolve({ project: 'test' }) });
    const data = await res.json();
    expect(res.status).toBe(200);
    expect(data.sessions).toHaveLength(2);
  });

  it('sorts by modified descending by default', async () => {
    const res = await GET(req('/api/projects/test/sessions'), { params: Promise.resolve({ project: 'test' }) });
    const data = await res.json();
    expect(data.sessions[0].sessionId).toBe('s1');
  });

  it('respects sort and order query params', async () => {
    const res = await GET(req('/api/projects/test/sessions?sort=modified&order=asc'), { params: Promise.resolve({ project: 'test' }) });
    const data = await res.json();
    expect(data.sessions[0].sessionId).toBe('s2');
  });
});
