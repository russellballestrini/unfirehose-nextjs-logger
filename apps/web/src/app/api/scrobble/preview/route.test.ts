import { describe, it, expect, beforeEach, vi } from 'vitest';

/**
 * The scrobble preview: what a public profile would say.
 *
 * This route shipped 4.3MB — every one of 9,455 rows in `projects`, most of
 * them agent scratch directories, joined through sessions to messages and
 * grouped, then rendered one by one into the DOM. The Projects page had
 * folded that down to about a hundred real repositories months earlier;
 * this was the last caller still doing it the long way. It now reads the
 * same folded list the Projects page reads, so the two agree about what a
 * project is and the payload is a few kilobytes.
 */

let projectList: Array<Record<string, unknown>> | null = null;
vi.mock('@unturf/unfirehose/projects-list', () => ({
  readProjectList: () => (projectList ? { payload: projectList, at: '2026-09-05T00:00:00Z' } : null),
}));

/** Rows in `projects` joined to `project_visibility`, by name. */
let visRows: Array<{ id: number; name: string; path: string | null; visibility: string; auto_detected: string | null; vis_updated_at: string | null }> = [];
const upserts: unknown[][] = [];
const db = {
  prepare(sql: string) {
    return {
      all: (...names: string[]) => visRows.filter((r) => names.includes(r.name)),
      run: (...a: unknown[]) => { if (sql.includes('INSERT INTO project_visibility')) upserts.push(a); },
    };
  },
};
vi.mock('@unturf/unfirehose/db/schema', () => ({ getDb: () => db }));

// No git, no network: every remote check finds nothing.
vi.mock('child_process', () => ({ exec: (_c: string, _o: unknown, cb: (e: unknown, r: { stdout: string }) => void) => cb(null, { stdout: '' }) }));

const { GET } = await import('./route');
const get = async () => (await GET()).json();

const folded = (name: string, over: Record<string, unknown> = {}) => ({
  name, displayName: name.replace(/^-home-fox-git-/, ''), path: `/home/fox/git/${name.split('-').pop()}`,
  sessionCount: 3, totalMessages: 40, latestActivity: '2026-09-04T00:00:00Z', hasMemory: false,
  tokens: { input: 1000, output: 500, cacheRead: 0, cacheWrite: 0 }, ...over,
});

beforeEach(() => {
  projectList = null; visRows = []; upserts.length = 0;
  // The route caches for five minutes; each test wants a fresh build.
  vi.resetModules();
});

describe('what the preview lists', () => {
  it('lists the folded projects, not every row in the table', async () => {
    projectList = [folded('-home-fox-git-alpha'), folded('-home-fox-git-beta')];
    const { GET } = await import('./route');
    const body = await (await GET()).json();
    expect(body.projects.map((p: { name: string }) => p.name).sort())
      .toEqual(['-home-fox-git-alpha', '-home-fox-git-beta']);
  });

  it('carries the counts the profile page shows, from the folded list', async () => {
    projectList = [folded('-home-fox-git-alpha', { sessionCount: 7, totalMessages: 90, tokens: { input: 12, output: 34, cacheRead: 0, cacheWrite: 0 } })];
    const { GET } = await import('./route');
    const [p] = (await (await GET()).json()).projects;
    expect(p).toMatchObject({ displayName: 'alpha', sessionCount: 7, messageCount: 90, totalInput: 12, totalOutput: 34 });
  });

  it('reads visibility from the visibility table, defaulting to private', async () => {
    // Private by default is the whole safety property of a public profile:
    // a project nobody has looked at must not be published by omission.
    projectList = [folded('-home-fox-git-alpha'), folded('-home-fox-git-beta')];
    visRows = [{ id: 1, name: '-home-fox-git-alpha', path: '/home/fox/git/alpha', visibility: 'public', auto_detected: 'public_repo:x', vis_updated_at: '2026-09-05T00:00:00Z' }];
    const { GET } = await import('./route');
    const by = Object.fromEntries((await (await GET()).json()).projects.map((p: { name: string; visibility: string }) => [p.name, p.visibility]));
    expect(by).toEqual({ '-home-fox-git-alpha': 'public', '-home-fox-git-beta': 'private' });
  });

  it('answers with an empty list before the worker has ever built one', async () => {
    // The first minutes after install. An empty preview is honest; a fall
    // back to the 9,455-row scan is the thing this change removed.
    const { GET } = await import('./route');
    const body = await (await GET()).json();
    expect(body.projects).toEqual([]);
    expect(Array.isArray(body.included)).toBe(true);
  });

  it('does not ship fields the page never reads', async () => {
    projectList = [folded('-home-fox-git-alpha')];
    const { GET } = await import('./route');
    const [p] = (await (await GET()).json()).projects;
    expect(p).not.toHaveProperty('firstActivity');
    expect(p).not.toHaveProperty('path');
  });
});

describe('remote detection', () => {
  it('only re-checks projects it could resolve to a row', async () => {
    // A folded project with no matching row has no id to upsert against.
    // Writing a visibility row for `null` would either throw or create a
    // row nothing can find again.
    projectList = [folded('-home-fox-git-alpha')];
    visRows = [];
    const { GET } = await import('./route');
    await GET();
    expect(upserts).toEqual([]);
  });

  it('records a project with no remotes as checked, so it is not scanned every time', async () => {
    projectList = [folded('-home-fox-git-alpha')];
    visRows = [{ id: 1, name: '-home-fox-git-alpha', path: '/home/fox/git/alpha', visibility: 'private', auto_detected: null, vis_updated_at: null }];
    const { GET } = await import('./route');
    await GET();
    expect(upserts).toHaveLength(1);
    expect(upserts[0]).toEqual([1, 'private', 'no_remotes']);
  });
});
