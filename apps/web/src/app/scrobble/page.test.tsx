// @vitest-environment jsdom
import { describe, it, expect, beforeEach, beforeAll, afterEach, vi } from 'vitest';
import { render, cleanup, act, waitFor, fireEvent } from '@testing-library/react';

/**
 * A public profile built out of our own logs.
 *
 * This is the one page in the dashboard whose output is meant to leave the
 * machine, so what it shows and what it withholds are the whole point: a
 * project marked private must not appear, and the toggle that decides that
 * is per project rather than a single switch.
 */

let payload: Record<string, unknown> | undefined;
let preview: Record<string, unknown> | undefined;
let settings: Record<string, string> | undefined;
vi.mock('swr', () => ({
  default: (key: string) => ({
    data: String(key).includes('payload') ? payload
      : String(key).includes('preview') ? preview
      : settings,
    error: undefined, isLoading: payload === undefined, mutate: vi.fn(),
  }),
  useSWRConfig: () => ({ mutate: vi.fn() }),
}));
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn() }), usePathname: () => '/scrobble',
  useSearchParams: () => new URLSearchParams(),
}));
vi.mock('@/components/UPlotTimeChart', () => ({ UPlotTimeChart: () => null, default: () => null }));
/** The velocity chart, as a record of what it was handed. */
const charts: Array<Record<string, unknown>> = [];
vi.mock('@/components/UPlotCategoryChart', () => ({
  UPlotCategoryChart: (props: Record<string, unknown>) => { charts.push(props); return null; },
}));

const ScrobblePage = (await import('./page')).default;

const full = (over: Record<string, unknown> = {}) => ({
  $schema: 'unfirehose-scrobble/1.0',
  generatedAt: '2026-09-05T00:00:00Z',
  handle: 'fox', displayName: 'fox',
  lifetime: {
    totalSessions: 412, totalMessages: 18_402, activeDays: 96,
    firstActivity: '2026-01-01T00:00:00Z', lastActivity: '2026-09-04T12:00:00Z',
    totalInputTokens: 120_000, totalOutputTokens: 40_000,
    totalCacheRead: 9_000_000, totalCacheWrite: 300_000,
    totalCostUSD: 214.5,
    costSplit: { input: 10, output: 40, cacheRead: 150, cacheWrite: 14.5 },
  },
  streaks: { current: 12, longest: 31 },
  badges: [
    { id: 'sessions-100', name: 'Century', description: '100 sessions', earned: true, tier: 'silver' },
    { id: 'sessions-1000', name: 'Millennium', description: '1000 sessions', earned: false, tier: 'gold', progress: 0.41 },
  ],
  activity: {
    hourOfDay: Array.from({ length: 24 }, (_, h) => ({ hour: h, count: h })),
    dayOfWeek: Array.from({ length: 7 }, (_, d) => ({ dow: d, count: d * 3 })),
    heatmap: [{ dow: 1, hour: 9, count: 12 }],
  },
  timeSeries: {
    dailyMessages: [{ date: '2026-09-04', count: 120 }],
    dailyCost: [{ date: '2026-09-04', cost: 3.2 }],
    weeklyVelocity: [{ week: '2026-W20', sessions: 40, messages: 5000 }, { week: '2026-W34', sessions: 12, messages: 800 }, { week: '2026-W35', sessions: 3, messages: 120, partial: true }],
  },
  models: [{ model: 'claude-opus-4-6-20260301', messages: 300, cost: 180 }],
  harnesses: [{ harness: 'claude', sessions: 400, messages: 18_000 }],
  tools: [{ name: 'Bash', count: 4200 }, { name: 'Edit', count: 1800 }],
  projects: [
    { name: 'demo', visibility: 'public', sessions: 12, messages: 480, activeDays: 40,
      inputTokens: 1000, outputTokens: 400, firstActivity: '2026-01-01T00:00:00Z',
      lastActivity: '2026-09-04T12:00:00Z' },
    { name: 'a private thing', visibility: 'private', sessions: 3, messages: 40, activeDays: 2,
      inputTokens: 10, outputTokens: 4, firstActivity: '2026-05-01T00:00:00Z',
      lastActivity: '2026-05-02T00:00:00Z' },
  ],
  sessionStats: { avgDurationMs: 1_800_000 },
  ...over,
});

const posts = () => (global.fetch as unknown as { mock: { calls: unknown[][] } }).mock.calls
  .filter(([, init]) => (init as { method?: string } | undefined)?.method === 'POST')
  .map(([url, init]) => ({ url: String(url), body: JSON.parse((init as { body: string }).body) }));

beforeAll(() => {
  window.ResizeObserver ??= class { observe() {} unobserve() {} disconnect() {} } as never;
  window.matchMedia ??= ((q: string) => ({
    matches: false, media: q, addEventListener() {}, removeEventListener() {},
  })) as never;
  Object.assign(navigator, { clipboard: { writeText: vi.fn() } });
});
beforeEach(() => {
  payload = full();
  // The projects tab reads the preview, which carries the per-project
  // visibility a person sets here — the payload carries only what that
  // decision let through.
  preview = {
    markdown: '# fox\n\n412 sessions.',
    projects: [
      { name: '-home-fox-git-demo', displayName: 'demo', visibility: 'public',
        autoDetected: 'public_repo:git.unturf.com/demo', sessionCount: 12, messageCount: 480,
        totalInput: 1000, totalOutput: 400,
        firstActivity: '2026-01-01T00:00:00Z', lastActivity: '2026-09-04T12:00:00Z' },
      { name: '-home-fox-git-secret', displayName: 'a private thing', visibility: 'private',
        autoDetected: null, sessionCount: 3, messageCount: 40, totalInput: 10, totalOutput: 4,
        firstActivity: '2026-05-01T00:00:00Z', lastActivity: '2026-05-02T00:00:00Z' },
      { name: '-home-fox-git-draft', displayName: 'a draft', visibility: 'unlisted',
        autoDetected: null, sessionCount: 1, messageCount: 4, totalInput: 1, totalOutput: 1,
        firstActivity: '2026-06-01T00:00:00Z', lastActivity: '2026-06-02T00:00:00Z' },
    ],
    included: 1, excluded: 2,
  };
  settings = { unfirehose_handle: 'fox', unfirehose_display_name: 'fox' };
  global.fetch = vi.fn(async () => ({ ok: true, json: async () => ({ ok: true }) })) as never;
});
afterEach(cleanup);

const show = async () => {
  const view = render(<ScrobblePage />);
  await act(async () => { await Promise.resolve(); });
  return view;
};
/** The tab strip's own buttons, which are exactly the three tab names. */
const tab = async (name: string) => {
  const el = [...document.querySelectorAll('button')]
    .find(b => b.textContent?.trim().toLowerCase() === name);
  if (el) await act(async () => { el.click(); });
};

describe('the scrobble page', () => {
  it('shows the lifetime totals it was given', async () => {
    const { container } = await show();
    expect(container.textContent).toContain('412');
    expect(container.textContent).toMatch(/18[,.]?402/);
  });

  it('shows the streak, which is the number people come back for', async () => {
    expect((await show()).container.textContent).toContain('12');
  });

  it('separates a badge earned from one still in progress', async () => {
    const { container } = await show();
    await tab('badges');
    expect(container.textContent).toContain('Century');
    expect(container.textContent).toContain('Millennium');
  });

  it('lists projects with their visibility, which is the whole decision', async () => {
    // This page is published. A project marked private appearing on it is
    // the one failure that cannot be taken back.
    const { container } = await show();
    await tab('projects');
    expect(container.textContent).toContain('demo');
    expect(container.textContent).toContain('1 public');
    expect(container.textContent).toContain('1 private');
    expect(container.textContent).toContain('1 unlisted');
  });

  it('counts an unlisted project apart from a public one', async () => {
    // Unlisted is reachable by link and absent from the index. Folding it
    // into public would publish it; folding it into private would break
    // every link somebody has already shared.
    const { container } = await show();
    await tab('projects');
    expect(container.textContent).not.toContain('2 public');
  });

  it('draws before the payload arrives', async () => {
    payload = undefined;
    expect((await show()).container.textContent!.length).toBeGreaterThan(10);
  });

  it('draws a profile with nothing in it yet', async () => {
    // A fresh install has no sessions, and this is the page most likely to
    // be opened first out of curiosity.
    payload = full({
      lifetime: { totalSessions: 0, totalMessages: 0, activeDays: 0, totalInputTokens: 0,
                  totalOutputTokens: 0, totalCacheRead: 0, totalCacheWrite: 0, totalCostUSD: 0,
                  costSplit: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } },
      streaks: { current: 0, longest: 0 }, badges: [], projects: [], models: [],
      harnesses: [], tools: [],
      activity: { hourOfDay: [], dayOfWeek: [], heatmap: [] },
      timeSeries: { dailyMessages: [], dailyCost: [], weeklyVelocity: [] },
    });
    const { container } = await show();
    expect(container.textContent).not.toContain('undefined');
    expect(container.textContent).not.toContain('NaN');
  });

  it('moves between its tabs', async () => {
    const { container } = await show();
    for (const t of ['projects', 'badges', 'overview']) {
      await tab(t);
      expect(container.textContent!.length).toBeGreaterThan(50);
    }
  });

  it('draws weekly velocity as a chart, sessions as bars and messages on their own axis', async () => {
    // It was a grid of week / N sessions / N msgs in text — thirteen cells of
    // numbers nobody can compare by eye.
    charts.length = 0;
    await show();
    const chart = charts.find((c) => c.labelKey === 'week')!;
    expect(chart).toBeTruthy();
    expect((chart.data as Array<{ week: string }>).map((w) => w.week)).toEqual(['2026-W20', '2026-W34', '2026-W35']);
    const series = chart.series as Array<{ key: string; kind?: string; axis?: string }>;
    expect(series.map((s) => s.key)).toEqual(['sessions', 'messages']);
    // Messages run into the tens of thousands where sessions are hundreds; on
    // one axis the sessions would be a flat line at zero.
    expect(series[1]).toMatchObject({ kind: 'lines', axis: 'right' });
  });

  it('says the current week is partial', async () => {
    const { container } = await show();
    expect(container.textContent).toContain('current week is partial');
  });

  it('puts the lifetime numbers on one strip', async () => {
    const { container } = await show();
    const strips = container.querySelectorAll('.flex-wrap');
    const strip = [...strips].find((el) => el.textContent?.includes('Sessions') && el.textContent?.includes('Cache write'));
    expect(strip).toBeTruthy();
    expect(strip!.textContent).toContain('412');
  });

  it('offers the day ranges and Lifetime, not hours, since the series are daily', async () => {
    const { container } = await show();
    const select = [...container.querySelectorAll('select')].find((el) => el.textContent?.includes('Lifetime'))!;
    expect(select).toBeTruthy();
    const values = [...select.querySelectorAll('option')].map((o) => o.value);
    expect(values).toEqual(['7d', '14d', '28d', '90d', '180d', '365d', 'all']);
  });

  it('shows everything by default — this is a profile', async () => {
    charts.length = 0;
    await show();
    const chart = charts.find((c) => c.labelKey === 'week')!;
    expect((chart.data as unknown[]).length).toBe(3);
  });

  it('narrows the dated series to the chosen range, and says which', async () => {
    charts.length = 0;
    const { container } = await show();
    const select = [...container.querySelectorAll('select')].find((el) => el.textContent?.includes('Lifetime'))!;
    await act(async () => { fireEvent.change(select, { target: { value: '7d' } }); });
    // A week from May is gone; the recent ones stay. The exact boundary
    // depends on today's date, so the assertion is about the old week.
    const chart = charts.at(-1)!;
    const weeks = (chart.data as Array<{ week: string }>).map((w) => w.week);
    expect(weeks).not.toContain('2026-W20');
    expect(weeks).toContain('2026-W35');
    expect(container.textContent).toContain('last 7 days');
  });

  /**
   * With the day grain in the payload, the range folds everything — the
   * strip, the heatmap, the hour bars, the model and tool lists — not only
   * the two dated series. Before, "last 7 days" was a label on a page whose
   * numbers had not moved.
   */
  describe('with the day grain', () => {
    const today = new Date().toISOString().slice(0, 10);
    const hours = (at: Record<number, number>) => { const h = new Array(24).fill(0); for (const [k, v] of Object.entries(at)) h[Number(k)] = v; return h; };
    const grain = () => full({
      daily: [
        { date: '2026-01-15', messages: 1000, sessions: 100, inputTokens: 100_000, outputTokens: 30_000, cacheRead: 8_000_000, cacheWrite: 250_000, costUSD: 200,
          costSplit: { input: 8, output: 30, cacheRead: 150, cacheWrite: 12 }, hours: hours({ 3: 1000 }) },
        { date: today, messages: 20, sessions: 2, inputTokens: 20_000, outputTokens: 10_000, cacheRead: 1_000_000, cacheWrite: 50_000, costUSD: 14.5,
          costSplit: { input: 2, output: 10, cacheRead: 0, cacheWrite: 2.5 }, hours: hours({ 14: 20 }) },
      ],
      modelDaily: [
        { date: '2026-01-15', model: 'claude-opus-4-6-20260301', messages: 1000, inputTokens: 100_000, outputTokens: 30_000 },
        { date: today, model: 'claude-haiku-4-5-20251001', messages: 20, inputTokens: 20_000, outputTokens: 10_000 },
      ],
      harnessDaily: [
        { date: '2026-01-15', harness: 'claude', sessions: 100, messages: 1000 },
        { date: today, harness: 'uncloseai', sessions: 2, messages: 20 },
      ],
      toolDaily: [
        { date: '2026-01-15', name: 'Bash', count: 4200 },
        { date: today, name: 'Read', count: 7 },
      ],
    });
    // The selector remembers its last choice; an earlier test left it on 7d.
    beforeEach(() => { try { localStorage.removeItem('scrobble_range'); } catch { /* jsdom */ } });
    const pick = async (container: HTMLElement, value: string) => {
      const select = [...container.querySelectorAll('select')].find((el) => el.textContent?.includes('Lifetime'))!;
      await act(async () => { fireEvent.change(select, { target: { value } }); });
    };

    it('folds the strip for the range, and lifetime is the whole grain', async () => {
      payload = grain();
      const { container } = await show();
      expect(container.textContent).toContain('1,020');   // messages, lifetime
      expect(container.textContent).toContain('Figures below are lifetime');
      await pick(container, '7d');
      expect(container.textContent).toContain('Figures below are last 7 days');
      expect(container.textContent).not.toContain('1,020');
      expect(container.textContent).toContain('$14.5');
    });

    it('re-folds the heatmap and hour bars, and re-ranks models, harnesses and tools', async () => {
      payload = grain();
      const { container } = await show();
      expect(container.textContent).toContain('Bash');
      expect(container.textContent).toContain('opus-4-6');
      await pick(container, '7d');
      expect(container.textContent).not.toContain('Bash');
      expect(container.textContent).toContain('Read');
      expect(container.textContent).not.toContain('opus-4-6');
      expect(container.textContent).toContain('haiku-4-5');
      expect(container.textContent).toContain('uncloseai');
      expect(container.textContent).not.toContain('100 sessions');
      expect(container.textContent).toContain('Activity Heatmap — last 7 days');
      expect(container.textContent).toContain('Hour of Day — last 7 days');
    });

    it('does not mistake a quiet range for a first run', async () => {
      payload = grain({ daily: [{ date: '2026-01-15', messages: 5, sessions: 1, inputTokens: 1, outputTokens: 1, cacheRead: 0, cacheWrite: 0, costUSD: 0, costSplit: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, hours: hours({ 3: 5 }) }] });
      const { container } = await show();
      await pick(container, '7d');
      expect(container.textContent).not.toContain('no sessions to scrobble');
      expect(container.textContent).toContain('Figures below are last 7 days');
    });

    it('says the figures stay lifetime when the payload predates the grain', async () => {
      payload = full();
      const { container } = await show();
      await pick(container, '7d');
      expect(container.textContent).toContain('Figures below are lifetime');
      expect(container.textContent).toContain('predates the day grain');
      expect(container.textContent).toContain('18,402');
    });
  });

  it('calls the same hooks while loading as after, so React never sees the order change', async () => {
    // The range hook briefly sat below the loading return. React caught it on
    // the first real navigation; the tests had not, because they never
    // rendered the loading state and then the loaded one in the same mount.
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    const loaded = payload;
    payload = undefined;
    const view = render(<ScrobblePage />);
    payload = loaded;
    await act(async () => { view.rerender(<ScrobblePage />); });
    expect(errors.mock.calls.flat().join(' ')).not.toMatch(/order of Hooks|Rendered more hooks/);
    errors.mockRestore();
  });
});

