// @vitest-environment jsdom
import { describe, it, expect, beforeEach, beforeAll, afterEach, vi } from 'vitest';
import { render, cleanup, act, waitFor } from '@testing-library/react';

/**
 * /tmux with the unsandbox integration on.
 *
 * Two kinds of session live on the page then, and they are not
 * interchangeable: a tmux session on a machine we can ssh to, and an
 * unsandbox container that costs money and disappears. Launching one sends
 * someone straight into it, so the viewer it opens has to carry the host.
 */

let unsandbox: unknown;
const pushed: string[] = [];

vi.mock('swr', () => ({
  default: (key: string) => ({
    data: String(key).startsWith('/api/tmux/stream') ? { sessions: ['demo'], deployments: {} }
      : String(key).startsWith('/api/unsandbox') ? unsandbox
      : String(key) === '/api/integrations' ? { integrations: [{ id: 'unsandbox', enabled: true, source: 'setting' }] }
      : String(key).startsWith('/api/sessions/nickname') ? {}
      : String(key).startsWith('/api/projects') ? []
      : undefined,
    error: undefined, isLoading: false, mutate: vi.fn(),
  }),
  useSWRConfig: () => ({ mutate: vi.fn() }),
}));
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: (u: string) => { pushed.push(u); } }),
  usePathname: () => '/tmux', useSearchParams: () => new URLSearchParams(),
}));

const TmuxListPage = (await import('@/app/tmux/page')).default;

beforeAll(() => {
  window.ResizeObserver ??= class { observe() {} unobserve() {} disconnect() {} } as never;
});
beforeEach(() => {
  pushed.length = 0;
  unsandbox = { sessions: [{ session_id: 'unsb-1', status: 'running', image: 'ubuntu:24.04' }] };
  global.fetch = vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ ok: true, session_id: 'unsb-abc' }) })) as never;
});
afterEach(cleanup);

const show = async () => {
  const view = render(<TmuxListPage />);
  await act(async () => { await Promise.resolve(); });
  return view;
};
const button = (re: RegExp) => [...document.querySelectorAll('button')].find(b => re.test(b.textContent ?? ''));

describe('/tmux with unsandbox on', () => {
  it('lists both kinds of session', async () => {
    const { container } = await show();
    expect(container.textContent).toContain('demo');
    expect(container.textContent).toContain('unsb-1');
    expect(container.textContent).toContain('tmux sessions and unsandbox containers.');
  });

  it('offers to launch one when there are none', async () => {
    unsandbox = { sessions: [] };
    const { container } = await show();
    expect(container.textContent).toContain('No unsandbox sessions.');
    await act(async () => { button(/Launch one/)!.click(); });
    expect(document.body.textContent).toContain('Launch unsandbox container');
  });

  it('launches a container and opens it with its host', async () => {
    await show();
    await act(async () => { button(/^\+\s*New$/)!.click(); });
    await act(async () => { button(/unsandbox/)!.click(); });
    await act(async () => { button(/Launch unsandbox container/)!.click(); });
    await waitFor(() => expect(pushed).toEqual(['/tmux/unsb-abc?host=unsandbox']));
  });
});
