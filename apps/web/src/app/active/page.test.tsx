// @vitest-environment jsdom
import { describe, it, expect, beforeEach, beforeAll, afterEach, vi } from 'vitest';
import { render, cleanup, act } from '@testing-library/react';

/**
 * What is running right now.
 *
 * The one distinction this page makes that nothing else does is between
 * reasoning we can read and reasoning that arrived sealed. opus-4-7 ships
 * a signature with no readable text, so counting sealed blocks as
 * reasoning we hold overstates what is there — and the filter that hides
 * sessions with no reasoning at all is only useful if that count is
 * honest.
 */

let sessions: unknown[] | undefined;
let tmux: unknown;
vi.mock('swr', () => ({
  default: (key: string) => ({
    data: String(key).startsWith('/api/active-sessions') ? { sessions } : tmux,
    error: undefined, isLoading: false, mutate: vi.fn(),
  }),
  useSWRConfig: () => ({ mutate: vi.fn() }),
}));
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn() }), usePathname: () => '/active',
  useSearchParams: () => new URLSearchParams(),
}));

const ActivePage = (await import('./page')).default;

const session = (over: Record<string, unknown> = {}) => ({
  sessionUuid: 's1', projectName: '-home-fox-git-demo', projectDisplay: 'demo',
  harness: 'claude', model: 'claude-opus-4-6-20260301', messages: 40,
  lastActivity: new Date().toISOString(), firstPrompt: 'add a test',
  reasoningCount: 3, readableReasoningCount: 3, tokens: 900_000, costUSD: 2.4, ...over,
});

beforeAll(() => {
  window.ResizeObserver ??= class { observe() {} unobserve() {} disconnect() {} } as never;
  window.matchMedia ??= ((q: string) => ({
    matches: false, media: q, addEventListener() {}, removeEventListener() {},
  })) as never;
});
beforeEach(() => {
  sessions = [session()];
  tmux = { sessions: ['demo'] };
  localStorage.clear();
});
afterEach(cleanup);

const show = async () => {
  const view = render(<ActivePage />);
  await act(async () => { await Promise.resolve(); });
  return view;
};
/** The "Reasoning only" filter, which is a checkbox rather than a button. */
const reasoningOnly = () => {
  const el = document.querySelector('input[type="checkbox"]');
  if (!el) throw new Error('no reasoning-only checkbox');
  return el as HTMLInputElement;
};

describe('active sessions', () => {
  it('lists a running session', async () => {
    expect((await show()).container.textContent).toContain('demo');
  });

  it('says plainly when nothing is running', async () => {
    sessions = [];
    expect((await show()).container.textContent).toContain('No sessions found');
  });

  it('draws before the first response arrives', async () => {
    sessions = undefined;
    expect((await show()).container.textContent!.length).toBeGreaterThan(20);
  });

  it('separates sealed reasoning from reasoning we can read', async () => {
    // Counting a signature as reasoning we hold overstates what is there.
    sessions = [session({ reasoningCount: 10, readableReasoningCount: 4 })];
    const { container } = await show();
    expect(container.textContent).toContain('10');
    expect(container.textContent).toContain('4');
  });

  it('hides sessions with no reasoning when asked', async () => {
    sessions = [
      session({ sessionUuid: 's1', projectDisplay: 'thinker', reasoningCount: 3 }),
      session({ sessionUuid: 's2', projectName: '-home-fox-git-quiet', projectDisplay: 'quiet', reasoningCount: 0, readableReasoningCount: 0 }),
    ];
    const { container } = await show();
    expect(container.textContent).toContain('quiet');
    await act(async () => { reasoningOnly().click(); });
    expect(container.textContent).not.toContain('quiet');
  });

  it('counts every session for the totals, not only the shown ones', async () => {
    // The filter is a view. A total that moved with it would say the
    // sessions stopped reasoning when they were merely hidden.
    sessions = [session({ reasoningCount: 3 }), session({ sessionUuid: 's2', reasoningCount: 0, readableReasoningCount: 0 })];
    const { container } = await show();
    // Two sessions, three reasoning blocks between them. Hiding the quiet
    // one must not change that three.
    expect(container.textContent).toContain('3');
    await act(async () => { reasoningOnly().click(); });
    expect(container.textContent).toContain('3');
    expect(container.textContent).not.toContain('quiet');
  });

  it('renders a session that reported no reasoning at all', async () => {
    // Most harnesses report none, and the fields are simply absent.
    sessions = [session({ reasoningCount: undefined, readableReasoningCount: undefined })];
    expect((await show()).container.textContent).toContain('demo');
  });
});
