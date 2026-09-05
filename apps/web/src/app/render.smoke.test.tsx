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
 * Per-page data, merged over the shared fixture.
 *
 * The shared payload keeps every list empty, which renders each page's
 * shell and nothing else — a table's header without a row, a chart's frame
 * without a series. That is the half of a page that has never been wrong.
 * The formatting, the per-row branches and the totals are what break, and
 * they only run when there is something in the list.
 *
 * Shapes below are taken from the live endpoints, not invented, because a
 * fixture that does not match what the API returns tests our fixture.
 */
const PAGE_DATA: Record<string, Record<string, unknown>> = {
  './todos/page.tsx': {
    todos: [
      { id: 1, project_id: 1, session_id: 1, external_id: '1', content: 'cover the ingest path',
        status: 'pending', active_form: 'covering the ingest path', source: 'claude',
        source_session_uuid: 's1', blocked_by: null, created_at: '2026-09-01T10:00:00Z',
        updated_at: '2026-09-02T10:00:00Z', completed_at: null, estimated_minutes: 30 },
      { id: 2, project_id: 1, session_id: 1, external_id: '2', content: 'delete the dead report',
        status: 'in_progress', active_form: 'deleting', source: 'claude',
        source_session_uuid: 's1', blocked_by: '[1]', created_at: '2026-09-01T11:00:00Z',
        updated_at: '2026-09-03T11:00:00Z', completed_at: null, estimated_minutes: null },
      { id: 3, project_id: 2, session_id: 2, external_id: null, content: 'push the tag',
        status: 'completed', active_form: null, source: 'manual', source_session_uuid: null,
        blocked_by: null, created_at: '2026-08-20T09:00:00Z', updated_at: '2026-08-21T09:00:00Z',
        completed_at: '2026-08-21T09:00:00Z', estimated_minutes: 5 },
    ],
    byProject: [
      { project: '-home-fox-git-demo', display: 'demo', projectPath: '/home/fox/git/demo', todos: 2 },
      { project: 'agnt:-home-fox-git-other', display: 'other', projectPath: null, todos: 1 },
    ],
    counts: { pending: 1, inProgress: 1, completed: 1, total: 3 },
    limit: 500, truncated: false,
  },

  './projects/page.tsx': {
    projects: [
      { name: '-home-fox-git-demo', displayName: 'demo', path: '/home/fox/git/demo',
        sessionCount: 12, totalMessages: 480, latestActivity: '2026-09-04T12:00:00Z',
        hasMemory: true, harnesses: ['claude'], foldedCount: 0,
        tokens: { input: 12_000, output: 4_000, cacheRead: 900_000, cacheWrite: 30_000 } },
      { name: 'agnt:-home-fox-git-other', displayName: 'agnt: other', path: null,
        sessionCount: 1, totalMessages: 3, latestActivity: '2026-06-01T12:00:00Z',
        hasMemory: false, harnesses: ['agnt', 'uncloseai'], foldedCount: 2,
        tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } },
    ],
  },

  './projects/[project]/page.tsx': {
    visibility: 'private',
    project: { name: '-home-fox-git-demo', displayName: 'demo', path: '/home/fox/git/demo',
               firstSeen: '2026-01-01T00:00:00Z' },
    stats: { sessionCount: 12, messageCount: 480, totalInput: 12_000, totalOutput: 4_000,
             totalCacheRead: 900_000, totalCacheWrite: 30_000, totalCost: 4.25,
             costSplit: { input: 1, output: 2, cacheRead: 1, cacheWrite: 0.25 },
             firstActivity: '2026-01-01T00:00:00Z', lastActivity: '2026-09-04T12:00:00Z',
             activeDays: 40 },
    models: [{ model: 'claude-opus-4-6-20260301', messages: 300, cost: 4.0 },
             { model: 'qwen3-coder', messages: 180, cost: 0.25 }],
    prompts: [{ text: 'add a test', timestamp: '2026-09-04T12:00:00Z', sessionUuid: 's1',
                sessionDisplay: 'demo #1', model: 'claude-opus-4-6-20260301' }],
    toolUsage: [{ tool_name: 'Bash', count: 120 }, { tool_name: 'Edit', count: 44 }],
  },

  './tokens/page.tsx': {
    modelBreakdown: [
      { model: 'claude-opus-4-6-20260301', inputTokens: 12_000, outputTokens: 4_000,
        cacheReadTokens: 900_000, cacheCreationTokens: 30_000, totalTokens: 946_000,
        inputCostUSD: 0.18, outputCostUSD: 0.30, cacheReadCostUSD: 1.35,
        cacheWriteCostUSD: 0.56, costUSD: 2.39 },
      // An unpriced model: every cost field is zero and the page must not
      // divide by the total to get a share.
      { model: 'local/stub', inputTokens: 500, outputTokens: 100, cacheReadTokens: 0,
        cacheCreationTokens: 0, totalTokens: 600, inputCostUSD: 0, outputCostUSD: 0,
        cacheReadCostUSD: 0, cacheWriteCostUSD: 0, costUSD: 0 },
    ],
    totalTokens: 946_600, totalCost: 2.39, totalInputCost: 0.18, totalOutputCost: 0.30,
    totalCacheReadCost: 1.35, totalCacheWriteCost: 0.56, totalInput: 12_500,
    totalOutput: 4_100, totalCacheRead: 900_000, totalCacheWrite: 30_000,
    toolCalls: [{ tool_name: 'Bash', count: 120 }],
    toolsByModel: [{ model: 'claude-opus-4-6-20260301', count: 120 }],
    dailyActivity: [
      { date: '2026-09-03', messageCount: 40, sessionCount: 2, toolCallCount: 12 },
      { date: '2026-09-04', messageCount: 55, sessionCount: 3, toolCallCount: 20 },
    ],
  },

  './permacomputer/page.tsx': {
    localHostname: 'neoblanka',
    nodes: [
      { hostname: 'neoblanka', reachable: true, cpuModel: 'AMD Ryzen 9 5950X', cpuTdpWatts: 105,
        spinningDisks: 1, ssdCount: 2, cpuCores: 32, memTotalGB: 64, memCapGB: 128,
        memUsedGB: 18.5, memAvailableGB: 45.5, loadAvg: [1.2, 0.9, 0.7], uptime: '12 days',
        uptimeSeconds: 1_036_800, cpuYear: 2020, claudeProcesses: 2,
        harnessCounts: { claude: 2, uncloseai: 1 }, swapTotalGB: 8, swapUsedGB: 0,
        powerWatts: 142.5, arch: 'x86_64', powerSource: 'rapl' },
      // An unreachable node: every number is missing and the summary still
      // has to add up.
      { hostname: 'cammy.foxhop.net', reachable: false, cpuModel: '', cpuTdpWatts: 0,
        spinningDisks: 0, ssdCount: 0, cpuCores: 0, memTotalGB: 0, memCapGB: 0,
        memUsedGB: 0, memAvailableGB: 0, loadAvg: [], uptime: '', uptimeSeconds: 0,
        cpuYear: 0, claudeProcesses: 0, harnessCounts: {}, swapTotalGB: 0, swapUsedGB: 0,
        powerWatts: 0, arch: '', powerSource: 'tdp' },
    ],
    summary: { totalNodes: 2, reachableNodes: 1, totalClaudes: 2, totalAgents: 3,
               totalHarnessCounts: { claude: 2, uncloseai: 1 }, totalCores: 32,
               totalMemGB: 64, totalMemUsedGB: 18.5, totalPowerWatts: 143 },
  },

  './usage/alert/[id]/page.tsx': {
    alerts: [{ id: 1, triggered_at: '2026-09-04T12:00:00Z', alert_type: 'threshold',
               window_minutes: 15, metric: 'output_tokens', threshold_value: 50,
               actual_value: 100, project_name: null, details: '{}', acknowledged: 0 }],
  },
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

/** The shared payload with one page's own data merged over it. */
const payloadFor = (path: string) => {
  const extra = PAGE_DATA[path];
  if (!extra) return PAYLOAD;
  // A page whose endpoint answers with a bare list gets that list as the
  // array half, so `data.map` and `data.projects` both work.
  const list = (extra.projects ?? extra.todos ?? extra.nodes ?? extra.alerts ?? []) as unknown[];
  return Object.assign([...list], FIXTURE, extra);
};

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
      swrAnswer = { data: payloadFor(path), error: undefined, isLoading: false, isValidating: false, mutate: vi.fn() };
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
