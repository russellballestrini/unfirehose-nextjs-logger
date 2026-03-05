import { describe, it, expect, vi } from 'vitest';

vi.mock('@unfirehose/core/claude-paths', () => ({
  claudePaths: {
    projects: '/mock/.claude/projects',
    projectDir: (p: string) => `/mock/.claude/projects/${p}`,
    sessionsIndex: (p: string) => `/mock/.claude/projects/${p}/sessions-index.json`,
    memory: (p: string) => `/mock/.claude/projects/${p}/memory/MEMORY.md`,
  },
  decodeProjectName: (name: string) => name.replace(/-/g, '.'),
}));

vi.mock('fs/promises', () => ({
  readdir: vi.fn().mockResolvedValue(['test-project']),
  readFile: vi.fn().mockResolvedValue(JSON.stringify({
    entries: [
      { sessionId: 's1', messageCount: 10, modified: '2026-03-03T14:00:00Z', created: '2026-03-01T00:00:00Z' },
      { sessionId: 's2', messageCount: 5, modified: '2026-03-02T10:00:00Z', created: '2026-03-01T12:00:00Z' },
    ],
    originalPath: '/home/fox/git/test-project',
  })),
  stat: vi.fn().mockImplementation((path: string) => {
    if (path.includes('MEMORY.md')) return Promise.reject(new Error('not found'));
    return Promise.resolve({ isDirectory: () => true });
  }),
}));

const { GET } = await import('./route');

describe('GET /api/projects', () => {
  it('returns project list with session counts', async () => {
    const res = await GET();
    const data = await res.json();
    expect(res.status).toBe(200);
    expect(data).toHaveLength(1);
    expect(data[0].sessionCount).toBe(2);
    expect(data[0].totalMessages).toBe(15);
    expect(data[0].latestActivity).toBe('2026-03-03T14:00:00Z');
  });

  it('detects hasMemory as false when MEMORY.md missing', async () => {
    const res = await GET();
    const data = await res.json();
    expect(data[0].hasMemory).toBe(false);
  });
});
