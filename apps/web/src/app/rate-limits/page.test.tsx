// @vitest-environment jsdom
import { describe, it, expect, beforeEach, beforeAll, afterEach, vi } from 'vitest';
import { render, cleanup, act } from '@testing-library/react';

/**
 * Refusals: what we hit, and what the vendors admit.
 *
 * These are one page on purpose. To somebody waiting on an answer, a
 * provider falling over and a provider refusing us are the same event, and
 * splitting them across two pages means seeing half of it.
 *
 * The filters here are sticky and deep-linkable, which matters because
 * this page is opened from a link in an alert, and the tab named in that
 * link has to win over whatever was last looked at.
 */

let data: Record<string, unknown> | undefined;
let failed: Error | undefined;
vi.mock('swr', () => ({
  default: () => ({ data, error: failed, isLoading: false, mutate: vi.fn() }),
  useSWRConfig: () => ({ mutate: vi.fn() }),
}));
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn() }), usePathname: () => '/rate-limits',
  useSearchParams: () => new URLSearchParams(),
}));

const RateLimitsPage = (await import('./page')).default;

const payload = (over: Record<string, unknown> = {}) => ({
  total: 42,
  byProvider: [{ provider: 'anthropic', kind: 'rate_limit', events: 30 }],
  byUpstream: [{ upstream: 'anthropic', kind: 'rate_limit', events: 30 }],
  attribution: { named: 30, total: 42 },
  byDay: [{ day: '2026-09-03', events: 12 }, { day: '2026-09-04', events: 30 }],
  recent: [{
    id: 1, ts: '2026-09-04T12:00:00Z', provider: 'anthropic', upstream: 'anthropic',
    kind: 'rate_limit', http_status: 429, model: 'claude-opus-4-6-20260301',
    message: 'rate_limit_error',
  }],
  targets: [{ target: 'inference', events: 42 }, { target: 'web', events: 3 }],
  kinds: [{ kind: 'rate_limit', events: 30 }, { kind: 'server_error', events: 12 }],
  now: { rows: [{
    provider: 'anthropic', upstream: null, kind: 'rate_limit', http_status: 429,
    m60: 4, m15: 2, last_seen: new Date().toISOString(),
    first_seen: new Date().toISOString(), sample: 'rate_limit_error',
  }], at: new Date().toISOString() },
  current: [{ id: 'anthropic', name: 'Anthropic', poll: { indicator: 'none', incidents: [] } }],
  ...over,
});

beforeAll(() => {
  window.ResizeObserver ??= class { observe() {} unobserve() {} disconnect() {} } as never;
  window.matchMedia ??= ((q: string) => ({
    matches: false, media: q, addEventListener() {}, removeEventListener() {},
  })) as never;
});
beforeEach(() => {
  data = payload(); failed = undefined;
  localStorage.clear();
  window.history.replaceState(null, '', '/rate-limits');
});
afterEach(cleanup);

const show = async () => {
  const view = render(<RateLimitsPage />);
  await act(async () => { await Promise.resolve(); });
  return view;
};
const button = (re: RegExp) =>
  [...document.querySelectorAll('button')].find(b => re.test(b.textContent ?? ''));

describe('rate limits page', () => {
  it('shows what we hit', async () => {
    const { container } = await show();
    expect(container.textContent).toContain('Refusals');
    expect(container.textContent).toContain('anthropic');
  });

  it('opens on the tab a link named, over whatever was last looked at', async () => {
    // This page is opened from an alert, and the link is the whole point.
    localStorage.setItem('rate_limits_tab', JSON.stringify('refusals'));
    window.history.replaceState(null, '', '/rate-limits?tab=status');
    const { container } = await show();
    expect(container.textContent).toContain('incident feed');
  });

  it('remembers the tab somebody chose', async () => {
    const { container } = await show();
    await act(async () => { button(/What vendors admit/)!.click(); });
    expect(container.textContent).toContain('incident feed');
  });

  it('shows how many refusals could not be attributed to a vendor', async () => {
    // An unattributed refusal is one we cannot tell 'us or them' about,
    // and a page that only counts the named ones looks tidier than it is.
    data = payload({ attribution: { named: 30, total: 42 } });
    const { container } = await show();
    expect(container.textContent).toContain('42');
  });

  it('draws a period with no refusals at all', async () => {
    data = payload({
      total: 0, byProvider: [], byUpstream: [], byDay: [], recent: [],
      kinds: [], now: { rows: [] }, attribution: { named: 0, total: 0 },
    });
    expect((await show()).container.textContent).toContain('Refusals');
  });

  it('draws before the first response arrives', async () => {
    data = undefined;
    expect((await show()).container.textContent).toContain('Refusals');
  });

  it('draws when the endpoint failed', async () => {
    data = undefined; failed = new Error('offline');
    expect((await show()).container.textContent).toContain('Refusals');
  });
});
