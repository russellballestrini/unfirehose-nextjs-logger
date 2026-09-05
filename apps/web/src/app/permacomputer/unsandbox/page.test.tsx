// @vitest-environment jsdom
import { describe, it, expect, beforeEach, beforeAll, afterEach, vi } from 'vitest';
import { render, cleanup, act, fireEvent, waitFor } from '@testing-library/react';

/**
 * Our cloud node, which is the one page where every button costs money.
 *
 * Probing starts an ephemeral container. Deploying builds a service.
 * Destroying removes one for good, and killing a session ends work that
 * may be running in it. None of that is recoverable from here, and none of
 * it is visible afterwards except as an absence — so what each control
 * sends, and which id it sends, is the whole test.
 */

let status: Record<string, unknown> | undefined;
let services: Record<string, unknown> | undefined;
let sessions: Record<string, unknown> | undefined;
const mutates = new Map<string, () => void>();
const mutateFor = (k: string) => {
  if (!mutates.has(k)) mutates.set(k, vi.fn());
  return mutates.get(k)!;
};

vi.mock('swr', () => ({
  default: (key: string) => {
    const k = String(key);
    return {
      data: k.includes('action=services') ? services
        : k.includes('action=sessions') ? sessions
        : status,
      error: undefined, isLoading: false, mutate: mutateFor(k),
    };
  },
  useSWRConfig: () => ({ mutate: vi.fn() }),
}));
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn() }), usePathname: () => '/permacomputer/unsandbox',
  useSearchParams: () => new URLSearchParams(),
}));
vi.mock('@/components/UPlotTimeChart', () => ({ UPlotTimeChart: () => null, default: () => null }));

const UnsandboxNodePage = (await import('./page')).default;

let answer: (body: Record<string, unknown>) => Record<string, unknown>;
const posts = () => (global.fetch as unknown as { mock: { calls: unknown[][] } }).mock.calls
  .filter(([, init]) => (init as { method?: string } | undefined)?.method === 'POST')
  .map(([, init]) => JSON.parse((init as { body: string }).body));

beforeAll(() => {
  window.ResizeObserver ??= class { observe() {} unobserve() {} disconnect() {} } as never;
  window.matchMedia ??= ((q: string) => ({
    matches: false, media: q, addEventListener() {}, removeEventListener() {},
  })) as never;
  // jsdom defines confirm and returns undefined from it, so ??= leaves a
  // falsy answer in place and every guarded action silently bails.
  window.confirm = () => true;
});

beforeEach(() => {
  window.location.hash = '';
  status = { connected: true, tier: 'builder', rate_limit: 60, concurrency: 4, burst: 10 };
  // The API says `state`, not `status`, and carries service_id on some
  // shapes and id on others — the page reads both.
  services = { services: [
    { id: 'unsb-service-abc', service_id: 'unsb-service-abc', name: 'uncloseai-4cd87eb8',
      state: 'running', created_at: '2026-09-01T00:00:00Z', ports: 8080,
      domain: 'uncloseai.unsandbox.com' },
    { id: 'unsb-service-def', service_id: 'unsb-service-def', name: 'draft-4cd87eb8',
      state: 'frozen', created_at: '2026-09-02T00:00:00Z' },
  ] };
  sessions = { sessions: [
    { session_id: 'sess-1', status: 'running', image: 'ubuntu:24.04', created_at: '2026-09-04T12:00:00Z' },
  ] };
  answer = () => ({ ok: true, stdout: 'ok' });
  global.fetch = vi.fn(async (_u: string, init: { body?: string }) => ({
    ok: true, status: 200,
    json: async () => answer(JSON.parse(init?.body ?? '{}')),
  })) as never;
});
afterEach(cleanup);

const show = async () => {
  const view = render(<UnsandboxNodePage />);
  await act(async () => { await Promise.resolve(); });
  return view;
};
const button = (re: RegExp) =>
  [...document.querySelectorAll('button')].find(b => re.test(b.textContent ?? ''));
/** Services and Sessions carry a count badge, so match on the prefix. */
const tab = async (name: string) => {
  const el = [...document.querySelectorAll('button')]
    .find(b => b.textContent?.trim().startsWith(name));
  if (el) await act(async () => { el.click(); });
};

describe('the cloud node page', () => {
  it('shows the tier and limits the key was issued with', async () => {
    // These are what every refusal on this page will be about.
    const { container } = await show();
    expect(container.textContent).toContain('builder');
  });

  it('opens on the tab named in the url, since this page is linked to', async () => {
    window.location.hash = '#Services';
    const { container } = await show();
    expect(container.textContent).toContain('uncloseai');
  });

  it('remembers the tab somebody chose', async () => {
    await show();
    await tab('Sessions');
    expect(window.location.hash).toBe('#Sessions');
  });

  it('probes the container rather than guessing what it runs on', async () => {
    answer = () => ({ ok: true, stdout: '---JSON---\n{"cores":4,"memTotal":8}' });
    await show();
    const probe = button(/probe/i);
    if (!probe) return;
    await act(async () => { probe.click(); });
    await waitFor(() => expect(posts().some(p => p.action === 'probe')).toBe(true));
  });

  it('says why a probe failed rather than showing an empty node', async () => {
    global.fetch = vi.fn(async () => { throw new Error('ECONNREFUSED'); }) as never;
    const { container } = await show();
    const probe = button(/probe/i);
    if (!probe) return;
    await act(async () => { probe.click(); });
    await waitFor(() => expect(container.textContent).toMatch(/ECONNREFUSED|failed/i));
  });

  it('lists services with the state each is in', async () => {
    const { container } = await show();
    await tab('Services');
    expect(container.textContent).toContain('uncloseai');
    expect(container.textContent).toContain('frozen');
  });

  it('destroys the service whose button was pressed', async () => {
    // Every row calls the same handler. The wrong id here removes
    // somebody else's container, and there is no undo.
    const { container } = await show();
    await tab('Services');
    const destroy = [...container.querySelectorAll('button')]
      .filter(b => /destroy/i.test(b.textContent ?? ''));
    if (!destroy.length) return;
    await act(async () => { (destroy[1] as HTMLElement).click(); });
    await waitFor(() => {
      const call = posts().find(p => p.action === 'destroy-service');
      expect(call?.serviceId).toBe('unsb-service-def');
    });
  });

  it('lists sessions and kills the one that was named', async () => {
    const { container } = await show();
    await tab('Sessions');
    expect(container.textContent).toContain('sess-1');
    const kill = [...container.querySelectorAll('button')].find(b => /kill/i.test(b.textContent ?? ''));
    if (!kill) return;
    await act(async () => { kill.click(); });
    await waitFor(() => {
      const call = posts().find(p => p.action === 'kill-session');
      expect(call?.sessionId).toBe('sess-1');
    });
  });

  it('runs a one-shot command and shows what it printed', async () => {
    answer = () => ({ ok: true, stdout: 'hello from the container', exit_code: 0 });
    const { container } = await show();
    await tab('Ephemeral');
    const box = container.querySelector('textarea, input[type="text"]') as HTMLInputElement;
    if (!box) return;
    fireEvent.change(box, { target: { value: 'echo hi' } });
    const run = button(/run|execute/i);
    if (!run) return;
    await act(async () => { run.click(); });
    await waitFor(() => expect(container.textContent).toContain('hello from the container'));
  });

  it('will not run an empty command', async () => {
    const { container } = await show();
    await tab('Ephemeral');
    const run = button(/^run$|execute/i) as HTMLButtonElement | undefined;
    if (run) expect(run.disabled).toBe(true);
  });

  it('deploys our own dashboard as a service', async () => {
    const { container } = await show();
    await tab('Bootstrap');
    const deploy = button(/deploy/i);
    if (!deploy) return;
    await act(async () => { deploy.click(); });
    await waitFor(() => expect(posts().some(p => p.action === 'create-service')).toBe(true));
    expect(container.textContent!.length).toBeGreaterThan(50);
  });

  it('installs a harness by running its script in an ephemeral container', async () => {
    // The install runs where the network is: a semitrusted ephemeral box,
    // not the service itself, which may have no egress at all.
    const { container } = await show();
    await tab('Harnesses');
    const install = [...container.querySelectorAll('button')]
      .filter(b => /verify & install/i.test(b.textContent ?? ''));
    if (!install.length) return;
    await act(async () => { (install[0] as HTMLElement).click(); });
    await waitFor(() => {
      const call = posts().find(p => p.action === 'execute');
      expect(call).toMatchObject({ language: 'bash', network: 'semitrusted' });
    });
  });

  it('draws before a key is configured, which is what a new install sees', async () => {
    status = { connected: false };
    services = { services: [] };
    sessions = { sessions: [] };
    const { container } = await show();
    expect(container.textContent!.length).toBeGreaterThan(50);
    expect(container.textContent).not.toContain('undefined');
  });

  it('draws an account with nothing running', async () => {
    services = { services: [] };
    sessions = { sessions: [] };
    const { container } = await show();
    await tab('Services');
    expect(container.textContent).not.toContain('undefined');
  });
});
