// @vitest-environment jsdom
import { describe, it, expect, beforeEach, beforeAll, afterEach, vi } from 'vitest';
import { Suspense } from 'react';
import { render, cleanup, act, fireEvent, waitFor } from '@testing-library/react';

/**
 * Shared pages with the unsandbox integration on, and the same pages off.
 *
 * On, each page shows what it showed before the integration had a switch:
 * the account as a node on /permacomputer with its keys panel, a boot target
 * on a project page, its own page at /permacomputer/unsandbox. Off, none of
 * it renders and none of its endpoints are asked for.
 */

let on = true;
let data: Record<string, unknown>;
const asked: string[] = [];

vi.mock('swr', () => {
  const useSWR = (key: string | null) => {
    if (key) asked.push(String(key));
    const k = key == null ? undefined : String(key);
    const value = k === undefined ? undefined
      : k === '/api/integrations'
        ? { integrations: [{ id: 'unsandbox', name: 'unsandbox.com', summary: '', enabled: on, source: on ? 'setting' : 'default' }] }
        : k in data ? data[k]
        : data[Object.keys(data).find(p => k.startsWith(p)) ?? ''];
    return { data: value, error: undefined, isLoading: false, mutate: vi.fn() };
  };
  return { default: useSWR, useSWRConfig: () => ({ mutate: vi.fn() }), mutate: vi.fn() };
});
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
  useParams: () => ({ project: 'demo' }),
  usePathname: () => '/', useSearchParams: () => new URLSearchParams(),
}));
vi.mock('@/components/UPlotTimeChart', () => ({ UPlotTimeChart: () => null, default: () => null }));

const MeshPage = (await import('@/app/permacomputer/page')).default;
const ProjectPage = (await import('@/app/projects/[project]/page')).default;
const NodeRoute = (await import('@/app/permacomputer/unsandbox/page')).default;

const settled = <T,>(value: T) =>
  Object.assign(Promise.resolve(value), { status: 'fulfilled', value }) as Promise<T>;
const flush = async () => {
  await act(async () => { await new Promise(r => setTimeout(r, 0)); });
  await act(async () => { await new Promise(r => setTimeout(r, 0)); });
};
const fetched = () => (global.fetch as unknown as { mock: { calls: unknown[][] } }).mock.calls.map(([u]) => String(u));
const unsandboxCalls = () => [...asked, ...fetched()].filter(u => u.startsWith('/api/unsandbox') || u === 'unsandbox-probe');

beforeAll(() => {
  window.ResizeObserver ??= class { observe() {} unobserve() {} disconnect() {} } as never;
  window.scrollTo ??= vi.fn() as never;
  Object.defineProperty(HTMLElement.prototype, 'offsetWidth', { configurable: true, value: 1024 });
  Object.defineProperty(HTMLElement.prototype, 'offsetHeight', { configurable: true, value: 400 });
});
beforeEach(() => {
  on = true; asked.length = 0;
  data = {
    '/api/mesh': { nodes: [{ hostname: 'cammy', reachable: true }], summary: { totalNodes: 1, reachableNodes: 1 } },
    '/api/ssh-config': { hosts: [], keys: [] },
    '/api/settings': {},
    '/api/unsandbox?action=services': { services: [{ name: 'unfirehose', status: 'running' }] },
    '/api/unsandbox': { connected: true, tier: 3, rateLimit: 21, maxSessions: 1 },
    '/api/projects/demo': { originalPath: '/home/fox/git/demo', sessions: [] },
    '/api/projects/metadata': { remotes: [{ name: 'origin', type: 'fetch', url: 'https://git.example/fox/demo.git' }] },
  };
  global.fetch = vi.fn(async () => ({
    ok: true, status: 200, json: async () => ({ success: true, command: 'unsandbox session s1', host: 'unsandbox' }),
    text: async () => '',
  })) as never;
});
afterEach(cleanup);

describe('/permacomputer', () => {
  it('on: shows the account as a node, counts it, and shows its keys panel', async () => {
    const { container } = render(<MeshPage />);
    await flush();
    expect(container.textContent).toContain('unsandbox');
    expect(container.textContent).toContain('tier 3');
    expect(container.textContent).toContain('unsandbox.com');
    expect(container.querySelector('a[href="/permacomputer/unsandbox"]')).not.toBeNull();
  });

  it('off: renders without it and asks it nothing', async () => {
    on = false;
    const { container } = render(<MeshPage />);
    await flush();
    expect(container.textContent).toContain('Permacomputer');
    expect(container.textContent).not.toMatch(/unsandbox/i);
    expect(unsandboxCalls()).toEqual([]);
  });
});

describe('a project page', () => {
  const show = async () => {
    const view = render(
      <Suspense fallback={null}><ProjectPage params={settled({ project: 'demo' })} /></Suspense>,
    );
    await flush();
    return view;
  };
  const targetSelect = () => [...document.querySelectorAll('select')]
    .find(s => [...s.options].some(o => o.value === 'cammy'))!;

  it('on: offers a connected account as a boot target, which clones the remote', async () => {
    await show();
    expect([...targetSelect().options].map(o => o.value)).toContain('unsandbox');
    fireEvent.change(targetSelect(), { target: { value: 'unsandbox' } });
    const boot = [...document.querySelectorAll('button')].find(b => b.textContent?.trim() === 'Boot Session')!;
    await act(async () => { boot.click(); });
    await waitFor(() => {
      const sent = (global.fetch as unknown as { mock: { calls: unknown[][] } }).mock.calls
        .find(([u]) => String(u) === '/api/boot');
      expect(JSON.parse((sent![1] as { body: string }).body)).toMatchObject({
        host: 'unsandbox', repoUrl: 'https://git.example/fox/demo.git',
      });
    });
  });

  it('off: offers no such target and asks nothing', async () => {
    on = false;
    await show();
    expect([...targetSelect().options].map(o => o.value)).not.toContain('unsandbox');
    expect(unsandboxCalls()).toEqual([]);
  });
});

describe('/permacomputer/unsandbox', () => {
  it('on: is the integration page', async () => {
    const { container } = render(<NodeRoute />);
    await flush();
    expect(container.textContent).not.toMatch(/integration is off/);
    expect(container.textContent).toMatch(/unsandbox/i);
  });

  it('off: says the integration is off and where to turn it on', async () => {
    on = false;
    const { container } = render(<NodeRoute />);
    await flush();
    expect(container.textContent).toMatch(/integration is off/);
    expect(container.querySelector('a[href="/settings#Integrations"]')).not.toBeNull();
    expect(unsandboxCalls()).toEqual([]);
  });
});
