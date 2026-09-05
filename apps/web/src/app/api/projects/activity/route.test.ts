import { describe, it, expect, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { createTestDb } from '@unturf/unfirehose/test/db-helper';

// ensurePricingHydrated reaches for a database without saying so, so mocking
// db/ingest alone still left this route reading the live one.
const db = createTestDb();
vi.mock('@unturf/unfirehose/db/schema', () => ({ getDb: () => db }));

// The folded project list, as the worker would have left it. Null means
// the worker has never run, and the route falls back to the path filter.
let projectList: { name: string; displayName: string; path: string }[] | null = null;
vi.mock('@unturf/unfirehose/projects-list', () => ({
  readProjectList: () => (projectList ? { payload: projectList, at: '2026-09-05T00:00:00Z' } : null),
}));

vi.mock('@unturf/unfirehose/db/ingest', () => ({
  getProjectActivity: vi.fn().mockReturnValue([
    { name: 'proj-1', display_name: 'Project 1', user_messages: 20, assistant_messages: 18, total_input: 1000000, total_output: 500000, total_cache_read: 100000, total_cache_write: 50000 },
  ]),
  // The route imports this too. It was missing here, so the route
  // destructured `undefined` and threw — the same stale-mock drift that hid
  // in the alerts test. cost_estimate is derived from these rows, so an
  // empty list would assert nothing.
  getProjectModelActivity: vi.fn().mockReturnValue([
    {
      name: 'proj-1', model: 'claude-opus-4-6', provider: null, endpoint: null,
      input: 1000000, output: 500000, cache_read: 100000, cache_write: 50000,
    },
  ]),
  getProjectRecentPrompts: vi.fn().mockReturnValue([
    { prompt: 'What is the status?', timestamp: '2026-03-03T14:00:00Z', session_uuid: 's1' },
  ]),
}));

const { GET } = await import('./route');

function req(url: string) {
  return new NextRequest(new URL(url, 'http://localhost:3000'));
}

describe('GET /api/projects/activity', () => {
  it('returns enriched activity with cost_estimate', async () => {
    const res = await GET(req('/api/projects/activity?days=30'));
    const data = await res.json();
    expect(res.status).toBe(200);
    expect(data).toHaveLength(1);
    expect(data[0].cost_estimate).toBeGreaterThan(0);
  });

  it('returns single project with recent prompts when project param provided', async () => {
    const res = await GET(req('/api/projects/activity?project=proj-1'));
    const data = await res.json();
    expect(data.recentPrompts).toHaveLength(1);
    expect(data.recentPrompts[0].prompt).toContain('status');
  });

  it('folds a scratch workspace onto the repo its name identifies', async () => {
    // Thirty days of activity came back as 6,961 rows, at 2.4MB, when the
    // folded project list holds about a hundred. A workspace's work must
    // count toward its repo rather than stand beside it or vanish.
    projectList = [{ name: '-home-fox-git-repo', displayName: 'repo', path: '/home/fox/git/repo' }];
    const { getProjectActivity } = await import('@unturf/unfirehose/db/ingest');
    (getProjectActivity as ReturnType<typeof vi.fn>).mockReturnValueOnce([
      { name: '-home-fox-git-repo', display_name: 'repo', path: '/home/fox/git/repo', user_messages: 2, assistant_messages: 2, session_count: 1, active_days: 1, last_activity: '2026-09-01T00:00:00Z', total_input: 10, total_output: 10, total_cache_read: 0, total_cache_write: 0 },
      { name: 'tmp-claude-1000--home-fox-git-repo-abc-scratchpad', display_name: 'scratch', path: null, user_messages: 5, assistant_messages: 5, session_count: 2, active_days: 1, last_activity: '2026-09-04T00:00:00Z', total_input: 100, total_output: 100, total_cache_read: 0, total_cache_write: 0 },
      { name: 'sandbox-zzz', display_name: 'nobody', path: null, user_messages: 1, assistant_messages: 1, session_count: 1, active_days: 1, last_activity: '2026-09-02T00:00:00Z', total_input: 1, total_output: 1, total_cache_read: 0, total_cache_write: 0 },
    ]);
    const res = await GET(new NextRequest('http://localhost:3000/api/projects/activity?days=99'));
    const body = await res.json();
    const names = body.map((r: { name: string }) => r.name);
    expect(names).toEqual(['-home-fox-git-repo']);
    const repo = body[0];
    expect(repo.user_messages).toBe(7);
    expect(repo.session_count).toBe(3);
    expect(repo.last_activity).toBe('2026-09-04T00:00:00Z');
    expect(repo.display_name).toBe('repo');
    projectList = null;
  });
});
