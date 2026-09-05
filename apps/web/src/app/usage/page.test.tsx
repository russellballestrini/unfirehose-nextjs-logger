// @vitest-environment jsdom
import { describe, it, expect, beforeEach, beforeAll, afterEach, vi } from 'vitest';
import { render, cleanup, act, waitFor } from '@testing-library/react';

/**
 * The usage monitor, which is a page of alerts and two buttons that change
 * them in bulk.
 *
 * Acknowledging clears every open alert at once and calibrating rewrites
 * every threshold from history. Both are irreversible from here, and both
 * are the kind of thing somebody clicks twice when nothing appears to
 * happen — so each has to say what it is doing, say what it did, and say
 * when it failed rather than falling silently back to idle.
 *
 * The page also groups alerts by metric and window: twenty alerts for the
 * same threshold is one thing that happened, and listing them
 * individually buries the one that is different.
 */

let alerts: unknown[] | undefined;
let daily: unknown;
let recent: unknown[] | undefined;
let thresholds: unknown;
let settings: Record<string, string> | undefined;

/**
 * One mutate per key, kept stable.
 *
 * The page's mount effect depends on the mutate functions it was handed.
 * A fresh one per render changes that dependency every render, which is an
 * ingest per frame — real SWR returns a stable reference.
 */
const mutates = new Map<string, () => void>();
const mutateFor = (k: string) => {
  if (!mutates.has(k)) mutates.set(k, vi.fn());
  return mutates.get(k)!;
};

vi.mock('swr', () => ({
  default: (key: string) => {
    const k = String(key);
    const data = k.includes('unacknowledged') ? alerts
      : k.includes('filter=daily') ? daily
      : k.includes('filter=thresholds') ? thresholds
      : k.startsWith('/api/alerts') ? recent
      : k.startsWith('/api/settings') ? settings
      : undefined;
    return { data, error: undefined, isLoading: false, mutate: mutateFor(k) };
  },
  useSWRConfig: () => ({ mutate: vi.fn() }),
}));
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn() }), usePathname: () => '/usage',
  useSearchParams: () => new URLSearchParams(),
}));
vi.mock('@/components/UPlotTimeChart', () => ({ UPlotTimeChart: () => null, default: () => null }));

const UsageMonitorPage = (await import('./page')).default;

const alert = (over: Record<string, unknown> = {}) => ({
  id: 1, metric: 'output_tokens', window_minutes: 15, threshold_value: 50_000,
  actual_value: 132_000, triggered_at: '2026-09-04T12:00:00Z', acknowledged: 0,
  alert_type: 'threshold', project_name: null, details: '{}', ...over,
});

let ok = true;
const posts = () => (global.fetch as unknown as { mock: { calls: unknown[][] } }).mock.calls
  .filter(([, init]) => (init as { method?: string } | undefined)?.method === 'POST')
  .map(([url, init]) => ({
    url: String(url),
    body: (() => { try { return JSON.parse((init as { body?: string }).body ?? 'null'); } catch { return null; } })(),
  }));

beforeAll(() => {
  window.ResizeObserver ??= class { observe() {} unobserve() {} disconnect() {} } as never;
  Object.defineProperty(HTMLElement.prototype, 'offsetWidth', { configurable: true, value: 1024 });
});
beforeEach(() => {
  ok = true;
  alerts = [alert()];
  daily = [{ day: '2026-09-04', count: 3 }];
  recent = [alert({ acknowledged: 1 })];
  thresholds = [{ metric: 'output_tokens', window_minutes: 15, threshold_value: 50_000 }];
  settings = {};
  global.fetch = vi.fn(async () => ({ ok, status: ok ? 200 : 500, json: async () => ({ ok }) })) as never;
});
afterEach(cleanup);

const show = async () => {
  // The panel tab lives in the URL hash and survives between tests; every
  // render starts from the page as a fresh visitor sees it.
  window.history.replaceState(null, '', window.location.pathname);
  const view = render(<UsageMonitorPage />);
  await act(async () => { await Promise.resolve(); });
  return view;
};
const button = (re: RegExp) =>
  [...document.querySelectorAll('button')].find(b => re.test(b.textContent ?? ''));

describe('usage monitor', () => {
  it('does not ingest on arrival — the worker does, and a visit must not stall the server', async () => {
    // POST /api/ingest runs ingestAll() synchronously inside the Next
    // process, measured at over two minutes on a busy box. Firing it on
    // every visit froze every other request, this page's included.
    await show();
    expect(posts().filter((p) => p.url === '/api/ingest')).toHaveLength(0);
  });

  it('still offers a manual ingest for when a minute is too long to wait', async () => {
    await show();
    await act(async () => { button(/Ingest Now/)!.click(); });
    expect(posts().filter((p) => p.url === '/api/ingest')).toHaveLength(1);
  });

  it('groups alerts by metric and window', async () => {
    // Twenty alerts on one threshold is one thing that happened.
    alerts = [alert({ id: 1 }), alert({ id: 2 }), alert({ id: 3, metric: 'cost_usd' })];
    const { container } = await show();
    expect(container.textContent).toContain('output_tokens');
    expect(container.textContent).toContain('cost_usd');
  });

  it('acknowledges every open alert in one call', async () => {
    await show();
    await act(async () => { button(/Acknowledge all/)!.click(); });
    await waitFor(() => expect(posts().find(p => p.body?.action === 'acknowledge_all')).toBeTruthy());
  });

  it('says how many it acknowledged', async () => {
    alerts = [alert({ id: 1 }), alert({ id: 2 })];
    const { container } = await show();
    await act(async () => { button(/Acknowledge all/)!.click(); });
    await waitFor(() => expect(container.textContent).toContain('Acknowledged 2'));
  });

  it('says so when acknowledging failed, rather than going quiet', async () => {
    // Going back to idle reads as success, and the alerts are still there.
    ok = false;
    const { container } = await show();
    await act(async () => { button(/Acknowledge all/)!.click(); });
    await waitFor(() => expect(container.textContent).toMatch(/HTTP 500|failed/));
  });

  it('does nothing when there is nothing to acknowledge', async () => {
    alerts = [];
    await show();
    const btn = button(/Acknowledge all/);
    if (btn) await act(async () => { btn.click(); });
    expect(posts().some(p => p.body?.action === 'acknowledge_all')).toBe(false);
  });

  /** The rules table sits behind a tab; open it the way a person would. */
  const openRules = async () => { await act(async () => { button(/^Rules$/)!.click(); }); };

  it('calibrates thresholds from history', async () => {
    await show();
    await openRules();
    await act(async () => { button(/Calibrate/)!.click(); });
    await waitFor(() => expect(posts().some(p => p.body?.action?.includes('calibrate'))).toBe(true));
  });

  it('says when thresholds were last calibrated, and from how much history', async () => {
    // A threshold nobody has revisited fires constantly, and the date is
    // the only sign of that.
    settings = { alert_calibration: JSON.stringify({
      at: '2026-09-01T00:00:00Z', days: 7, factor: 1.5, results: [],
    }) };
    const { container } = await show();
    await openRules();
    expect(container.textContent).toContain('from 7d of history');
  });

  it('ignores calibration settings that will not parse', async () => {
    // It is stored as JSON in a settings row anybody can edit.
    settings = { alert_calibration: '{not json' };
    expect((await show()).container.textContent!.length).toBeGreaterThan(100);
  });

  it('draws a page with no alerts at all', async () => {
    alerts = []; daily = []; recent = []; thresholds = [];
    expect((await show()).container.textContent!.length).toBeGreaterThan(100);
  });

  it('puts the hits above everything else', async () => {
    // The alerts are what the page is for. The rules table used to take the
    // whole width by itself and push the breach history below the fold.
    await show();
    const hits = document.body.textContent!.indexOf('USAGE ALERTS');
    const history = document.body.textContent!.indexOf('Breaches');
    expect(hits).toBeGreaterThan(-1);
    expect(hits).toBeLessThan(history);
  });

  it('opens on recent alerts, with the rules a tab away', async () => {
    await show();
    expect(button(/^Rules$/)?.getAttribute('aria-selected')).toBe('false');
    expect(document.body.textContent).not.toContain('Alert Rules');
    await openRules();
    expect(button(/^Rules$/)?.getAttribute('aria-selected')).toBe('true');
    expect(document.body.textContent).toContain('Alert Rules');
    expect(button(/Calibrate/)).toBeTruthy();
    // The rules themselves, not just the heading above them.
    expect(document.querySelectorAll('table tbody tr')).toHaveLength(1);
    expect(document.body.textContent).toContain('output_tokens');
  });

  it('lays history and the panel side by side on a wide screen', async () => {
    await show();
    const grid = document.querySelector('.lg\\:grid-cols-2');
    expect(grid).toBeTruthy();
    expect(grid!.children).toHaveLength(2);
  });
});

