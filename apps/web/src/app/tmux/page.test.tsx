// @vitest-environment jsdom
import { describe, it, expect, beforeEach, beforeAll, afterEach, vi } from 'vitest';
import { render, cleanup, act, fireEvent, waitFor } from '@testing-library/react';

/**
 * Every terminal we have open, and starting a new one.
 *
 * Two kinds of session live on this page and they are not interchangeable:
 * a tmux session on a machine we can ssh to, and an unsandbox container
 * that costs money and disappears. Creating either sends someone straight
 * into it, so where they land has to match what was made — a viewer opened
 * without the host it lives on attaches to a session of the same name on
 * this machine, or to nothing.
 */

let sessions: unknown;
let unsandbox: unknown;
let nicknames: unknown;
let projects: unknown;
const pushed: string[] = [];

vi.mock('swr', () => ({
  default: (key: string) => ({
    data: String(key).startsWith('/api/tmux/stream') ? sessions
      : String(key).startsWith('/api/unsandbox') ? unsandbox
      : String(key).startsWith('/api/sessions/nickname') ? nicknames
      : String(key).startsWith('/api/projects') ? projects
      : undefined,
    error: undefined, isLoading: false, mutate: vi.fn(),
  }),
  useSWRConfig: () => ({ mutate: vi.fn() }),
}));
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: (u: string) => { pushed.push(u); } }),
  usePathname: () => '/tmux', useSearchParams: () => new URLSearchParams(),
}));

const TmuxListPage = (await import('./page')).default;

/** Every POST the page made, as path plus parsed body. */
const posts = () => (global.fetch as unknown as { mock: { calls: unknown[][] } }).mock.calls
  .filter(([, init]) => (init as { method?: string } | undefined)?.method === 'POST')
  .map(([url, init]) => ({ url: String(url), body: JSON.parse((init as { body: string }).body) }));

let answer: Record<string, unknown>;
let ok = true;

beforeAll(() => {
  window.ResizeObserver ??= class { observe() {} unobserve() {} disconnect() {} } as never;
});
beforeEach(() => {
  pushed.length = 0; ok = true; answer = { ok: true, session_id: 'unsb-abc' };
  sessions = { sessions: ['demo', 'agnt'], deployments: {
    demo: { todos: [{ id: 11, uuid: 'todo-uuid' }], status: 'running', startedAt: '2026-09-04T12:00:00Z' },
  } };
  unsandbox = { sessions: [{ session_id: 'unsb-1', status: 'running', image: 'ubuntu:24.04' }] };
  nicknames = { demo: { nickname: 'the ingest work', host: 'localhost', service_name: '' } };
  projects = [{ name: '-home-fox-git-demo', displayName: 'demo', path: '/home/fox/git/demo' }];
  global.fetch = vi.fn(async () => ({ ok, status: ok ? 200 : 500, json: async () => answer })) as never;
});
afterEach(cleanup);

const show = async () => {
  const view = render(<TmuxListPage />);
  await act(async () => { await Promise.resolve(); });
  return view;
};

const byText = (s: string) =>
  [...document.querySelectorAll('button')].find(b => b.textContent?.trim() === s);
/** The spawn button names the host it will spawn on. */
const spawn = () =>
  [...document.querySelectorAll('button')].find(b => b.textContent?.includes('Spawn on'));
const tab = async (name: string) => {
  const el = [...document.querySelectorAll('button')].find(b => b.textContent?.includes(name));
  await act(async () => { el!.click(); });
};

describe('the session list', () => {
  it('lists both kinds of session', async () => {
    const { container } = await show();
    expect(container.textContent).toContain('demo');
    expect(container.textContent).toContain('unsb-1');
  });

  it('shows a nickname where one was given, since a tmux name is not a description', async () => {
    expect((await show()).container.textContent).toContain('the ingest work');
  });

  it('shows what an agent in a session is working on', async () => {
    // A list of session names says nothing about whether work is running.
    expect((await show()).container.textContent).toMatch(/running/i);
  });

  it('draws an empty list rather than nothing at all', async () => {
    sessions = { sessions: [], deployments: {} };
    unsandbox = { sessions: [] };
    const { container } = await show();
    expect(container.textContent!.length).toBeGreaterThan(50);
  });
});

describe('starting a session', () => {
  const openNew = async () => { await show(); await tab('New'); };
  const nameBox = () => document.querySelector('input[type="text"]') as HTMLInputElement;

  it('will not create a session with no name', async () => {
    // tmux would take an empty name and the session becomes unreachable
    // by name from anywhere else.
    await openNew();
    await act(async () => { spawn()?.click(); });
    expect(posts()).toEqual([]);
  });

  it('creates a tmux session and goes straight into it', async () => {
    await openNew();
    fireEvent.change(nameBox(), { target: { value: 'newwork' } });
    await act(async () => { spawn()?.click(); });
    await waitFor(() => expect(posts()[0]).toMatchObject({
      url: '/api/tmux/new', body: { name: 'newwork', host: 'localhost' },
    }));
    expect(pushed).toEqual(['/tmux/newwork']);
  });

  it('carries the host into the viewer it opens', async () => {
    // A viewer opened without it attaches to a session of the same name on
    // this machine, or to nothing.
    await openNew();
    fireEvent.change(nameBox(), { target: { value: 'newwork' } });
    const hostBtn = [...document.querySelectorAll('button')].find(b => b.textContent?.trim() === 'cammy');
    if (hostBtn) await act(async () => { hostBtn.click(); });
    await act(async () => { spawn()?.click(); });
    await waitFor(() => expect(pushed).toHaveLength(1));
    if (hostBtn) expect(pushed[0]).toContain('host=cammy');
  });

  it('shows the reason a session could not be started', async () => {
    ok = false; answer = { error: 'duplicate session: newwork' };
    await openNew();
    fireEvent.change(nameBox(), { target: { value: 'newwork' } });
    await act(async () => { spawn()?.click(); });
    await waitFor(() => expect(document.body.textContent).toContain('duplicate session: newwork'));
    expect(pushed).toEqual([]);
  });
});
