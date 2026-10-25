// @vitest-environment jsdom
import { describe, it, expect, beforeEach, beforeAll, afterEach, vi } from 'vitest';
import { render, cleanup, act } from '@testing-library/react';

/**
 * Actions: what our agents did on this machine.
 *
 * A flagged row has to stand out from its neighbours, every row has to
 * lead to its session at that tool call, and an empty page has to say
 * whether nothing was ever recorded or only nothing in this view.
 */

let data: Record<string, unknown> | undefined;
let failed: Error | undefined;
const keys: string[] = [];
vi.mock('swr', () => ({
  default: (key: string) => { keys.push(key); return { data, error: failed, isLoading: false, mutate: vi.fn() }; },
  useSWRConfig: () => ({ mutate: vi.fn() }),
}));
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn() }), usePathname: () => '/actions',
  useSearchParams: () => new URLSearchParams(),
}));

const ActionsPage = (await import('./page')).default;

const status = (over: Record<string, unknown> = {}) => ({ rows: 2, backfillRemaining: 0, headLag: 0, rulesVersion: 1, ...over });
const payload = (over: Record<string, unknown> = {}) => ({
  rows: [
    {
      id: 2, timestamp: '2026-10-22T12:00:00Z', kind: 'git', tool: 'Bash', harness: 'claude-code',
      paths: [], command: 'git reset --hard origin/main', flags: ['destructive'],
      reasons: 'git reset --hard discards uncommitted work',
      projectName: '-home-demo-git-demo-api', projectDisplayName: 'demo-api', sessionUuid: 'sess-1', toolUseId: 'toolu_7',
    },
    {
      id: 1, timestamp: '2026-10-22T11:00:00Z', kind: 'network', tool: 'WebFetch', harness: 'claude-code',
      paths: ['https://registry.npmjs.org/better-sqlite3'], command: 'https://registry.npmjs.org/better-sqlite3', flags: [],
      reasons: '', projectName: '-home-demo-git-demo-api', projectDisplayName: 'demo-api', sessionUuid: 'sess-1', toolUseId: 'toolu_6',
    },
  ],
  nextCursor: null,
  total: 2,
  kinds: { 'fs-read': 0, 'fs-write': 0, git: 1, network: 1, shell: 0 },
  flags: { destructive: 1 },
  flaggedRows: 1,
  status: status(),
  ...over,
});

beforeAll(() => {
  window.matchMedia ??= ((q: string) => ({ matches: false, media: q, addEventListener() {}, removeEventListener() {} })) as never;
});
beforeEach(() => {
  data = payload(); failed = undefined; keys.length = 0;
  localStorage.clear();
  window.history.replaceState(null, '', '/actions');
});
afterEach(cleanup);

const show = async () => {
  const view = render(<ActionsPage />);
  await act(async () => { await Promise.resolve(); });
  return view;
};

describe('actions page', () => {
  it('lists actions with flagged rows marked and their reasons said', async () => {
    const { container } = await show();
    expect(container.textContent).toContain('Actions');
    const flagged = container.querySelectorAll('tr[data-flagged="true"]');
    expect(flagged).toHaveLength(1);
    expect(flagged[0].textContent).toContain('git reset --hard origin/main');
    expect(flagged[0].textContent).toContain('destructive');
    expect(flagged[0].textContent).toContain('discards uncommitted work');
    expect(container.textContent).toContain('registry.npmjs.org');
  });

  it('links each row to its session at that tool call', async () => {
    const { container } = await show();
    const hrefs = [...container.querySelectorAll('a')].map((a) => a.getAttribute('href'));
    expect(hrefs).toContain('/projects/-home-demo-git-demo-api/sess-1#tool-toolu_7');
    expect(hrefs).toContain('/projects/-home-demo-git-demo-api');
  });

  it('takes a project from the link that opened it', async () => {
    window.history.replaceState(null, '', '/actions?project=-home-demo-git-demo-api&flag=any');
    const { container } = await show();
    expect(keys.some((k) => k.includes('project=-home-demo-git-demo-api') && k.includes('flag=any'))).toBe(true);
    expect(container.textContent).toContain('every project');
  });

  it('says what will appear when nothing was ever recorded', async () => {
    data = payload({ rows: [], total: 0, status: status({ rows: 0 }) });
    const { container } = await show();
    expect(container.querySelector('[data-empty-kind="first-run"]')?.textContent).toMatch(/will appear here/);
  });

  it('says a backfill is still running rather than that there is nothing', async () => {
    data = payload({ rows: [], total: 0, status: status({ rows: 0, backfillRemaining: 120000 }) });
    const { container } = await show();
    expect(container.textContent).toMatch(/classifying/);
  });

  it('offers to clear filters when only this view is empty', async () => {
    data = payload({ rows: [], total: 0 });
    const { container } = await show();
    const quiet = container.querySelector('[data-empty-kind="quiet"]');
    expect(quiet?.textContent).toContain('Clear filters');
  });

  it('draws before the first response, and when the endpoint failed', async () => {
    data = undefined;
    expect((await show()).container.textContent).toContain('Actions');
    cleanup();
    failed = new Error('offline');
    expect((await show()).container.textContent).toContain('could not be read');
  });
});
