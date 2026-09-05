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

/**
 * What /api/projects/git-status returns: counts, not a file list. The
 * page filters its Dynamic Commits tab on these two numbers.
 */
const status = (over: Record<string, unknown> = {}) => ({
  dirty: 2, unpushed: 0, branch: 'main', ...over,
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
    '-home-fox-git-demo': status(),
    '-home-fox-git-other': status({ dirty: 0, unpushed: 2 }),
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
    if (!box) throw new Error('missing control: box');
    fireEvent.change(box, { target: { value: 'other' } });
    await waitFor(() => expect(cards()).toBeLessThan(before));
  });

  it('clears the search, and everything comes back', async () => {
    const { container } = await show();
    const box = container.querySelector('input[type="text"], input[type="search"]') as HTMLInputElement;
    if (!box) throw new Error('missing control: box');
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
  /**
   * This tab's own controls are batch operations: generate a message for
   * every dirty repo, commit every one that has a message, push every one
   * that is ahead. A single misfire here touches the whole fleet at once,
   * which is why what each one skips matters as much as what it does.
   *
   * Nothing here is optional — a missing control throws, because five of
   * these tests used to look for per-row buttons that were never on this
   * tab and pass by returning early.
   */
  const openDirty = async () => {
    const view = await show();
    const t = [...document.querySelectorAll('button')].find(b => b.textContent?.includes('Dynamic Commits'));
    if (!t) throw new Error('no Dynamic Commits tab');
    await act(async () => { t.click(); });
    return view;
  };
  const button = (label: string) => {
    const el = [...document.querySelectorAll('button')]
      .find(b => b.textContent?.trim().startsWith(label));
    if (!el) throw new Error(`no ${label} button`);
    return el;
  };

  it('counts what each batch would touch, before anyone presses it', async () => {
    // 'Commit All (3)' is the only warning you get that it is three.
    const { container } = await openDirty();
    expect(container.textContent).toMatch(/Commit All \(\d+\)/);
    expect(container.textContent).toMatch(/Push All \(\d+\)/);
  });

  it('will not commit when nothing has a message yet', async () => {
    // Every batch commit needs a message per repo, and none has been
    // written. The button being live would commit nothing, slowly.
    await openDirty();
    expect((button('Commit All') as HTMLButtonElement).disabled).toBe(true);
  });

  it('pushes only the repositories that are actually ahead', async () => {
    // demo is dirty but level; other is clean with two unpushed commits.
    // A push-all that included demo would be a no-op per repo and a
    // string of confusing failures.
    const { container } = await openDirty();
    expect(container.textContent).toContain('Push All (1)');
  });

  it('offers to write every message with a model in one go', async () => {
    const { container } = await openDirty();
    expect(button('Generate All Messages')).toBeTruthy();
    expect(container).toBeTruthy();
  });

  it('says there is nothing to do rather than showing empty batch buttons', async () => {
    // Four disabled batch actions over an empty list is a page that looks
    // broken; this is the state most of the fleet is in most of the time.
    gitStatuses = { '-home-fox-git-demo': status({ dirty: 0, unpushed: 0 }) };
    const { container } = await openDirty();
    expect(container.textContent).toContain('No dirty or unpushed repos');
  });

  it('expands and collapses every repository at once', async () => {
    // Thirty repos of diff is a page nobody can read, so the default is
    // collapsed and this is the way back.
    const { container } = await openDirty();
    const toggle = [...container.querySelectorAll('button')]
      .find(b => /Expand All|Collapse All/.test(b.textContent ?? ''));
    if (!toggle) throw new Error('no expand toggle');
    const before = toggle.textContent;
    await act(async () => { toggle.click(); });
    expect(toggle.textContent).not.toBe(before);
  });

  it('draws a fleet with nothing uncommitted anywhere', async () => {
    gitStatuses = { '-home-fox-git-demo': status({ dirty: 0, unpushed: 0 }) };
    const { container } = await openDirty();
    expect(container.textContent).not.toContain('undefined');
  });

  it('draws before git status has arrived', async () => {
    gitStatuses = undefined;
    const { container } = await openDirty();
    expect(container.textContent!.length).toBeGreaterThan(50);
  });
});
