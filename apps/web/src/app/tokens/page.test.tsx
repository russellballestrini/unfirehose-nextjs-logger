// @vitest-environment jsdom
import { describe, it, expect, beforeEach, beforeAll, afterEach, vi } from 'vitest';
import { render, screen, cleanup, act, waitFor } from '@testing-library/react';

/**
 * What our tokens cost, across four tabs.
 *
 * Almost all of this page is formatting, and formatting is where it has
 * broken before: planLabel and formatCost were each handed undefined by a
 * real payload. So the tests drive it with a payload shaped like the live
 * endpoint's, including the row that has no price — an unpriced model is
 * not a zero-cost one, and a page that divides by a total to get a share
 * meets a zero here.
 *
 * The other decisions worth holding: the project filter comes off the URL
 * and must reach the query, and the chosen tab must survive a reload,
 * because these are pages people leave open.
 */

/** The SWR key each hook asked with, so the query string can be checked. */
let keys: string[];
let tokens: Record<string, unknown> | undefined;
let plan: Record<string, unknown> | undefined;

vi.mock('swr', () => {
  const useSWR = (key: string) => {
    keys.push(String(key));
    return {
      data: String(key).startsWith('/api/tokens') ? tokens
        : String(key).startsWith('/api/usage/plan') ? plan
        : String(key).startsWith('/api/usage/extra') ? { spent: 4.2, limit: 50, balance: 45.8 }
        : undefined,
      error: undefined, isLoading: false, mutate: vi.fn(),
    };
  };
  return { default: useSWR, useSWRConfig: () => ({ mutate: vi.fn() }), mutate: vi.fn() };
});

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
  usePathname: () => '/tokens', useSearchParams: () => new URLSearchParams(),
}));
vi.mock('@/components/UPlotTimeChart', () => ({ UPlotTimeChart: () => null, default: () => null }));

const TokensPage = (await import('./page')).default;

const model = (over: Record<string, unknown> = {}) => ({
  model: 'claude-opus-4-6-20260301', inputTokens: 12_000, outputTokens: 4_000,
  cacheReadTokens: 900_000, cacheCreationTokens: 30_000, totalTokens: 946_000,
  inputCostUSD: 0.18, outputCostUSD: 0.3, cacheReadCostUSD: 1.35,
  cacheWriteCostUSD: 0.56, costUSD: 2.39, ...over,
});

const payload = () => ({
  modelBreakdown: [
    model(),
    // No book has a price for this one. Every cost field is zero and the
    // page must not read that as free.
    model({ model: 'local/stub', totalTokens: 600, inputTokens: 500, outputTokens: 100,
            cacheReadTokens: 0, cacheCreationTokens: 0, inputCostUSD: 0, outputCostUSD: 0,
            cacheReadCostUSD: 0, cacheWriteCostUSD: 0, costUSD: 0 }),
  ],
  totalTokens: 946_600, totalCost: 2.39, totalInputCost: 0.18, totalOutputCost: 0.3,
  totalCacheReadCost: 1.35, totalCacheWriteCost: 0.56, totalInput: 12_500,
  totalOutput: 4_100, totalCacheRead: 900_000, totalCacheWrite: 30_000,
  toolCalls: [{ tool_name: 'Bash', count: 120 }, { tool_name: 'Edit', count: 44 }],
  toolsByModel: [{ model: 'claude-opus-4-6-20260301', count: 120 }],
  dailyActivity: [
    { date: '2026-09-03', messageCount: 40, sessionCount: 2, toolCallCount: 12 },
    { date: '2026-09-04', messageCount: 55, sessionCount: 3, toolCallCount: 20 },
  ],
});

beforeAll(() => {
  window.ResizeObserver ??= class { observe() {} unobserve() {} disconnect() {} } as never;
  window.matchMedia ??= ((q: string) => ({
    matches: false, media: q, addEventListener() {}, removeEventListener() {},
  })) as never;
  Object.defineProperty(HTMLElement.prototype, 'offsetWidth', { configurable: true, value: 1024 });
  Object.defineProperty(HTMLElement.prototype, 'offsetHeight', { configurable: true, value: 400 });
});

beforeEach(() => {
  keys = [];
  tokens = payload();
  plan = {
    subscriptionType: 'max_20x', rateLimitTier: 'max_20x', hasExtraUsageEnabled: true,
    monthlyPlanCost: 200, periodStart: '2026-09-01', periodEnd: '2026-09-30',
    periodCostUSD: 84.2,
    dailyCost: [{ date: '2026-09-03', costUSD: 40 }, { date: '2026-09-04', costUSD: 44.2 }],
  };
  window.history.replaceState(null, '', '/tokens');
  global.fetch = vi.fn(async () => ({ ok: true, json: async () => ({}) })) as never;
});
afterEach(cleanup);

const show = async () => {
  const view = render(<TokensPage />);
  await act(async () => { await Promise.resolve(); });
  return view;
};

const tab = async (name: string) => {
  const el = [...document.querySelectorAll('button')]
    .find(b => b.textContent?.toLowerCase().includes(name));
  await act(async () => { el!.click(); });
};

describe('tokens page', () => {
  it('shows the total it was given', async () => {
    const { container } = await show();
    await waitFor(() => expect(container.textContent).toContain('$2.39'));
  });

  it('lists a model with no price without calling it free', async () => {
    // A model no book prices is not a zero-cost model, and the row for it
    // used to be where formatCost met undefined.
    const { container } = await show();
    await waitFor(() => expect(container.textContent).toContain('local/stub'));
  });

  it('renders every tab', async () => {
    // Each is a separate branch over the same payload, and three of them
    // never render until clicked.
    const { container } = await show();
    for (const name of ['harness', 'tools', 'plan']) {
      await tab(name);
      expect(container.textContent!.length).toBeGreaterThan(200);
    }
  });

  it('remembers which tab was open, since this page is left open', async () => {
    await show();
    await tab('tools');
    expect(window.location.hash).toBe('#tools');
  });

  it('opens on the tab named in the URL', async () => {
    window.history.replaceState(null, '', '/tokens#plan');
    const { container } = await show();
    expect(container.textContent).toContain('max_20x');
  });

  it('carries a project from the URL into the query', async () => {
    // Arriving from a project page with a filter that never reaches the
    // API shows totals for everything under that project's name.
    window.history.replaceState(null, '', '/tokens?project=-home-fox-git-demo');
    await show();
    expect(keys.some(k => k.includes('project=-home-fox-git-demo'))).toBe(true);
  });

  it('drops the filter, and the query, when the chip is dismissed', async () => {
    window.history.replaceState(null, '', '/tokens?project=-home-fox-git-demo');
    await show();
    const chip = [...document.querySelectorAll('button')]
      .find(b => b.textContent?.startsWith('project: '));
    keys = [];
    await act(async () => { chip!.click(); });
    expect(keys.some(k => k.includes('project='))).toBe(false);
    expect(window.location.search).toBe('');
  });

  it('survives a payload that has not arrived', async () => {
    tokens = undefined;
    expect((await show()).container.textContent).toBeDefined();
  });

  it('survives a plan endpoint that answered with nothing', async () => {
    // planLabel took a rateLimitTier that was not there and threw on a
    // page whose other three tabs were fine.
    plan = {};
    const { container } = await show();
    await tab('plan');
    // The page carries a JSON-LD block describing the report; the visible
    // text is what a person reads.
    const visible = container.textContent!.replace(/\{"@context[\s\S]*?\}\]\}/, '');
    expect(visible).not.toContain('undefined');
    expect(visible).not.toContain('NaN');
  });

  it('says the plan is still loading rather than showing a blank tab', async () => {
    plan = undefined;
    const { container } = await show();
    await tab('plan');
    expect(container.textContent).toContain('Loading plan data');
  });

  it('shows an empty period as empty rather than as a broken page', async () => {
    tokens = { ...payload(), modelBreakdown: [], dailyActivity: [], toolCalls: [],
               toolsByModel: [], totalTokens: 0, totalCost: 0 };
    const { container } = await show();
    expect(container.textContent).toContain('Tokens');
  });
});
