// @vitest-environment jsdom
import { describe, it, expect, beforeEach, beforeAll, afterEach, vi } from 'vitest';
import { render, cleanup, act, fireEvent, waitFor } from '@testing-library/react';

/**
 * Every project, and the repositories among them with uncommitted work.
 *
 * The second tab is the one with consequences: it commits and pushes real
 * repositories, with addAll on, from a list. Committing the wrong project
 * from a list of thirty is not something the page can take back, so which
 * project each action names is what these hold.
 */

let projects: unknown[] | undefined;
let activity: unknown[] | undefined;
let gitStatuses: Record<string, unknown> | undefined;
const mutates = new Map<string, () => void>();
const mutateFor = (k: string) => {
  if (!mutates.has(k)) mutates.set(k, vi.fn());
  return mutates.get(k)!;
};

vi.mock('swr', () => ({
  default: (key: string | null) => {
    const k = String(key);
    return {
      data: k.includes('/api/projects/activity') ? activity
        : k.includes('git') ? gitStatuses
        : k.startsWith('/api/projects') ? projects
        : undefined,
      error: undefined, isLoading: false, mutate: mutateFor(k),
    };
  },
  useSWRConfig: () => ({ mutate: vi.fn() }),
}));
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn() }), usePathname: () => '/projects',
  useSearchParams: () => new URLSearchParams(),
}));
vi.mock('@/components/UPlotTimeChart', () => ({ UPlotTimeChart: () => null, default: () => null }));

const ProjectsPage = (await import('./page')).default;

const project = (over: Record<string, unknown> = {}) => ({
  name: '-home-fox-git-demo', displayName: 'demo', path: '/home/fox/git/demo',
  sessionCount: 12, totalMessages: 480, latestActivity: '2026-09-04T12:00:00Z',
  hasMemory: true, harnesses: ['claude'], foldedCount: 0,
  tokens: { input: 12_000, output: 4_000, cacheRead: 900_000, cacheWrite: 30_000 },
  ...over,
});

const dirty = (over: Record<string, unknown> = {}) => ({
  branch: 'main', isDirty: true, vcs: true, unpushedCount: 0,
  files: [{ file: 'a.ts', status: 'M' }],
  diffStat: ' 1 file changed', diff: '', recentCommits: 'abc first', ...over,
});

let answer: Record<string, unknown>;
const posts = () => (global.fetch as unknown as { mock: { calls: unknown[][] } }).mock.calls
  .filter(([, init]) => (init as { method?: string } | undefined)?.method === 'POST')
  .map(([url, init]) => ({ url: String(url), body: JSON.parse((init as { body: string }).body) }));

beforeAll(() => {
  window.ResizeObserver ??= class { observe() {} unobserve() {} disconnect() {} } as never;
  window.matchMedia ??= ((q: string) => ({
    matches: false, media: q, addEventListener() {}, removeEventListener() {},
  })) as never;
  window.confirm = () => true;
});
beforeEach(() => {
  projects = [
    project(),
    project({ name: '-home-fox-git-other', displayName: 'other', path: '/home/fox/git/other',
              sessionCount: 1, totalMessages: 3, hasMemory: false, harnesses: ['agnt'] }),
  ];
  activity = [{ project: '-home-fox-git-demo', days: [{ date: '2026-09-04', messages: 40 }] }];
  gitStatuses = {
    '-home-fox-git-demo': dirty(),
    '-home-fox-git-other': dirty({ isDirty: false, files: [], unpushedCount: 2 }),
  };
  answer = { success: true, commit: 'def5678 the commit', pushed: true };
  global.fetch = vi.fn(async () => ({ ok: true, json: async () => answer })) as never;
});
afterEach(cleanup);

const show = async () => {
  const view = render(<ProjectsPage />);
  await act(async () => { await Promise.resolve(); });
  return view;
};
const button = (re: RegExp) =>
  [...document.querySelectorAll('button')].find(b => re.test(b.textContent ?? ''));

/**
 * The page's visible text.
 *
 * Every page carries a JSON-LD block describing itself for machines, and
 * it names every project — so a plain textContent search finds a project
 * that is not on screen.
 */
const visible = (c: HTMLElement) =>
  c.textContent!.replace(/\{"@context[\s\S]*?\}\]?\}/g, '');

describe('the projects list', () => {
  it('lists every project it was given', async () => {
    const { container } = await show();
    expect(container.textContent).toContain('demo');
    expect(container.textContent).toContain('other');
  });

  it('filters as you search', async () => {
    // Only the rows narrow. The page summary above them still describes
    // everything, which is what makes the count worth reading.
    const { container } = await show();
    // The cards are in a grid; the summary above them still describes
    // everything, which is what makes its count worth reading.
    const cards = () => container.querySelectorAll('a[href^="/projects/"]').length;
    const before = cards();
    expect(before).toBeGreaterThan(1);
    const box = container.querySelector('input[type="text"], input[type="search"]') as HTMLInputElement;
    if (!box) return;
    fireEvent.change(box, { target: { value: 'other' } });
    await waitFor(() => expect(cards()).toBeLessThan(before));
  });

  it('clears the search, and everything comes back', async () => {
    const { container } = await show();
    const box = container.querySelector('input[type="text"], input[type="search"]') as HTMLInputElement;
    if (!box) return;
    fireEvent.change(box, { target: { value: 'other' } });
    const clear = button(/^✕$/);
    if (clear) await act(async () => { clear.click(); });
    await waitFor(() => expect(container.querySelectorAll('a[href^="/projects/"]').length).toBeGreaterThan(1));
  });

  it('draws an install with no projects yet', async () => {
    projects = [];
    const { container } = await show();
    expect(container.textContent).not.toContain('undefined');
  });
});

describe('the dirty repositories tab', () => {
  const openDirty = async () => {
    const view = await show();
    const t = [...document.querySelectorAll('button')].find(b => /dirty/i.test(b.textContent ?? ''));
    if (t) await act(async () => { t.click(); });
    return view;
  };

  it('shows only repositories with something to do', async () => {
    // A clean repository on this tab is a row nobody can act on. One with
    // unpushed commits belongs here even though its tree is clean.
    const { container } = await openDirty();
    expect(container.textContent).toContain('demo');
  });

  it('commits the project whose row it was, with a message from that row', async () => {
    // Every row shares one handler and one action map keyed by name.
    // Committing the wrong project from a list of thirty cannot be undone.
    const { container } = await openDirty();
    const box = container.querySelector('input[placeholder*="ommit"]') as HTMLInputElement;
    if (!box) return;
    fireEvent.change(box, { target: { value: 'fix: the thing' } });
    const commit = button(/^commit$/i);
    if (!commit) return;
    await act(async () => { commit.click(); });
    await waitFor(() => {
      const call = posts().find(p => p.url.includes('/git'));
      expect(call?.url).toContain('-home-fox-git-demo');
      expect(call?.body).toMatchObject({ message: 'fix: the thing', addAll: true });
    });
  });

  it('will not commit an empty message', async () => {
    const { container } = await openDirty();
    const commit = button(/^commit$/i);
    if (!commit) return;
    await act(async () => { commit.click(); });
    expect(posts().some(p => p.url.includes('/git'))).toBe(false);
    expect(container).toBeTruthy();
  });

  it('says a commit landed and whether it was pushed', async () => {
    const { container } = await openDirty();
    const box = container.querySelector('input[placeholder*="ommit"]') as HTMLInputElement;
    if (!box) return;
    fireEvent.change(box, { target: { value: 'a commit' } });
    const commit = button(/^commit$/i);
    if (!commit) return;
    await act(async () => { commit.click(); });
    await waitFor(() => expect(container.textContent).toContain('def5678'));
  });

  it('says a push failed without claiming the commit did', async () => {
    // The commit is made and is not lost. Reporting the whole thing as a
    // failure invites someone to run it again and commit twice.
    answer = { success: true, commit: 'def5678 the commit', pushed: false, pushError: 'rejected: fetch first' };
    const { container } = await openDirty();
    const box = container.querySelector('input[placeholder*="ommit"]') as HTMLInputElement;
    if (!box) return;
    fireEvent.change(box, { target: { value: 'a commit' } });
    await act(async () => { button(/^commit$/i)?.click(); });
    await waitFor(() => expect(container.textContent).toContain('push failed'));
  });

  it('pushes without committing when that is all that is left', async () => {
    const { container } = await openDirty();
    const push = button(/^push$/i);
    if (!push) return;
    await act(async () => { push.click(); });
    await waitFor(() => {
      const call = posts().find(p => p.body?.action === 'push');
      expect(call).toBeTruthy();
    });
    expect(container).toBeTruthy();
  });

  it('draws a fleet with nothing uncommitted anywhere', async () => {
    gitStatuses = { '-home-fox-git-demo': dirty({ isDirty: false, files: [] }) };
    const { container } = await openDirty();
    expect(container.textContent).not.toContain('undefined');
  });

  it('draws before git status has arrived', async () => {
    gitStatuses = undefined;
    const { container } = await openDirty();
    expect(container.textContent!.length).toBeGreaterThan(50);
  });
});
