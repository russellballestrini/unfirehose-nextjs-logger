// @vitest-environment jsdom
import { Suspense } from 'react';
import { describe, it, expect, beforeEach, beforeAll, afterEach, vi } from 'vitest';
import { render, cleanup, act, waitFor } from '@testing-library/react';

/**
 * One todo, in full.
 *
 * This is where somebody lands from a link in a transcript, so it has to
 * survive every shape a todo comes in: one nobody estimated, one no
 * session produced, one whose agent has been and gone. Its four tabs each
 * render a different half of the record and three of them never draw until
 * clicked.
 *
 * It also has the one control on the page that changes anything — the
 * status buttons — and those offer only the statuses the todo is not
 * already in.
 */

let todo: Record<string, unknown> | undefined;
let failed: Error | undefined;
const mutate = vi.fn();
vi.mock('swr', () => ({
  default: () => ({ data: todo, error: failed, isLoading: false, mutate }),
  useSWRConfig: () => ({ mutate: vi.fn() }),
}));
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn() }), useParams: () => ({ id: '1' }),
  usePathname: () => '/todos/1', useSearchParams: () => new URLSearchParams(),
}));

const TodoDetailPage = (await import('./page')).default;

const full = (over: Record<string, unknown> = {}) => ({
  id: 1, uuid: '01a03597-28b3-7b9c-991e-35decbcd4e4c', content: 'cover the ingest path',
  status: 'pending', activeForm: 'covering the ingest path', source: 'claude',
  externalId: '1', estimatedMinutes: 30, blockedBy: [], blocking: [],
  createdAt: '2026-09-01T10:00:00Z', updatedAt: '2026-09-02T10:00:00Z', completedAt: null,
  project: { name: '-home-fox-git-demo', display: 'demo', path: '/home/fox/git/demo' },
  session: { uuid: 'sess-1', display: 'demo #1', firstPrompt: 'add a test' },
  deployments: [{ id: 7, tmuxSession: 'demo', tmuxWindow: '120000', status: 'completed',
                  startedAt: '2026-09-01T11:00:00Z', stoppedAt: '2026-09-01T11:30:00Z' }],
  attachments: [{ id: 3, filename: 'screenshot.png', hash: 'abc123', bytes: 4096 }],
  events: [{ oldStatus: 'pending', newStatus: 'in_progress', at: '2026-09-01T11:00:00Z' }],
  ...over,
});

/** `use(params)` suspends on a bare promise; a settled one runs at once. */
const settled = <T,>(value: T) =>
  Object.assign(Promise.resolve(value), { status: 'fulfilled', value }) as Promise<T>;

const patches = () => (global.fetch as unknown as { mock: { calls: unknown[][] } }).mock.calls
  .filter(([, init]) => (init as { method?: string } | undefined)?.method === 'PATCH')
  .map(([, init]) => JSON.parse((init as { body: string }).body));

beforeAll(() => {
  Object.assign(navigator, { clipboard: { writeText: vi.fn() } });
  window.ResizeObserver ??= class { observe() {} unobserve() {} disconnect() {} } as never;
});
beforeEach(() => {
  todo = full(); failed = undefined; mutate.mockClear();
  global.fetch = vi.fn(async () => ({ ok: true, json: async () => ({ ok: true }) })) as never;
});
afterEach(cleanup);

const show = async () => {
  const view = render(
    <Suspense fallback={null}><TodoDetailPage params={settled({ id: '1' })} /></Suspense>,
  );
  await act(async () => { await Promise.resolve(); });
  return view;
};

const byText = (s: string) =>
  [...document.querySelectorAll('button')].find(b => b.textContent?.trim() === s);

describe('todo detail', () => {
  it('shows what the todo says and where it came from', async () => {
    const { container } = await show();
    expect(container.textContent).toContain('cover the ingest path');
    expect(container.textContent).toContain('demo');
  });

  it('says it could not load rather than showing an empty record', async () => {
    failed = new Error('offline');
    expect((await show()).container.textContent).toContain('Failed to load todo');
  });

  it('shows the message when the API refuses by name', async () => {
    // A deleted todo answers with an error in the body, not a rejection.
    todo = { error: 'No todo with id 1' };
    expect((await show()).container.textContent).toContain('No todo with id 1');
  });

  it('renders every tab', async () => {
    const { container } = await show();
    for (const name of ['Deployments', 'Session', 'Attachments']) {
      await act(async () => { byText(name)?.click(); });
      expect(container.textContent!.length).toBeGreaterThan(100);
    }
  });

  it('counts what is on the tabs that have counts', async () => {
    const { container } = await show();
    expect(container.textContent).toMatch(/Deployments\s*1/);
    expect(container.textContent).toMatch(/Attachments\s*1/);
  });

  it('offers the statuses this todo is not already in', async () => {
    // Offering the current one is a no-op button, and offering all four
    // makes it unclear which one it is in.
    await show();
    expect(byText('in progress')).toBeTruthy();
    expect(byText('completed')).toBeTruthy();
    expect(byText('obsolete')).toBeTruthy();
    expect(byText('pending')).toBeUndefined();
  });

  it('changes status, then re-reads rather than assuming', async () => {
    // A todo also moves from under this page — an agent completes it — so
    // the answer comes from the server, not from what we just sent.
    await show();
    await act(async () => { byText('completed')!.click(); });
    await waitFor(() => expect(patches()).toEqual([{ id: 1, status: 'completed' }]));
    expect(mutate).toHaveBeenCalled();
  });

  it('copies the uuid, which is the id that survives a re-ingest', async () => {
    await show();
    const uuidBtn = [...document.querySelectorAll('button')]
      .find(b => b.textContent?.includes('01a03597'));
    await act(async () => { uuidBtn!.click(); });
    expect(navigator.clipboard.writeText).toHaveBeenCalledWith('01a03597-28b3-7b9c-991e-35decbcd4e4c');
  });

  it('renders a todo nobody estimated and no session produced', async () => {
    // Most todos are this. A page that only draws the complete record is a
    // page that mostly does not draw.
    todo = full({
      estimatedMinutes: null, session: null, externalId: null, uuid: null,
      deployments: [], attachments: [], events: [], activeForm: null, blockedBy: [], blocking: [],
    });
    const { container } = await show();
    expect(container.textContent).toContain('cover the ingest path');
  });

  it('renders a completed todo with its agent already gone', async () => {
    todo = full({ status: 'completed', completedAt: '2026-09-02T12:00:00Z' });
    const { container } = await show();
    expect(container.textContent).toContain('completed');
    await act(async () => { byText('Deployments')?.click(); });
    expect(container.textContent).toContain('demo');
  });
});
