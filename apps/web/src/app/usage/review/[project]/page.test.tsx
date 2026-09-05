// @vitest-environment jsdom
import { describe, it, expect, beforeEach, beforeAll, afterEach, vi } from 'vitest';
import { render, cleanup, act, fireEvent, waitFor } from '@testing-library/react';

/**
 * Reviewing a project's changes, then committing them.
 *
 * Two things happen here that reach outside the browser. The suggest
 * button sends this repo's diff to a model, carrying an API key that only
 * exists decrypted in the page — the key is passed in a header rather than
 * stored server-side, and that is the whole point of the vault. And the
 * commit button commits, with a staging choice that decides whether
 * untracked files come along.
 *
 * No key material here is real.
 */

let git: Record<string, unknown> | undefined;
let failed: Error | undefined;
const mutate = vi.fn();
vi.mock('swr', () => ({
  default: () => ({ data: git, error: failed, isLoading: false, mutate }),
  useSWRConfig: () => ({ mutate: vi.fn() }),
}));
vi.mock('next/navigation', () => ({
  useParams: () => ({ project: '-home-fox-git-demo' }),
  useRouter: () => ({ push: vi.fn() }),
  usePathname: () => '/usage/review/demo', useSearchParams: () => new URLSearchParams(),
}));

const vaultKeys: Record<string, string> = { openai: 'sk-fake-for-tests' };
let preferred: string | undefined = 'openai';
vi.mock('@unturf/unfirehose-ui/VaultProvider', () => ({
  useVault: () => ({
    ready: true, unlocked: true, exists: true,
    data: { preferred },
    getKey: (id: string) => vaultKeys[id] ?? '',
    setKey: vi.fn(), removeKey: vi.fn(), setPreferred: vi.fn(), lock: vi.fn(), unlock: vi.fn(),
  }),
  VaultProvider: ({ children }: { children: React.ReactNode }) => children,
}));

const ReviewPage = (await import('./page')).default;

const dirty = {
  repoPath: '/home/fox/git/demo', branch: 'main', isDirty: true, vcs: true,
  files: [{ file: 'a.ts', status: 'M' }, { file: 'scratch.txt', status: '??' }],
  diffStat: ' 1 file changed, 2 insertions(+)',
  diff: 'diff --git a/a.ts b/a.ts\n+const answer = 42;\n',
  recentCommits: 'abc1234 an earlier commit', unpushedCount: 0,
};

let answer: Record<string, unknown>;
const calls = () => (global.fetch as unknown as { mock: { calls: unknown[][] } }).mock.calls
  .map(([url, init]) => ({
    url: String(url),
    headers: ((init as { headers?: Record<string, string> })?.headers ?? {}),
    body: (() => { try { return JSON.parse((init as { body?: string })?.body ?? 'null'); } catch { return null; } })(),
  }));

beforeAll(() => {
  window.ResizeObserver ??= class { observe() {} unobserve() {} disconnect() {} } as never;
});
beforeEach(() => {
  git = dirty; failed = undefined; preferred = 'openai';
  answer = { success: true, commit: 'def5678 the commit', pushed: true };
  mutate.mockClear();
  global.fetch = vi.fn(async () => ({ ok: true, status: 200, json: async () => answer })) as never;
});
afterEach(cleanup);

const show = async () => {
  const view = render(<ReviewPage />);
  await act(async () => { await Promise.resolve(); });
  return view;
};
const button = (label: string) =>
  [...document.querySelectorAll('button')].find(b => b.textContent?.trim() === label);
const msgBox = () =>
  document.querySelector('textarea[placeholder^="Commit message"]') as HTMLTextAreaElement;

describe('review page', () => {
  it('shows the branch and what changed on it', async () => {
    const { container } = await show();
    expect(container.textContent).toContain('main');
    expect(container.textContent).toContain('a.ts');
  });

  it('names the project without its encoded prefix', async () => {
    expect((await show()).container.textContent).toContain('Review: demo');
  });

  it('says it could not read git rather than showing a clean repo', async () => {
    failed = new Error('offline');
    expect((await show()).container.textContent).toContain('Failed to load git status');
  });

  it('passes on an error git itself reported', async () => {
    git = { error: 'not a git repository', detail: '/home/fox/git/demo' };
    const t = (await show()).container.textContent!;
    expect(t).toContain('not a git repository');
    expect(t).toContain('/home/fox/git/demo');
  });

  it('will not commit with no message', async () => {
    await show();
    expect((button('Commit') as HTMLButtonElement).disabled).toBe(true);
  });

  it('commits the message that was typed', async () => {
    await show();
    fireEvent.change(msgBox(), { target: { value: 'fix: the gauge thresholds' } });
    await act(async () => { button('Commit')!.click(); });
    await waitFor(() => expect(calls().find(c => c.body?.message)).toMatchObject({
      url: '/api/projects/-home-fox-git-demo/git',
      body: { message: 'fix: the gauge thresholds', addAll: false },
    }));
  });

  it('stages only tracked files unless asked for everything', async () => {
    // addAll sweeps in scratch.txt and anything else lying in the tree.
    await show();
    fireEvent.change(msgBox(), { target: { value: 'a commit' } });
    fireEvent.click(document.querySelector('input[type="checkbox"]')!);
    await act(async () => { button('Commit')!.click(); });
    await waitFor(() => expect(calls().find(c => c.body?.message)?.body.addAll).toBe(true));
  });

  it('clears the box and re-reads after a commit lands', async () => {
    // Leaving the message behind invites a second commit of the same text.
    await show();
    fireEvent.change(msgBox(), { target: { value: 'a commit' } });
    await act(async () => { button('Commit')!.click(); });
    await waitFor(() => expect(msgBox().value).toBe(''));
    expect(mutate).toHaveBeenCalled();
  });

  it('keeps the message when the commit was refused', async () => {
    // Retyping it is the last thing anyone wants after a failed commit.
    answer = { error: 'Nothing staged to commit' };
    await show();
    fireEvent.change(msgBox(), { target: { value: 'a commit' } });
    await act(async () => { button('Commit')!.click(); });
    await waitFor(() => expect(document.body.textContent).toContain('Nothing staged'));
    expect(msgBox().value).toBe('a commit');
  });

  it('sends the vault key in a header, never to be stored', async () => {
    // The key is decrypted in this page and nowhere else. Storing it
    // server-side would undo the vault.
    answer = { message: 'fix: the gauge thresholds' };
    await show();
    await act(async () => { button('Generate')?.click(); });
    await waitFor(() => {
      const suggest = calls().find(c => c.url.endsWith('/git/suggest'));
      expect(suggest?.headers['x-vault-api-key']).toBe('sk-fake-for-tests');
    });
  });

  it('asks without a key when the vault has no preferred provider', async () => {
    // The server falls back to a model on our own mesh, which needs none.
    preferred = undefined;
    answer = { message: 'a suggestion' };
    await show();
    await act(async () => { button('Generate')?.click(); });
    await waitFor(() => {
      const suggest = calls().find(c => c.url.endsWith('/git/suggest'));
      expect(suggest?.headers['x-vault-api-key']).toBeUndefined();
    });
  });

  it('puts a suggested message into the box rather than committing it', async () => {
    answer = { message: 'fix: the gauge thresholds' };
    await show();
    await act(async () => { button('Generate')?.click(); });
    await waitFor(() => expect(msgBox().value).toBe('fix: the gauge thresholds'));
    expect(calls().some(c => c.body?.message)).toBe(false);
  });

  it('says why a suggestion could not be made', async () => {
    answer = { error: 'no provider configured' };
    await show();
    await act(async () => { button('Generate')?.click(); });
    await waitFor(() => expect(document.body.textContent).toContain('no provider configured'));
  });

  it('draws a clean repository without offering to commit nothing', async () => {
    git = { ...dirty, isDirty: false, files: [], diff: '', diffStat: '' };
    expect((await show()).container.textContent).toContain('main');
  });
});
