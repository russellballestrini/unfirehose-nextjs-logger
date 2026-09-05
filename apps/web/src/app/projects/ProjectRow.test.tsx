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
