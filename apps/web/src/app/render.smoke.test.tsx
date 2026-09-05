// @vitest-environment jsdom
/// <reference types="vite/client" />
import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from 'vitest';
import { render, cleanup, act } from '@testing-library/react';

/**
 * Every page renders against data.
 *
 * pages.smoke.test.tsx proves each module loads. That catches a bad import
 * and nothing else: a page whose body throws on the first row of its data
 * imports perfectly. This mounts them.
 *
 * Every hook that reaches the network is answered from one fixture, so what
 * is exercised is our rendering — the fallbacks, the empty states, the
 * formatting — rather than a server. Nothing here asserts on appearance; the
 * claim is only that a page can be shown a plausible payload without
 * throwing, which is the thing no other test in this suite checks.
 */

// A payload broad enough that any page finds fields it recognises, and
// shaped so the common accessors — .map, .length, .toFixed — all work.
const FIXTURE: Record<string, unknown> = {
  summary: { sessions: 3, messages: 42, models: 2, totalCost: 1.5, totalTokens: 1000,
             inputTokens: 100, outputTokens: 50, cacheReadTokens: 800, cacheWriteTokens: 50,
             cacheHitRate: 0.8, cacheCost: 0.4, costSplit: { input: 1, output: 1, cacheRead: 1, cacheWrite: 1 },
             since: '2026-01-01' },
  modelBreakdown: [], dailyActivity: [], hourCounts: [], dayOfWeekCounts: [], dowHourHeatmap: [],
  projects: [], sessions: [], messages: [], todos: [], rows: [], items: [], nodes: [],
  timeline: [], hostnames: [], entries: [], files: [], commits: [], logs: [], alerts: [],
  harnesses: [], keys: [], services: [], badges: [], events: [], blocks: [], results: [],
  stats: { total_cost_usd: 1, output_share_pct: 10, cost_per_minute: 0.1, tokens_per_minute: 10 },
  totals: { total_cost_usd: 1, total_tokens: 100, messages: 5, output_tokens: 10,
            input_tokens: 10, cost_split_usd: { input: 1, output: 1 } },
  lifetime: { totalSessions: 3, totalMessages: 42, activeDays: 5, totalInputTokens: 10,
              totalOutputTokens: 5, totalCacheRead: 100, totalCacheWrite: 10,
              totalCostUSD: 1, costSplit: { input: 1, output: 1, cacheRead: 1, cacheWrite: 1 } },
  alert: { id: 1, metric: 'output_tokens', actual_value: 100, threshold_value: 50,
           triggered_at: '2026-09-04T12:00:00Z', acknowledged: 0 },
  window: { duration_minutes: 15, start: '2026-09-04T12:00:00Z', end: '2026-09-04T12:15:00Z' },
  projectBreakdown: [], activeSessions: [], reasoningBlocks: [], userPrompts: [],
  // The db page destructures these and formats them without a guard for
  // undefined, so a fixture missing one crashes the render.
  tables: [], indexes: [], pageSize: 4096, pageCount: 100, freelistCount: 1,
  cacheSize: 2000, journalMode: 'wal', walCheckpoint: 0, totalBytes: 4096000,
  freeBytes: 4096, totalBytesHuman: '4 MB', usedBytesHuman: '4 MB',
  freeBytesHuman: '4 KB', fileSizeHuman: '4 MB',
  counts: {}, size: 0, sizeBytes: 0,
  streaks: { current: 1, longest: 2 },
  project: { displayName: 'demo' }, tier: 0, connected: false, ok: true, count: 0,
  db: { projects: 1, sessions: 1, messages: 1 },
};

/**
 * An array that also carries every object field.
 *
 * Some endpoints answer with a list and some with an object, and a page
 * reaches for whichever it expects — `data.map` here, `data.summary` there.
 * One fixture that is both satisfies either without a per-route table, which
 * would be a second copy of the API to keep in step.
 */
const PAYLOAD = Object.assign([] as unknown[], FIXTURE);

/** What every useSWR call answers. Reassigned per test to change the state. */
let swrAnswer: Record<string, unknown>;

vi.mock('swr', () => {
  const useSWR = () => swrAnswer;
  return { default: useSWR, useSWRConfig: () => ({ mutate: vi.fn() }), mutate: vi.fn() };
});

/**
 * The uPlot chart is a canvas that measures itself, so jsdom can neither
 * draw it nor tell it a size — it is stubbed whole rather than piece by
 * piece. Its own tests would need a browser; what this harness is for is
 * the pages around it.
 */
vi.mock('@/components/UPlotTimeChart', () => ({
  UPlotTimeChart: () => null,
  default: () => null,
}));

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn(), back: vi.fn() }),
  useParams: () => ({ project: 'demo', session: '0', node: 'localhost', id: '1', sessionId: 's1' }),
  usePathname: () => '/',
  useSearchParams: () => new URLSearchParams(),
  notFound: vi.fn(),
}));

beforeAll(() => {
  Object.defineProperty(window, 'matchMedia', {
    writable: true,
    value: (query: string) => ({
      matches: false, media: query, onchange: null,
      addListener: vi.fn(), removeListener: vi.fn(),
      addEventListener: vi.fn(), removeEventListener: vi.fn(), dispatchEvent: vi.fn(),
    }),
  });
  window.ResizeObserver ??= class {
    observe() {} unobserve() {} disconnect() {}
  } as never;
  window.scrollTo ??= vi.fn() as never;
  // Live pages open an EventSource; jsdom has none, and a page that cannot
  // subscribe should still render its shell.
  (global as Record<string, unknown>).EventSource ??= class {
    close() {} addEventListener() {} removeEventListener() {}
    onmessage = null; onerror = null; readyState = 0;
  };
  Element.prototype.scrollIntoView ??= vi.fn() as never;
  global.fetch = vi.fn().mockResolvedValue({
    ok: true, status: 200, json: async () => PAYLOAD, text: async () => '',
  }) as never;
  // Recharts measures its container; jsdom reports zero and renders nothing
  // useful, so give it a size.
  Object.defineProperty(HTMLElement.prototype, 'offsetWidth', { configurable: true, value: 1024 });
  Object.defineProperty(HTMLElement.prototype, 'offsetHeight', { configurable: true, value: 768 });
});

beforeEach(() => {
  swrAnswer = {
    data: PAYLOAD, error: undefined, isLoading: false, isValidating: false, mutate: vi.fn(),
  };
});

afterEach(cleanup);

const pages = import.meta.glob('./**/page.tsx');

const pageProps = () => ({
  // Next passes params as a promise to a page; `use()` unwraps it.
  params: Promise.resolve({
    project: 'demo', session: '0', node: 'localhost', id: '1', sessionId: 's1',
  }),
  searchParams: Promise.resolve({}),
}) as never;

describe('every page renders', () => {
  it('finds all of them, so this cannot quietly cover nothing', () => {
    expect(Object.keys(pages).length).toBeGreaterThanOrEqual(24);
  });

  for (const [path, load] of Object.entries(pages)) {
    it(`renders ${path.replace('./', '')}`, async () => {
      const mod = (await load()) as { default: (props: never) => React.ReactNode };
      expect(() => render(<mod.default {...pageProps()} />)).not.toThrow();
    });
  }
});

/**
 * The same pages with nothing to show, and with a failure to show.
 *
 * Every one of these has a spinner branch and an error branch that a
 * populated fixture never reaches, and they are exactly where an unguarded
 * `data.rows.length` hides — the happy path proves nothing about them.
 */
describe('every page renders with no data and with an error', () => {
  for (const [path, load] of Object.entries(pages)) {
    it(`survives an empty and a failed load: ${path.replace('./', '')}`, async () => {
      const mod = (await load()) as { default: (props: never) => React.ReactNode };

      swrAnswer = { data: undefined, error: undefined, isLoading: true, isValidating: true, mutate: vi.fn() };
      expect(() => render(<mod.default {...pageProps()} />)).not.toThrow();
      cleanup();

      swrAnswer = { data: undefined, error: new Error('offline'), isLoading: false, isValidating: false, mutate: vi.fn() };
      expect(() => render(<mod.default {...pageProps()} />)).not.toThrow();
    });
  }
});

/**
 * Click everything a page offers.
 *
 * Most of what a page contains is handlers, and none of them run when it is
 * merely rendered. This is not a claim that any button does the right thing
 * — it is the claim that pressing one does not throw, which is what a blank
 * screen looks like to whoever pressed it.
 */
describe('pressing every control leaves the page standing', () => {
  for (const [path, load] of Object.entries(pages)) {
    it(`clicks through ${path.replace('./', '')}`, async () => {
      const mod = (await load()) as { default: (props: never) => React.ReactNode };
      const { container } = render(<mod.default {...pageProps()} />);

      // Several rounds, because a tab press reveals controls that were not
      // in the document a moment ago — one pass only ever reaches the first
      // screen of a tabbed page.
      const pressed = new Set<Element>();
      for (let round = 0; round < 4; round += 1) {
        const controls = [...container.querySelectorAll('button, [role="tab"], summary, [role="button"]')]
          .filter((c) => !pressed.has(c));
        if (controls.length === 0) break;

        for (const control of controls.slice(0, 60)) {
          pressed.add(control);
          // A handler that throws fails this test; one that rejects a promise
          // is the page's own business and not ours to judge here.
          act(() => { (control as HTMLElement).click(); });
        }
      }
      expect(container).toBeTruthy();
    });
  }
});
