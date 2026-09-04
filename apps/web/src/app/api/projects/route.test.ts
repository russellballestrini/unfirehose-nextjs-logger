import { describe, it, expect, vi, beforeAll } from 'vitest';
import { createTestDb, seedProject, seedSession, seedMessage } from '@unturf/unfirehose/test/db-helper';

// Built before the mock so the factory can close over it. The route reads
// projects/sessions/messages through getDb(); unmocked it answered from the
// operator's live database, so this file asserted against whatever was on
// that machine.
const db = createTestDb();
vi.mock('@unturf/unfirehose/db/schema', () => ({ getDb: () => db }));

vi.mock('@unturf/unfirehose/claude-paths', () => ({
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

// The route reports a project by merging what is on disk with what the
// database knows, so the fs mock above is only half the fixture. The rollup
// counts sessions and messages from SQL; with nothing seeded, a project
// surfaced with no activity and `latestActivity` came back ''.
beforeAll(() => {
  const projectId = seedProject(db, 'test-project');
  const s1 = seedSession(db, projectId, 's1');
  const s2 = seedSession(db, projectId, 's2');
  db.prepare('UPDATE sessions SET last_message_at = ? WHERE id = ?')
    .run('2026-03-03T14:00:00Z', s1);
  db.prepare('UPDATE sessions SET last_message_at = ? WHERE id = ?')
    .run('2026-03-02T10:00:00Z', s2);
  // 15 messages total, matching the two sessions-index entries above.
  for (let i = 0; i < 10; i++) {
    seedMessage(db, s1, { timestamp: '2026-03-03T14:00:00Z' });
  }
  for (let i = 0; i < 5; i++) {
    seedMessage(db, s2, { timestamp: '2026-03-02T10:00:00Z' });
  }
});

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
