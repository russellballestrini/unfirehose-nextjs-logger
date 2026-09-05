// @vitest-environment jsdom
import { describe, it, expect, beforeEach, beforeAll, afterEach, vi } from 'vitest';
import { render, cleanup, act, waitFor } from '@testing-library/react';

/**
 * One usage alert, explained.
 *
 * An alert on its own is a number that crossed a line. This page is the
 * part that says what happened — which project, which model, over how long
 * — and most of it is one long narrative built out of the payload. That
 * narrative is what someone reads at 2am, so the branches in it are worth
 * holding: one project reads differently from five, a burst reads
 * differently from a window, and reasoning blocks that arrived sealed have
 * to be described as sealed rather than counted as text nobody can see.
 */

let alert: Record<string, unknown> | undefined;
let failed: Error | undefined;
let repoMeta: Record<string, unknown> | undefined;
/** Only the alert endpoint answers; the panels beside it fetch their own. */
vi.mock('swr', () => ({
  default: (key: string) => String(key).startsWith('/api/alerts')
    ? { data: alert, error: failed, isLoading: false, mutate: vi.fn() }
    : { data: repoMeta, error: undefined, isLoading: false, mutate: vi.fn() },
  useSWRConfig: () => ({ mutate: vi.fn() }),
}));
vi.mock('next/navigation', () => ({
  useParams: () => ({ id: '1' }), useRouter: () => ({ push: vi.fn() }),
  usePathname: () => '/usage/alert/1', useSearchParams: () => new URLSearchParams(),
}));
vi.mock('@/components/UPlotTimeChart', () => ({ UPlotTimeChart: () => null, default: () => null }));

const AlertDetailPage = (await import('./page')).default;

const payload = (over: Record<string, unknown> = {}) => ({
  alert: { id: 1, metric: 'output_tokens', threshold_value: 50_000, actual_value: 132_000,
           triggered_at: '2026-09-04T12:00:00Z', acknowledged: 0, alert_type: 'threshold',
           window_minutes: 15, project_name: null, details: '{}' },
  window: { duration_minutes: 15, start: '2026-09-04T11:45:00Z', end: '2026-09-04T12:00:00Z' },
  projectBreakdown: [
    { name: '-home-fox-git-demo', display_name: 'demo', cost_usd: 3.2, pct_of_total: 80, messages: 40 },
  ],
  modelBreakdown: [{ model: 'claude-opus-4-6-20260301', cost_usd: 3.0, messages: 30, tokens: 900_000 }],
  activeSessions: [{ session_uuid: 's1', display: 'demo #1', messages: 30, cost_usd: 3.0 }],
  reasoningBlocks: [{ id: 1, text: 'weighing it up', char_count: 13, model: 'claude-opus-4-6-20260301' }],
  timeline: [{ minute: '2026-09-04T11:50:00Z', output_tokens: 60_000, cost_usd: 1.5 }],
  userPrompts: [{ text: 'add a test', timestamp: '2026-09-04T11:46:00Z' }],
  totals: { total_cost_usd: 4.0, total_tokens: 1_000_000, messages: 40, output_tokens: 132_000,
            input_tokens: 12_000, cost_split_usd: { input: 1, output: 3 } },
  stats: { cache_hit_rate: 92, reasoning_chars: 13, sealed_reasoning_blocks: 0,
           total_cost_usd: 4.0, output_share_pct: 13, cost_per_minute: 0.26, tokens_per_minute: 66_000 },
  ...over,
});

beforeAll(() => {
  window.ResizeObserver ??= class { observe() {} unobserve() {} disconnect() {} } as never;
  Object.defineProperty(HTMLElement.prototype, 'offsetWidth', { configurable: true, value: 1024 });
});
beforeEach(() => {
  alert = payload(); failed = undefined;
  repoMeta = { branch: 'main', remotes: ['origin'], recentCommits: [{ hash: 'abc', subject: 'first' }] };
  global.fetch = vi.fn(async () => ({ ok: true, json: async () => ({ ok: true }) })) as never;
});
afterEach(cleanup);

const show = async () => {
  const view = render(<AlertDetailPage />);
  await act(async () => { await Promise.resolve(); });
  return view;
};
const text = async () => (await show()).container.textContent!;

describe('alert detail', () => {
  it('says by how much the threshold was passed', async () => {
    // The ratio is the number that decides whether this needs anybody.
    expect(await text()).toContain('2.64');
  });

  it('says it could not load rather than showing an empty alert', async () => {
    failed = new Error('offline');
    expect(await text()).toContain('Failed to load alert');
  });

  it('passes on an error the API named', async () => {
    alert = { error: 'No alert with id 1', detail: 'it may have been pruned' };
    const t = await text();
    expect(t).toContain('No alert with id 1');
    expect(t).toContain('it may have been pruned');
  });

  it('calls a short window a burst', async () => {
    alert = payload({ window: { duration_minutes: 3, start: '', end: '' } });
    expect(await text()).toContain('In a brief 3-minute burst');
  });

  it('calls a quarter hour a course of minutes', async () => {
    expect(await text()).toContain('Over the course of 15 minutes');
  });

  it('calls anything longer a window', async () => {
    alert = payload({ window: { duration_minutes: 60, start: '', end: '' } });
    expect(await text()).toContain('Across a 60-minute window');
  });

  it('names one project plainly rather than as one of one', async () => {
    expect(await text()).toContain('the demo project consumed');
  });

  it('names the share when several projects were involved', async () => {
    // Which project it was is the actionable half; a combined total alone
    // says only that something happened.
    alert = payload({ projectBreakdown: [
      { name: 'a', display_name: 'demo', cost_usd: 3.2, pct_of_total: 80, messages: 40 },
      { name: 'b', display_name: 'other', cost_usd: 0.8, pct_of_total: 20, messages: 10 },
    ] });
    const t = await text();
    expect(t).toContain('2 projects consumed a combined');
    expect(t).toContain('demo accounting for 80%');
  });

  it('names a model it does not recognise rather than leaving a gap', async () => {
    alert = payload({ modelBreakdown: [{ model: null, cost_usd: 3.0, messages: 30, tokens: 900 }] });
    expect(await text()).toContain('an unknown model bore');
  });

  it('calls a high cache hit rate strong and a low one modest', async () => {
    expect(await text()).toContain('Cache efficiency was strong at 92%');
    cleanup();
    alert = payload({ stats: { ...payload().stats, cache_hit_rate: 12 } });
    expect(await text()).toContain('Cache hit rate was a modest 12%');
  });

  it('says nothing about the cache in the narrative when there was none', async () => {
    // Zero is not a modest hit rate, it is a window with no cache in it,
    // and a sentence about it is noise in a paragraph read at 2am.
    alert = payload({ stats: { ...payload().stats, cache_hit_rate: 0 } });
    const t = await text();
    expect(t).not.toContain('Cache efficiency was strong');
    expect(t).not.toContain('Cache hit rate was a modest');
  });

  it('describes sealed reasoning as sealed, not as text nobody can see', async () => {
    // opus-4-7 ships a signature with no readable body. Counting those as
    // reasoning we have reads as a page that lost the text.
    alert = payload({
      reasoningBlocks: [{ id: 1, text: '', char_count: 0 }, { id: 2, text: '', char_count: 0 }],
      stats: { ...payload().stats, sealed_reasoning_blocks: 2, reasoning_chars: 0 },
    });
    expect(await text()).toContain('all sealed by Anthropic');
  });

  it('separates readable reasoning from sealed when both arrived', async () => {
    alert = payload({
      reasoningBlocks: [{ id: 1, text: 'a', char_count: 1 }, { id: 2, text: '', char_count: 0 }],
      stats: { ...payload().stats, sealed_reasoning_blocks: 1, reasoning_chars: 1 },
    });
    const t = await text();
    expect(t).toContain('1 readable');
    expect(t).toContain('1 sealed');
  });

  it('counts a single reasoning stream in the singular', async () => {
    expect(await text()).toContain('1 reasoning stream totalling');
  });

  it('acknowledges the alert it is showing', async () => {
    await show();
    const btn = [...document.querySelectorAll('button')]
      .find(b => /acknowledge/i.test(b.textContent ?? ''));
    if (!btn) throw new Error('missing control: btn');
    Object.defineProperty(window, 'location', { value: { reload: vi.fn() }, writable: true });
    await act(async () => { btn.click(); });
    await waitFor(() => {
      const calls = (global.fetch as unknown as { mock: { calls: unknown[][] } }).mock.calls;
      expect(JSON.parse((calls[0][1] as { body: string }).body))
        .toEqual({ action: 'acknowledge', id: 1 });
    });
  });

  it('draws the alert even when the repo panel has nothing to say', async () => {
    // That endpoint answers with an error body for a project it cannot
    // resolve, and reading a list off that took the whole page down.
    repoMeta = { error: 'unknown project' };
    expect((await text()).length).toBeGreaterThan(100);
  });

  it('renders an alert with nothing under it', async () => {
    // A window whose messages were pruned still has an alert row.
    alert = payload({
      projectBreakdown: [], modelBreakdown: [], activeSessions: [],
      reasoningBlocks: [], timeline: [], userPrompts: [],
    });
    expect((await text()).length).toBeGreaterThan(100);
  });
});
