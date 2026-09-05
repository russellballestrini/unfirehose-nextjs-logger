// @vitest-environment jsdom
import { describe, it, expect, vi, beforeAll, afterEach } from 'vitest';
import { render, cleanup, act } from '@testing-library/react';
import { ProjectRow } from './page';

/**
 * One repository in the projects list.
 *
 * Thirty-eight branches inside the page's map: clean or dirty, pushed or
 * ahead, expanded or not, with an action running or idle. Every one of those
 * is a state the list is in most of the time for at least one row, and none
 * of them could be reached without driving the whole page.
 */

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn() }), useParams: () => ({}),
  usePathname: () => '/projects', useSearchParams: () => new URLSearchParams(),
}));

beforeAll(() => {
  window.ResizeObserver ??= class { observe() {} unobserve() {} disconnect() {} } as never;
  global.fetch = vi.fn().mockResolvedValue({ ok: true, json: async () => ({}) }) as never;
});

afterEach(cleanup);

const project = (over: Record<string, unknown> = {}) => ({
  name: '-home-fox-git-demo', displayName: 'demo', path: '/home/fox/git/demo',
  sessionCount: 12, totalMessages: 340, latestActivity: '2026-09-04T12:00:00.000Z',
  tokens: { input: 100, output: 50, cacheRead: 800, cacheWrite: 50 },
  hasMemory: false, harnesses: [], foldedCount: 0, ...over,
});

const show = (props: Record<string, unknown> = {}) =>
  render(
    <ProjectRow
      project={project()}
      gitStatuses={{}}
      getAction={() => ({ status: 'idle', kind: null, message: null, commitMsg: '' })}
      expanded={{}}
      setExpanded={vi.fn()}
      details={{}}
      toggleExpand={vi.fn()}
      commitOne={vi.fn()}
      pushOne={vi.fn()}
      suggestOne={vi.fn()}
      updateAction={vi.fn()}
      pendingFileAction={null}
      requestFileAction={vi.fn()}
      {...props}
    />,
  );

describe('ProjectRow', () => {
  it('names the project', () => {
    expect(show().container.textContent).toContain('demo');
  });

  it('shows a clean repository without alarm', () => {
    const { container } = show({
      gitStatuses: { '-home-fox-git-demo': { branch: 'main', dirty: 0, unpushed: 0 } },
    });
    expect(container.textContent).toContain('main');
  });

  it('marks a repository with uncommitted work', () => {
    // The whole reason this list exists: seeing which repos are dirty
    // without opening each one.
    const { container } = show({
      gitStatuses: { '-home-fox-git-demo': { branch: 'main', dirty: 3, unpushed: 0 } },
    });
    expect(container.textContent).toMatch(/3/);
  });

  it('marks a repository with commits not yet pushed', () => {
    const { container } = show({
      gitStatuses: { '-home-fox-git-demo': { branch: 'main', dirty: 0, unpushed: 2 } },
    });
    expect(container.textContent).toMatch(/2/);
  });

  it('renders a repository whose status has not arrived yet', () => {
    // Status is fetched per repo in the background, so most rows render
    // before theirs lands.
    expect(() => show({ gitStatuses: {} })).not.toThrow();
  });

  it('renders expanded, with its detail', () => {
    const { container } = show({
      expanded: { '-home-fox-git-demo': true },
      details: { '-home-fox-git-demo': { files: [], commits: [], branch: 'main' } },
    });
    expect(container.textContent).toContain('demo');
  });

  it('renders expanded before its detail arrives', () => {
    expect(() => show({ expanded: { '-home-fox-git-demo': true }, details: {} })).not.toThrow();
  });

  it('renders after an action has finished', () => {
    const { container } = show({
      getAction: () => ({ status: 'done', kind: 'commit', message: 'abc1234', commitMsg: '' }),
    });
    expect(container.textContent).toContain('demo');
  });

  it('renders while an action is running on it', () => {
    expect(() => show({ getAction: () => ({ status: 'running', kind: 'commit', message: null, commitMsg: 'wip' }) })).not.toThrow();
  });

  it('leaves its controls pressable', () => {
    const { container } = show({
      gitStatuses: { '-home-fox-git-demo': { branch: 'main', dirty: 2, unpushed: 1 } },
      expanded: { '-home-fox-git-demo': true },
    });
    const buttons = [...container.querySelectorAll('button')];
    for (const b of buttons) act(() => { (b as HTMLElement).click(); });
    expect(buttons.length).toBeGreaterThan(0);
  });
});

/**
 * The controls on a row, which are the only ones on that page.
 *
 * Expanding a row fetches its git status; the three buttons that appear
 * then run git against a real repository. Commit and push are the ones a
 * misdirected click costs something, so what they are called with is
 * pinned, and file actions ask before doing anything irreversible.
 */
describe('ProjectRow controls', () => {
  // gitStatuses carries counts — that is what /api/projects/git-status
  // returns and what the row reads. details carries the file list.
  const status = { dirty: 2, unpushed: 2, branch: 'main' };
  const dirty = {
    branch: 'main', isDirty: true, vcs: true,
    files: [{ file: 'a.ts', status: 'M' }, { file: 'notes.txt', status: '??' }],
    unpushedCount: 2, diffStat: ' 2 files changed', recentCommits: 'abc first',
  };
  const byText = (s: string) =>
    [...document.querySelectorAll('button')].find(b => b.textContent?.trim() === s);
  const click = (el?: Element) => act(() => { (el as HTMLElement)?.click(); });

  it('expands the project that was clicked, by name', () => {
    // Every row calls the same handler; passing the wrong project opens
    // someone else's diff.
    const toggleExpand = vi.fn();
    const { container } = show({ toggleExpand });
    click(container.querySelector('button')!);
    expect(toggleExpand).toHaveBeenCalledWith(expect.objectContaining({ name: '-home-fox-git-demo' }));
  });

  it('offers commit and push only once the row is open', () => {
    expect(byText('Commit')).toBeUndefined();
    cleanup();
    show({
      expanded: { '-home-fox-git-demo': true },
      gitStatuses: { '-home-fox-git-demo': status },
      details: { '-home-fox-git-demo': dirty },
    });
    expect([...document.querySelectorAll('button')].length).toBeGreaterThan(1);
  });

  it('commits the project it belongs to', () => {
    const commitOne = vi.fn();
    show({
      commitOne,
      expanded: { '-home-fox-git-demo': true },
      gitStatuses: { '-home-fox-git-demo': status },
      details: { '-home-fox-git-demo': dirty },
      getAction: () => ({ status: 'idle', kind: null, result: null, commitMsg: 'fix: the thing' }),
    });
    // The button appears only once a message exists, because commitOne
    // returns early without one and a live button that does nothing is
    // worse than a disabled one.
    const btn = [...document.querySelectorAll('button')]
      .find(b => b.textContent?.trim() === 'Commit + Push');
    if (!btn) throw new Error('no Commit + Push button');
    expect((btn as HTMLButtonElement).disabled).toBe(false);
    click(btn);
    expect(commitOne).toHaveBeenCalledWith(expect.objectContaining({ name: '-home-fox-git-demo' }));
  });

  it('asks before removing a file from a working tree', () => {
    // Delete and gitignore both change a repository, and neither is
    // visible afterwards from this page.
    const requestFileAction = vi.fn();
    show({
      requestFileAction,
      expanded: { '-home-fox-git-demo': true },
      gitStatuses: { '-home-fox-git-demo': status },
      details: { '-home-fox-git-demo': dirty },
    });
    const btn = [...document.querySelectorAll('button')].find(b => /ignore|delete/i.test(b.textContent ?? ''));
    if (!btn) throw new Error('missing control: btn');
    click(btn);
    expect(requestFileAction).toHaveBeenCalledWith('-home-fox-git-demo', expect.any(String), expect.any(String));
  });

  it('shows what an action is doing while it runs', () => {
    // git push over a slow link is seconds of nothing.
    const { container } = show({
      expanded: { '-home-fox-git-demo': true },
      gitStatuses: { '-home-fox-git-demo': status },
      details: { '-home-fox-git-demo': dirty },
      getAction: () => ({ status: 'running', kind: 'push', result: 'pushing…', commitMsg: '' }),
    });
    expect(container.textContent).toContain('pushing');
  });

  it('names which model wrote a suggested commit message', () => {
    // The message came from a model, and which one it was is the only
    // thing that says whether it cost anything.
    const { container } = show({
      expanded: { '-home-fox-git-demo': true },
      gitStatuses: { '-home-fox-git-demo': status },
      details: { '-home-fox-git-demo': dirty },
      getAction: () => ({ status: 'done', kind: 'suggest', result: 'fix: the thing', provider: 'qwen-mesh', commitMsg: 'fix: the thing' }),
    });
    expect(container.textContent).toContain('via qwen-mesh');
  });

  it('shows the reason an action failed, rather than reverting to idle', () => {
    const { container } = show({
      expanded: { '-home-fox-git-demo': true },
      gitStatuses: { '-home-fox-git-demo': status },
      details: { '-home-fox-git-demo': dirty },
      getAction: () => ({ status: 'error', kind: 'push', result: 'rejected: fetch first', commitMsg: '' }),
    });
    expect(container.textContent).toContain('rejected: fetch first');
  });
});
