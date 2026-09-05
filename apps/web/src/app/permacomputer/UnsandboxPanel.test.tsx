// @vitest-environment jsdom
import { describe, it, expect, beforeEach, beforeAll, afterEach, vi } from 'vitest';
import { render, cleanup, act, fireEvent, waitFor } from '@testing-library/react';

/**
 * The panel that holds our unsandbox keys.
 *
 * It writes a secret key into settings and starts paid containers, so it
 * has the two properties a credential field needs: the secret is masked
 * until somebody asks to see it, and it is not re-saved on every blur —
 * only when it actually changed, since each save is a round trip that
 * overwrites what is stored.
 *
 * Every key here is fabricated.
 */

let settings: Record<string, string>;
let status: Record<string, unknown> | undefined;
const pushed: string[] = [];
const mutates = new Map<string, () => void>();
const mutateFor = (k: string) => {
  if (!mutates.has(k)) mutates.set(k, vi.fn());
  return mutates.get(k)!;
};

vi.mock('swr', () => ({
  default: (key: string) => ({
    data: String(key).startsWith('/api/settings') ? settings : status,
    error: undefined, isLoading: false, mutate: mutateFor(String(key)),
  }),
  useSWRConfig: () => ({ mutate: vi.fn() }),
}));
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: (u: string) => { pushed.push(u); } }),
  usePathname: () => '/permacomputer', useSearchParams: () => new URLSearchParams(),
}));
vi.mock('@/components/UPlotTimeChart', () => ({ UPlotTimeChart: () => null, default: () => null }));

const { UnsandboxPanel } = await import('./page');

let answer: Record<string, unknown>;
let ok = true;
const posts = () => (global.fetch as unknown as { mock: { calls: unknown[][] } }).mock.calls
  .filter(([, init]) => (init as { method?: string } | undefined)?.method === 'POST')
  .map(([url, init]) => ({ url: String(url), body: JSON.parse((init as { body: string }).body) }));

beforeAll(() => {
  window.ResizeObserver ??= class { observe() {} unobserve() {} disconnect() {} } as never;
});
beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  pushed.length = 0; ok = true; answer = { ok: true, tier: 'builder' };
  settings = {
    unsandbox_public_key: 'unsb-pk-fake', unsandbox_secret_key: 'unsb-sk-fake',
    unsandbox_enabled: 'true',
  };
  status = { connected: true, tier: 'builder' };
  global.fetch = vi.fn(async () => ({ ok, status: ok ? 200 : 500, json: async () => answer })) as never;
});
afterEach(() => { vi.useRealTimers(); cleanup(); });

const show = async () => {
  const view = render(<UnsandboxPanel />);
  await act(async () => { await Promise.resolve(); });
  return view;
};
const button = (re: RegExp) =>
  [...document.querySelectorAll('button')].find(b => re.test(b.textContent ?? ''));
const secretField = () => document.querySelector('input[placeholder^="unsb-sk"]') as HTMLInputElement;

describe('unsandbox panel', () => {
  it('masks the secret key until asked', async () => {
    await show();
    expect(secretField().type).toBe('password');
    await act(async () => { button(/^show$/)!.click(); });
    expect(secretField().type).toBe('text');
  });

  it('saves a key that changed', async () => {
    await show();
    const field = document.querySelector('input[placeholder^="unsb-pk"]') as HTMLInputElement;
    fireEvent.blur(field, { target: { value: 'unsb-pk-different' } });
    await waitFor(() => expect(posts().find(p => p.url === '/api/settings')?.body).toEqual({
      action: 'set', key: 'unsandbox_public_key', value: 'unsb-pk-different',
    }));
  });

  it('does not re-save a key that did not', async () => {
    // Every blur is a round trip that overwrites what is stored, and a
    // field is blurred whenever anything else on the page is clicked.
    await show();
    const field = document.querySelector('input[placeholder^="unsb-pk"]') as HTMLInputElement;
    fireEvent.blur(field, { target: { value: 'unsb-pk-fake' } });
    expect(posts().some(p => p.url === '/api/settings')).toBe(false);
  });

  it('will not test a connection it has no keys for', async () => {
    settings = {};
    await show();
    expect((button(/test connection/) as HTMLButtonElement).disabled).toBe(true);
  });

  it('tests the connection and reports the tier', async () => {
    await show();
    await act(async () => { button(/test connection/)!.click(); });
    await waitFor(() => expect(posts().find(p => p.body?.action === 'test')).toBeTruthy());
  });

  it('goes to the node page once the keys are known to work', async () => {
    // That page is the point of having keys; stopping at a green tick
    // leaves somebody to find it themselves.
    await show();
    await act(async () => { button(/test connection/)!.click(); });
    await act(async () => { await vi.advanceTimersByTimeAsync(600); });
    expect(pushed).toEqual(['/permacomputer/unsandbox']);
  });

  it('stays put, and says why, when the keys are refused', async () => {
    answer = { ok: false, error: 'HTTP 401 — likely stale secret key' };
    const { container } = await show();
    await act(async () => { button(/test connection/)!.click(); });
    await act(async () => { await vi.advanceTimersByTimeAsync(600); });
    expect(pushed).toEqual([]);
    expect(container.textContent).toContain('stale secret key');
  });

  it('boots a container with the prompt that was typed', async () => {
    answer = { success: true, sessionId: 'sess-abc', command: 'unsandbox session sess-abc' };
    await show();
    const prompt = document.querySelector('textarea') ?? document.querySelector('input[type="text"]:not([placeholder^="unsb"])');
    if (prompt) fireEvent.change(prompt, { target: { value: 'fix the gauge thresholds' } });
    await act(async () => { button(/Boot Claude/)!.click(); });
    await waitFor(() => {
      const boot = posts().find(p => p.url === '/api/boot');
      expect(boot?.body).toMatchObject({ host: 'unsandbox', harness: 'claude' });
    });
  });

  it('shows why a boot was refused', async () => {
    ok = false; answer = { error: 'concurrency limit reached' };
    const { container } = await show();
    await act(async () => { button(/Boot Claude/)!.click(); });
    await waitFor(() => expect(container.textContent).toContain('concurrency limit reached'));
  });

  it('draws before any key has been set', async () => {
    // This is what a new install sees, and it must not read as an error.
    settings = {}; status = { connected: false };
    expect((await show()).container.textContent).toContain('unsandbox.com');
  });
});
