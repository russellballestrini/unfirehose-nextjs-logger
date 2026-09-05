// @vitest-environment jsdom
import { describe, it, expect, vi, beforeAll, afterEach } from 'vitest';
import { render, cleanup, act } from '@testing-library/react';
import { ChangesView } from './page';

/**
 * The git side of a project's Code tab.
 *
 * Thirty-six branches: files added, modified, deleted or untracked, a diff
 * shown or hidden, a commit idle or running or failed, a repo clean with
 * nothing to do. Reaching them meant opening a project, switching tabs, and
 * having a repository in the right state.
 */

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn() }), useParams: () => ({ project: 'demo' }),
  usePathname: () => '/projects/demo', useSearchParams: () => new URLSearchParams(),
}));

beforeAll(() => {
  window.ResizeObserver ??= class { observe() {} unobserve() {} disconnect() {} } as never;
  global.fetch = vi.fn().mockResolvedValue({ ok: true, json: async () => ({}) }) as never;
});

afterEach(cleanup);

const gitData = (over: Record<string, unknown> = {}) => ({
  branch: 'main',
  files: [
    { file: 'apps/web/src/app/page.tsx', status: 'M' },
    { file: 'docs/new.md', status: '?' },
    { file: 'old.ts', status: 'D' },
    { file: 'added.ts', status: 'A' },
  ],
  diff: 'diff --git a/x b/x\n+added line\n-removed line\n',
  recentCommits: 'abc1234 first commit\ndef5678 second commit',
  ...over,
});

const show = (props: Record<string, unknown> = {}) =>
  render(
    <ChangesView
      gitData={gitData()}
      changedCount={4}
      commitMsg=""
      setCommitMsg={vi.fn()}
      commitPhase={null}
      commitResult={null}
      isCommitting={false}
      suggesting={false}
      handleSuggest={vi.fn()}
      handleCommit={vi.fn()}
      handlePush={vi.fn()}
      showDiff={false}
      setShowDiff={vi.fn()}
      pendingFileAction={null}
      requestFileAction={vi.fn()}
      setTreePath={vi.fn()}
      setCodeView={vi.fn()}
      executeFileAction={vi.fn()}
      {...props}
    />,
  );

describe('ChangesView', () => {
  it('lists every changed file', () => {
    const text = show().container.textContent ?? '';
    expect(text).toContain('page.tsx');
    expect(text).toContain('docs/new.md');
    expect(text).toContain('old.ts');
  });

  it('shows the recent commits', () => {
    expect(show().container.textContent).toContain('first commit');
  });

  it('hides the diff until it is asked for', () => {
    expect(show().container.textContent).not.toContain('added line');
    expect(show({ showDiff: true }).container.textContent).toContain('added line');
  });

  it('renders a clean repository with nothing staged', () => {
    const { container } = show({
      gitData: gitData({ files: [], diff: '' }), changedCount: 0,
    });
    expect(container.textContent).toContain('first commit');
  });

  it('renders a repository with no commits yet', () => {
    expect(() => show({ gitData: gitData({ recentCommits: '' }) })).not.toThrow();
  });

  it('renders while a commit is running', () => {
    expect(() => show({ commitPhase: 'committing', isCommitting: true, commitMsg: 'wip' })).not.toThrow();
  });

  it('renders while the push that follows is running', () => {
    expect(() => show({ commitPhase: 'pushing', isCommitting: true })).not.toThrow();
  });

  it('shows what a finished commit reported', () => {
    const { container } = show({ commitPhase: 'done', commitResult: 'abc1234 (rebased)' });
    expect(container.textContent).toContain('abc1234');
  });

  it('shows an error from a commit that failed', () => {
    const { container } = show({ commitPhase: 'error', commitResult: 'Error: nothing to commit' });
    expect(container.textContent).toContain('nothing to commit');
  });

  it('renders while a message is being suggested', () => {
    expect(() => show({ suggesting: true })).not.toThrow();
  });

  it('renders with a file action awaiting confirmation', () => {
    expect(() => show({ pendingFileAction: 'delete:old.ts' })).not.toThrow();
  });

  it('renders before git data has arrived', () => {
    expect(() => show({ gitData: undefined, changedCount: 0 })).not.toThrow();
  });

  it('leaves its controls pressable', () => {
    const { container } = show({ showDiff: true, commitMsg: 'a message' });
    const buttons = [...container.querySelectorAll('button')];
    for (const b of buttons) act(() => { (b as HTMLElement).click(); });
    expect(buttons.length).toBeGreaterThan(3);
  });
});
