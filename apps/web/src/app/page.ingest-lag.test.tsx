// @vitest-environment jsdom
import { describe, it, expect, beforeEach, beforeAll, afterEach, vi } from 'vitest';
import { render, cleanup, act } from '@testing-library/react';

/**
 * The dashboard saying how old it is.
 *
 * On 2026-09-05 a session ran at 01:11 and was not ingested until 11:16.
 * The dashboard was correct the whole time and showed nothing, because
 * there was nothing — and there was no way to tell that from a quiet
 * night. This is that way.
 */

let payload: Record<string, unknown> | undefined;
vi.mock('swr', () => ({
  default: () => ({ data: payload, error: undefined, isLoading: false, mutate: vi.fn() }),
  useSWRConfig: () => ({ mutate: vi.fn() }),
}));
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn() }), usePathname: () => '/',
  useSearchParams: () => new URLSearchParams(),
}));
vi.mock('@/components/UPlotTimeChart', () => ({ UPlotTimeChart: () => null, default: () => null }));

const DashboardPage = (await import('./page')).default;

const dash = (over: Record<string, unknown> = {}) => ({
  range: '7d',
  summary: {
    sessions: 12, messages: 480, models: 3, totalCost: 4.57, totalTokens: 1_533_740,
    inputTokens: 175_358, outputTokens: 20_364, cacheReadTokens: 1_338_018,
    cacheWriteTokens: 0, cacheHitRate: 0.87, cacheCost: 1.2,
    costSplit: { input: 1.75, output: 1.02, cacheRead: 1.8, cacheWrite: 0 },
    since: '2026-09-01',
  },
  modelBreakdown: [{
    model: 'openai/gpt-6-astra', inputTokens: 175_358, outputTokens: 20_364,
    cacheReadTokens: 1_338_018, cacheCreationTokens: 0, totalTokens: 1_533_740,
    costUSD: 4.57, selfHosted: false, host: null,
  }],
  dailyActivity: [], hourCounts: [], dayOfWeekCounts: [], dowHourHeatmap: [],
  projectBreakdown: [], lifetime: null, streaks: { current: 1, longest: 2 },
  ...over,
});

beforeAll(() => {
  window.ResizeObserver ??= class { observe() {} unobserve() {} disconnect() {} } as never;
  window.matchMedia ??= ((q: string) => ({
    matches: false, media: q, addEventListener() {}, removeEventListener() {},
  })) as never;
  Object.defineProperty(HTMLElement.prototype, 'offsetWidth', { configurable: true, value: 1024 });
});
beforeEach(() => { payload = dash(); localStorage.clear(); });
afterEach(cleanup);

const show = async () => {
  const view = render(<DashboardPage />);
  await act(async () => { await Promise.resolve(); });
  return view;
};

describe('the ingest lag banner', () => {
  it('says nothing when ingestion is keeping up', async () => {
    // A dashboard that always warns is a dashboard nobody reads.
    payload = dash({ ingestLagMinutes: 2 });
    expect((await show()).container.textContent).not.toContain('Last ingest');
  });

  it('says nothing when ingestion has never run', async () => {
    // A fresh install has no lag to report, only no data.
    payload = dash({ ingestLagMinutes: null });
    expect((await show()).container.textContent).not.toContain('Last ingest');
  });

  it('warns once the data could be meaningfully behind', async () => {
    payload = dash({ ingestLagMinutes: 45 });
    expect((await show()).container.textContent).toContain('Last ingest 45m ago');
  });

  it('says hours in hours, which is the case that actually happened', async () => {
    // Ten hours and five minutes, on the day this was written.
    payload = dash({ ingestLagMinutes: 605 });
    const text = (await show()).container.textContent!;
    expect(text).toContain('Last ingest 10h 5m ago');
    expect(text).toContain('not shown yet');
  });

  it('draws the rest of the dashboard regardless', async () => {
    payload = dash({ ingestLagMinutes: 605 });
    expect((await show()).container.textContent).toContain('openai/gpt-6-astra');
  });
});
