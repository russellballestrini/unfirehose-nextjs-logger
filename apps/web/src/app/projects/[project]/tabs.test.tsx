// @vitest-environment jsdom
import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from 'vitest';
import { render, cleanup, act, fireEvent, waitFor } from '@testing-library/react';
import {
  ProjectHeader, ProjectTabs, OverviewTab, SessionsTab, CommitsTab,
  ActivityTab, FilesView, CodeTab,
} from './page';

/**
 * A project's header, tab strip and every tab.
 *
 * Split out of ProjectPage and CodeTab earlier today. Each still only
 * rendered if the page put it there, against a project with sessions,
 * commits and a repository behind it.
 */

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn() }), useParams: () => ({ project: 'demo' }),
  usePathname: () => '/projects/demo', useSearchParams: () => new URLSearchParams(),
}));

beforeAll(() => {
  window.ResizeObserver ??= class { observe() {} unobserve() {} disconnect() {} } as never;
  window.confirm ??= (() => true) as never;
  global.fetch = vi.fn().mockResolvedValue({ ok: true, json: async () => ({}) }) as never;
  Object.defineProperty(HTMLElement.prototype, 'offsetWidth', { configurable: true, value: 1024 });
  Object.defineProperty(HTMLElement.prototype, 'offsetHeight', { configurable: true, value: 400 });
});

afterEach(cleanup);

const session = {
  sessionId: 's1', displayName: 'session one', firstPrompt: 'do the thing',
  gitBranch: 'main', messageCount: 12, modified: '2026-09-04T13:00:00Z',
  isSidechain: false,
};

const data = {
  sessions: [session, { ...session, sessionId: 's2', displayName: 'session two', isSidechain: true }],
  originalPath: '/home/fox/git/demo',
};

const full = {
  project: { displayName: 'demo', name: '-home-fox-git-demo', path: '/home/fox/git/demo' },
  visibility: 'private',
  stats: {
    sessionCount: 2, messageCount: 24, activeDays: 3, totalCost: 1.5,
    firstActivity: '2026-06-01T12:00:00Z',
    costSplit: { input: 0.4, output: 0.5, cacheRead: 0.5, cacheWrite: 0.1 },
  },
  todos: [{ id: 1, content: 'a task', status: 'pending', uuid: 'u1', createdAt: '2026-09-04T12:00:00Z' }],
  models: [{ model: 'claude-opus-4-6', messages: 12, cost: 1.2 }],
  toolUsage: [{ name: 'Bash', count: 40 }, { name: 'Read', count: 22 }],
  prompts: [{ text: 'do the thing', at: '2026-09-04T12:00:00Z' }],
};

const meta = {
  branch: 'main',
  remotes: [{ name: 'origin', url: 'git@example.com:demo.git' }],
  // CommitsTab maps over this; ChangesView splits a string. Two components,
  // two shapes, and each fixture matches the one it feeds.
  recentCommits: [
    { hash: 'abc1234', subject: 'first commit', author: 'fox', date: '2026-09-04T12:00:00Z', relative: '1 hour ago' },
    { hash: 'def5678', subject: 'second commit', author: 'fox', date: '2026-09-04T11:00:00Z', relative: '2 hours ago' },
  ],
  claudeMd: '# demo\n\nnotes for the agent\n',
};

const treeData = {
  type: 'tree', path: '', branch: 'main',
  entries: [
    { name: 'src', type: 'tree', size: 0 },
    { name: 'README.md', type: 'blob', size: 26100 },
  ],
};

const gitData = {
  branch: 'main',
  files: [{ file: 'a.ts', status: 'M' }],
  diff: 'diff --git a/a b/a\n+one\n',
  recentCommits: 'abc1234 first commit',
};

describe('project page pieces', () => {
  it('shows the project name and remote in the header', () => {
    const { container } = render(
      <ProjectHeader
        decodedProject="-home-fox-git-demo" derivedProjectPath="/home/fox/git/demo"
        full={full} meta={meta} fetchRemotes={meta.remotes}
        booting={false} bootSession={vi.fn()} bootResult={null} bootTmux={null}
        yolo setYolo={vi.fn()}
      />,
    );
    expect(container.textContent).toContain('demo');
  });

  it('renders the header before anything has loaded', () => {
    expect(() => render(
      <ProjectHeader
        decodedProject="-home-fox-git-demo" derivedProjectPath={null}
        full={undefined} meta={undefined} fetchRemotes={[]}
        booting={false} bootSession={vi.fn()} bootResult={null} bootTmux={null}
        yolo={false} setYolo={vi.fn()}
      />,
    )).not.toThrow();
  });

  it('shows a boot result with its tmux link', () => {
    const { container } = render(
      <ProjectHeader
        decodedProject="demo" derivedProjectPath="/x" full={full} meta={meta}
        fetchRemotes={[]} booting={false} bootSession={vi.fn()}
        bootResult="started agent-1" bootTmux={{ session: 'agent-1', host: 'cammy' }}
        yolo setYolo={vi.fn()}
      />,
    );
    expect(container.textContent).toContain('agent-1');
  });

  it('counts each tab that has a count', () => {
    const { container } = render(
      <ProjectTabs tab="overview" setTab={vi.fn()} data={data} todoCount={8} commitCount={10} />,
    );
    expect(container.textContent).toContain('8');
    expect(container.textContent).toContain('10');
  });

  it('shows the overview with its stats and launcher', () => {
    const { container } = render(
      <OverviewTab
        full={full} data={data} meta={meta} project="demo" decodedProject="demo"
        thisActivity={{ total_input: 1000, total_output: 500, cost_estimate: 1.5 }}
        globalTotals={{ input: 100000, output: 50000, cost: 120 }} fetchRemotes={[]}
        newTask="" setNewTask={vi.fn()} addTask={vi.fn()} taskSubmitting={false}
        harness="claude-code" setHarness={vi.fn()} model="" setModel={vi.fn()}
        harnessModels={{}} customCmd="" setCustomCmd={vi.fn()}
        target="localhost" setTarget={vi.fn()} targets={['localhost']}
      />,
    );
    // The project's name lives in the header; the overview is its numbers.
    expect(container.textContent).toContain('Sessions');
    expect(container.textContent).toContain('Open Todos');
    expect(container.textContent).toContain('Recent Commits');
  });

  it('lists the sessions', () => {
    const { container } = render(<SessionsTab data={data} project="demo" />);
    expect(container.textContent).toContain('session one');
  });

  it('renders sessions when there are none yet', () => {
    expect(() => render(<SessionsTab data={{ sessions: [] }} project="demo" />)).not.toThrow();
  });

  it('lists the commits', () => {
    const { container } = render(
      <CommitsTab meta={meta} fetchRemotes={meta.remotes} activityData={{ commits: [] }} project="demo" />,
    );
    expect(container.textContent).toContain('first commit');
  });

  it('renders activity', () => {
    expect(() => render(
      <ActivityTab activityData={{ days: [], commits: [] }} project="demo" decodedProject="demo" />,
    )).not.toThrow();
  });

  it('browses a directory', () => {
    const { container } = render(
      <FilesView treeData={treeData} treePath="" setTreePath={vi.fn()} />,
    );
    expect(container.textContent).toContain('README.md');
  });

  it('shows a file with its line numbers', () => {
    const { container } = render(
      <FilesView
        treeData={{
          type: 'file', name: 'README.md', path: 'README.md', content: '# one\n## two\n',
          size: 13, lang: 'markdown', sizeKB: 0.013,
          lastCommit: { hash: 'abc1234', message: 'first commit', age: '1 hour ago' },
        }}
        treePath="README.md" setTreePath={vi.fn()}
      />,
    );
    expect(container.textContent).toContain('# one');
  });

  it('renders the code tab on both its views', () => {
    const { container } = render(
      <CodeTab gitData={gitData} mutateGit={vi.fn()} project="demo"
               treeData={treeData} treePath="" setTreePath={vi.fn()} />,
    );
    expect(container.textContent).toContain('README.md');
    for (const b of container.querySelectorAll('button')) act(() => { (b as HTMLElement).click(); });
  });

  it('renders the code tab before git has answered', () => {
    expect(() => render(
      <CodeTab gitData={undefined} mutateGit={vi.fn()} project="demo"
               treeData={undefined} treePath="" setTreePath={vi.fn()} />,
    )).not.toThrow();
  });
});

/**
 * Committing from the code tab.
 *
 * This one commits and pushes as two separate requests on purpose: the
 * commit is reported as landed before the push is attempted, so a push
 * that fails cannot make a successful commit look like a failure and send
 * somebody to run it again.
 *
 * Staging is the other decision. Adding everything sweeps in whatever else
 * is in the tree, which — when agents are working in parallel — is their
 * half-written files.
 */
describe('committing from the code tab', () => {
  let answers: Record<string, unknown>[];
  const posts = () => (global.fetch as unknown as { mock: { calls: unknown[][] } }).mock.calls
    .filter(([, init]) => (init as { method?: string } | undefined)?.method === 'POST')
    // The suggest call carries no body, so this cannot assume one.
    .map(([url, init]) => ({
      url: String(url),
      body: (() => {
        try { return JSON.parse((init as { body?: string }).body ?? 'null'); }
        catch { return null; }
      })(),
    }));

  const dirty = {
    branch: 'main', isDirty: true, vcs: true, unpushedCount: 0,
    files: [{ file: 'a.ts', status: 'M' }, { file: 'scratch.txt', status: '??' }],
    diffStat: ' 1 file changed', diff: 'diff --git a/a.ts b/a.ts\n+x\n',
    recentCommits: 'abc first',
  };

  /**
   * The commit box lives in the Changes view and the tab opens on Files.
   * These tests used to render, find no box, and return — passing without
   * asserting anything, which is worse than failing. Nothing is optional
   * here now: a missing control throws.
   */
  const open = () => {
    const view = render(
      <CodeTab gitData={dirty} mutateGit={vi.fn()} project="demo"
               treeData={treeData} treePath="" setTreePath={vi.fn()} />,
    );
    const changes = [...view.container.querySelectorAll('button')]
      .find(b => b.textContent?.trim().startsWith('Changes'));
    if (!changes) throw new Error('no Changes tab — the code view moved');
    act(() => { changes.click(); });
    return view;
  };

  const need = <T,>(el: T | null | undefined, what: string): T => {
    if (!el) throw new Error(`no ${what} — the Changes view moved`);
    return el;
  };
  const box = (c: HTMLElement) =>
    need(c.querySelector('input[placeholder*="ommit"]'), 'commit box') as HTMLInputElement;
  const button = (label: string) =>
    need([...document.querySelectorAll('button')]
      .find(b => b.textContent?.trim().startsWith(label)), `${label} button`);

  const type = (c: HTMLElement, msg: string) =>
    fireEvent.change(box(c), { target: { value: msg } });

  beforeEach(() => {
    answers = [
      { success: true, commit: 'def5678 the commit', pushed: false },
      { success: true, pushed: true },
    ];
    let n = 0;
    global.fetch = vi.fn(async () => ({
      ok: true, json: async () => answers[Math.min(n++, answers.length - 1)],
    })) as never;
  });

  it('will not commit an empty message', () => {
    const { container } = open();
    expect((button('Commit all') as HTMLButtonElement).disabled).toBe(true);
    type(container, '   ');
    expect((button('Commit all') as HTMLButtonElement).disabled).toBe(true);
  });

  it('offers staging as two buttons rather than a checkbox nobody reads', async () => {
    // 'Commit tracked' leaves scratch.txt alone; 'Commit all' sweeps it
    // in. When agents work in parallel, what else is in the tree is their
    // half-written files, so this is a choice worth making explicit.
    const { container } = open();
    type(container, 'fix: the thing');
    await act(async () => { button('Commit tracked').click(); });
    await waitFor(() => expect(posts()[0].body.addAll).toBe(false));
  });

  it('sweeps everything in when asked to', async () => {
    const { container } = open();
    type(container, 'fix: the thing');
    await act(async () => { button('Commit all').click(); });
    await waitFor(() => expect(posts()[0].body.addAll).toBe(true));
  });

  it('commits without pushing, then pushes separately', async () => {
    // skipPush on the commit is what lets the page say 'committed' before
    // it knows whether the push worked.
    const { container } = open();
    type(container, 'fix: the thing');
    await act(async () => { button('Commit all').click(); });
    await waitFor(() => expect(posts()).toHaveLength(2));
    expect(posts()[0].body).toMatchObject({ message: 'fix: the thing', skipPush: true });
    expect(posts()[1].body).toEqual({ action: 'push' });
  });

  it('keeps the commit when the push is rejected', async () => {
    // The commit exists. Reporting the whole thing as failed is how a
    // change gets committed twice.
    answers = [
      { success: true, commit: 'def5678 the commit' },
      { success: false, error: 'rejected: fetch first' },
    ];
    const { container } = open();
    type(container, 'a commit');
    await act(async () => { button('Commit all').click(); });
    // It says the commit landed and why the push did not. The hash is not
    // repeated here, which is a small loss — the recent-commits list above
    // already shows it.
    await waitFor(() => expect(container.textContent).toContain('Committed — push failed'));
    expect(container.textContent).toContain('rejected: fetch first');
  });

  it('says when the push had to rebase first', async () => {
    // Somebody else pushed in between. Silently rewriting history is a
    // change nobody was told about.
    answers = [
      { success: true, commit: 'def5678 the commit' },
      { success: true, pushed: true, rebased: true },
    ];
    const { container } = open();
    type(container, 'a commit');
    await act(async () => { button('Commit all').click(); });
    await waitFor(() => expect(container.textContent).toContain('rebased'));
  });

  it('reports a refused commit without claiming to have pushed', async () => {
    answers = [{ success: false, error: 'Nothing staged to commit' }];
    const { container } = open();
    type(container, 'a commit');
    await act(async () => { button('Commit all').click(); });
    await waitFor(() => expect(container.textContent).toContain('Nothing staged'));
    expect(posts()).toHaveLength(1);
  });

  it('clears the box once the commit has landed', async () => {
    // Leaving it invites a second commit of the same text.
    const { container } = open();
    type(container, 'a commit');
    await act(async () => { button('Commit all').click(); });
    await waitFor(() => expect(box(container).value).toBe(''));
  });

  it('asks the model for a message and puts it in the box', async () => {
    answers = [{ message: 'fix: the gauge thresholds' }];
    const { container } = open();
    await act(async () => { button('Generate').click(); });
    await waitFor(() => expect(box(container).value).toBe('fix: the gauge thresholds'));
    expect(posts().some(p => p.url.includes('/git/suggest'))).toBe(true);
  });

  it('pushes on its own when there is nothing left to commit', async () => {
    answers = [{ success: true, pushed: true }];
    open();
    await act(async () => { button('Push').click(); });
    await waitFor(() => expect(posts()[0].body).toEqual({ action: 'push' }));
  });
});
