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
  attachments: [{ id: 3, filename: 'screenshot.png', hash: 'abc123', mimeType: 'image/png', sizeBytes: 4096 }],
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
/** A tab button, whose label may carry a count ("Deployments1"). */
const tabButton = (label: string) =>
  [...document.querySelectorAll('button')].find(b => (b.textContent ?? '').trim().startsWith(label));

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
      const tab = tabButton(name);
      expect(tab, name).toBeTruthy();
      await act(async () => { tab!.click(); });
      expect(container.textContent!.length).toBeGreaterThan(100);
    }
  });

  it('lists each deployment with its state, its tmux window and when it ran', async () => {
    todo = full({ deployments: [
      { id: 1, tmuxSession: 'demo', tmuxWindow: '120000', status: 'running', startedAt: '2026-09-01T11:00:00Z', stoppedAt: null },
      { id: 2, tmuxSession: 'demo', tmuxWindow: null, status: 'completed', startedAt: '2026-09-01T09:00:00Z', stoppedAt: '2026-09-01T09:30:00Z' },
      { id: 3, tmuxSession: 'other', tmuxWindow: 'w2', status: 'failed', startedAt: null, stoppedAt: null },
    ] });
    const { container } = await show();
    await act(async () => { tabButton('Deployments')!.click(); });
    const text = container.textContent!;
    expect(text).toContain('RUNNING');
    expect(text).toContain('COMPLETED');
    expect(text).toContain('FAILED');
    expect(text).toContain('demo:120000');
    expect(text).toContain('other:w2');
    expect(text).toMatch(/Stopped:/);
    const links = [...container.querySelectorAll('a')].map(a => a.getAttribute('href'));
    expect(links).toContain('/tmux/demo?window=120000');
    expect(links).toContain('/tmux/demo');
    expect(links).toContain('/tmux/other?window=w2');
    // One pulse for the one still running.
    expect(container.querySelectorAll('.animate-pulse')).toHaveLength(1);
  });

  it('shows an image attachment as a picture and any other as its type and size', async () => {
    todo = full({ attachments: [
      { id: 3, filename: 'shot.png', hash: 'h1', mimeType: 'image/png', sizeBytes: 4096 },
      { id: 4, filename: 'log.txt', hash: 'h2', mimeType: 'text/plain', sizeBytes: 2048 },
      { id: 5, filename: 'legacy.bin', hash: 'h3', sizeBytes: 10 },          // ingested before mime types were recorded
    ] });
    const { container } = await show();
    await act(async () => { tabButton('Attachments')!.click(); });
    expect(container.querySelectorAll('img')).toHaveLength(1);
    expect(container.textContent).toContain('text/plain');
    expect(container.textContent).toContain('2.0 KB');
    expect(container.textContent).toContain('legacy.bin');
    const hrefs = [...container.querySelectorAll('a')].map(a => a.getAttribute('href'));
    expect(hrefs).toContain('/api/todos/attachments/h2');
  });

  it('says so when a todo was never deployed', async () => {
    todo = full({ deployments: [] });
    const { container } = await show();
    await act(async () => { tabButton('Deployments')!.click(); });
    expect(container.textContent).toContain('No deployments for this todo.');
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
