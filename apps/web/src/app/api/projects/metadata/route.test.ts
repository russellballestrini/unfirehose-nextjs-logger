import { describe, it, expect, vi } from 'vitest';
import { NextRequest } from 'next/server';

vi.mock('@sexy-logger/core/claude-paths', () => ({
  claudePaths: {
    sessionsIndex: (p: string) => `/mock/${p}/sessions-index.json`,
  },
}));

vi.mock('fs/promises', () => ({
  readFile: vi.fn().mockImplementation((path: string) => {
    if (path.includes('sessions-index.json')) {
      return Promise.resolve(JSON.stringify({ originalPath: '/home/fox/git/test', entries: [] }));
    }
    if (path.includes('CLAUDE.md')) {
      return Promise.resolve('# Test Project\n\nThis is a test.');
    }
    return Promise.reject(new Error('not found'));
  }),
}));

vi.mock('child_process', () => ({
  execFile: vi.fn().mockImplementation((_cmd: string, args: string[], _opts: unknown, cb: Function) => {
    if (args.includes('rev-parse')) cb(null, 'main');
    else if (args.includes('remote')) cb(null, 'origin\tgit@github.com:test/repo.git (fetch)');
    else if (args.includes('log')) cb(null, 'abc1234|||Initial commit|||fox|||2026-03-03T14:00:00Z');
    else cb(null, '');
  }),
}));

const { GET } = await import('./route');

function req(url: string) {
  return new NextRequest(new URL(url, 'http://localhost:3000'));
}

describe('GET /api/projects/metadata', () => {
  it('returns 400 when project param is missing', async () => {
    const res = await GET(req('/api/projects/metadata'));
    expect(res.status).toBe(400);
  });

  it('returns git branch, remotes, and recent commits', async () => {
    const res = await GET(req('/api/projects/metadata?project=test'));
    const data = await res.json();
    expect(res.status).toBe(200);
    expect(data.branch).toBe('main');
    expect(data.remotes).toHaveLength(1);
    expect(data.recentCommits).toHaveLength(1);
    expect(data.recentCommits[0].hash).toBe('abc1234');
  });

  it('returns CLAUDE.md content', async () => {
    const res = await GET(req('/api/projects/metadata?project=test'));
    const data = await res.json();
    expect(data.claudeMdExists).toBe(true);
    expect(data.claudeMd).toContain('Test Project');
  });
});
