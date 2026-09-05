// @vitest-environment jsdom
import { describe, it, expect, beforeEach, beforeAll, afterEach, vi } from 'vitest';
import { Suspense } from 'react';
import { render, screen, cleanup, act, fireEvent, waitFor } from '@testing-library/react';

/**
 * Starting work on a project.
 *
 * Everything on this page is a report except two buttons, and both of them
 * start an agent on a machine. Queue writes a todo. Start Now writes a todo
 * and immediately boots against it, carrying the harness, model and target
 * the dropdowns are set to — which is the part that has no visible
 * confirmation: a boot that quietly went to localhost when the target said
 * a mesh node looks identical from here.
 */

/** Answers keyed by the SWR key that asked, so each hook gets its own. */
let data: Record<string, unknown>;
vi.mock('swr', () => {
  const useSWR = (key: string | null) => {
    const match = key ? Object.keys(data).find(k => String(key).startsWith(k)) : undefined;
    return {
      data: match ? data[match] : undefined,
      error: undefined, isLoading: false, mutate: vi.fn(),
    };
  };
  return { default: useSWR, useSWRConfig: () => ({ mutate: vi.fn() }), mutate: vi.fn() };
});

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
  useParams: () => ({ project: 'demo' }),
  usePathname: () => '/projects/demo',
  useSearchParams: () => new URLSearchParams(),
}));
vi.mock('@/components/UPlotTimeChart', () => ({ UPlotTimeChart: () => null, default: () => null }));

const ProjectPage = (await import('./page')).default;

/** Every POST the page made, as path plus parsed body. */
const posts = () => (global.fetch as unknown as { mock: { calls: unknown[][] } }).mock.calls
  .filter(([, init]) => (init as { method?: string } | undefined)?.method === 'POST')
  .map(([url, init]) => ({
    url: String(url),
    body: JSON.parse((init as { body: string }).body),
  }));

let bootAnswer: Record<string, unknown>;

beforeAll(() => {
  window.ResizeObserver ??= class { observe() {} unobserve() {} disconnect() {} } as never;
  window.scrollTo ??= vi.fn() as never;
  Object.defineProperty(HTMLElement.prototype, 'offsetWidth', { configurable: true, value: 1024 });
  Object.defineProperty(HTMLElement.prototype, 'offsetHeight', { configurable: true, value: 400 });
});

beforeEach(() => {
  bootAnswer = { success: true, command: 'tmux attach -t demo', tmuxSession: 'demo', host: 'localhost' };
  data = {
    '/api/projects/demo': { originalPath: '/home/fox/git/demo', sessions: [] },
    '/api/mesh': { nodes: [{ hostname: 'cammy', reachable: true }, { hostname: 'guile', reachable: false }] },
    '/api/unsandbox': { connected: true, tier: 'builder' },
    '/api/harness/models': { models: [{ id: 'claude-opus-5', label: 'Opus 5' }] },
  };
  global.fetch = vi.fn(async (url: string) => ({
    ok: true, status: 200,
    json: async () => (String(url).startsWith('/api/boot') ? bootAnswer : { id: 77 }),
    text: async () => '',
  })) as never;
});
afterEach(cleanup);

/**
 * `use(params)` suspends until the promise settles, and a page has no
 * boundary of its own — Next provides one. Without it React renders
 * nothing and every query below finds an empty document.
 */
/**
 * A promise React's `use` can read synchronously.
 *
 * A bare resolved promise still suspends on first render, and a page has
 * no Suspense boundary of its own — Next supplies one. Tagging it the way
 * React tags a settled thenable lets the body run on the first pass, which
 * is what every query below needs.
 */
const settled = <T,>(value: T) =>
  Object.assign(Promise.resolve(value), { status: 'fulfilled', value }) as Promise<T>;

const show = async () => {
  const view = render(
    <Suspense fallback={null}>
      <ProjectPage params={settled({ project: 'demo' })} />
    </Suspense>,
  );
  await act(async () => { await new Promise(r => setTimeout(r, 0)); });
  await act(async () => { await new Promise(r => setTimeout(r, 0)); });
  return view;
};

const button = (label: string) =>
  [...document.querySelectorAll('button')].find(b => b.textContent?.trim() === label);

const typeTask = (text: string) => {
  const box = document.querySelector('textarea[placeholder^="What should the agent"]') as HTMLTextAreaElement;
  fireEvent.change(box, { target: { value: text } });
  return box;
};

describe('starting work', () => {
  it('queues a task without booting anything', async () => {
    // Queue is the button for work you are not starting now. Booting here
    // would run an agent nobody asked to run.
    await show();
    typeTask('fix the gauge thresholds');
    await act(async () => { button('Queue')!.click(); });

    await waitFor(() => expect(posts()[0]).toMatchObject({
      url: '/api/todos',
      body: { content: 'fix the gauge thresholds', projectName: 'demo', source: 'manual', status: 'pending' },
    }));
    expect(posts().some(p => p.url.startsWith('/api/boot'))).toBe(false);
  });

  it('starts a task now, and marks it in progress at the same moment', async () => {
    // Anything else leaves a pending todo with an agent already on it.
    await show();
    typeTask('fix the gauge thresholds');
    await act(async () => { button('Start Now')!.click(); });

    await waitFor(() => expect(posts()).toHaveLength(2));
    expect(posts()[0].body.status).toBe('in_progress');
    expect(posts()[1]).toMatchObject({
      url: '/api/boot',
      body: { projectPath: '/home/fox/git/demo', prompt: 'fix the gauge thresholds', todoIds: [77], yolo: true },
    });
  });

  it('will not submit an empty task', async () => {
    await show();
    expect(button('Queue')!.disabled).toBe(true);
    typeTask('   ');
    expect(button('Queue')!.disabled).toBe(true);
  });

  it('boots a bare session with no task attached', async () => {
    await show();
    await act(async () => { button('Boot Session')!.click(); });
    await waitFor(() => expect(posts()[0]).toMatchObject({
      url: '/api/boot', body: { projectPath: '/home/fox/git/demo', projectName: 'demo' },
    }));
    expect(posts()[0].body.prompt).toBeUndefined();
  });

  it('shows the command to attach to what it just started', async () => {
    // The session is on a machine, in a multiplexer. Without this line
    // there is no way back to it from here.
    await show();
    await act(async () => { button('Boot Session')!.click(); });
    await waitFor(() => expect(screen.getByText(/tmux attach -t demo/)).toBeInTheDocument());
  });

  it('reports a refused boot with the reason, not just a failure', async () => {
    bootAnswer = { success: false, error: 'Unknown host: typo-node', detail: 'Known nodes: cammy' };
    await show();
    await act(async () => { button('Boot Session')!.click(); });
    await waitFor(() => expect(screen.getByText(/Unknown host: typo-node — Known nodes: cammy/)).toBeInTheDocument());
  });

  it('refuses to boot before it knows where the project is', async () => {
    // Booting without a path creates a session in whatever directory the
    // server happened to be in.
    data['/api/projects/demo'] = { sessions: [] };
    await show();
    await act(async () => { button('Boot Session')!.click(); });
    expect(posts()).toEqual([]);
    await waitFor(() => expect(screen.getByText(/No project path found/)).toBeInTheDocument());
  });

  it('sends the boot to the node the target names', async () => {
    // Silently running on localhost when the dropdown says a mesh node is
    // indistinguishable from here and wrong everywhere else.
    await show();
    const targetSelect = [...document.querySelectorAll('select')]
      .find(s => [...s.options].some(o => o.value === 'cammy'))!;
    fireEvent.change(targetSelect, { target: { value: 'cammy' } });
    await act(async () => { button('Boot Session')!.click(); });
    await waitFor(() => expect(posts()[0].body.host).toBe('cammy'));
  });

  it('does not name a host when booting here', async () => {
    await show();
    await act(async () => { button('Boot Session')!.click(); });
    await waitFor(() => expect(posts()).toHaveLength(1));
    expect(posts()[0].body.host).toBeUndefined();
  });

  it('carries the yolo setting rather than assuming it', async () => {
    await show();
    const yoloBox = document.querySelector('input[type="checkbox"]') as HTMLInputElement;
    fireEvent.click(yoloBox);
    await act(async () => { button('Boot Session')!.click(); });
    await waitFor(() => expect(posts()[0].body.yolo).toBe(false));
  });
});
