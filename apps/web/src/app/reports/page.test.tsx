// @vitest-environment jsdom
import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, cleanup, fireEvent } from '@testing-library/react';

/**
 * Reports: one month of spend, for an expense claim.
 *
 * What the page shows has to be what the downloads carry, so it formats in
 * the currency and at the rate the report itself names, not the live rate
 * other pages use.
 */

let data: Record<string, unknown> | undefined;
let failed: Error | undefined;
const keys: string[] = [];
vi.mock('swr', () => ({
  default: (key: string) => { keys.push(key); return { data, error: failed, isLoading: false, mutate: vi.fn() }; },
  useSWRConfig: () => ({ mutate: vi.fn() }),
}));

const ReportsPage = (await import('./page')).default;

const report = (over: Record<string, unknown> = {}) => ({
  month: '2026-09', timeZone: 'UTC', closed: true, generatedAt: '2026-10-01T09:00:00.000Z',
  currency: { code: 'EUR', rate: 0.9, rateDate: '2026-09-30', source: 'ECB via Frankfurter' },
  lines: [
    { category: 'model-api', item: 'claude-opus-5', detail: '2.00M tokens', basis: 'priced', usd: 30 },
    { category: 'subscription', item: 'Claude Max 20x', detail: 'monthly plan price', basis: 'flat', usd: 200 },
  ],
  memo: [{ item: 'Claude Code usage covered by Claude Max 20x', detail: 'API-equivalent', usd: 120 }],
  byCategory: [
    { category: 'model-api', label: 'Model API usage', usd: 30 },
    { category: 'subscription', label: 'Subscriptions', usd: 200 },
  ],
  byProject: [{ project: 'acme', usd: 30 }],
  byModel: [], totalUSD: 230, notes: ['A note.'],
  ...over,
});

afterEach(() => { cleanup(); data = undefined; failed = undefined; keys.length = 0; });

describe('Reports page', () => {
  it('shows the month in the report\'s own currency, with the rate it converted at', () => {
    data = report();
    const { container } = render(<ReportsPage />);
    const text = container.textContent!;
    expect(text).toContain('€207.00');
    expect(text).toContain('Converted at 1 USD = 0.9 EUR, ECB via Frankfurter rate for 2026-09-30');
    expect(text).toContain('Claude Max 20x');
    expect(text).toContain('Not counted in the total');
    expect(text).toContain('€108.00');
  });

  it('downloads the same month, zone and figures it shows', () => {
    data = report();
    const { container } = render(<ReportsPage />);
    const links = [...container.querySelectorAll('a[download]')].map((a) => a.getAttribute('href'));
    expect(links).toHaveLength(2);
    for (const l of links) expect(l).toMatch(/^\/api\/reports\/monthly\?month=\d{4}-\d{2}&tz=[^&]+&format=(csv|pdf)$/);
  });

  it('asks for the month picked', () => {
    data = report();
    const { container } = render(<ReportsPage />);
    fireEvent.change(container.querySelector('input[type="month"]')!, { target: { value: '2026-07' } });
    expect(keys.at(-1)).toMatch(/month=2026-07&tz=/);
  });

  it('says so when a month had no spend, and when the report failed', () => {
    data = report({ lines: [], byCategory: [], byProject: [], memo: [], totalUSD: 0 });
    expect(render(<ReportsPage />).container.textContent).toContain('Nothing was spent in');
    cleanup();
    data = undefined; failed = new Error('database is locked');
    expect(render(<ReportsPage />).container.textContent).toContain('Could not build the report: database is locked');
  });

  it('stays in dollars and says why when the rate was not available', () => {
    data = report({ currency: { code: 'USD', rate: 1, rateDate: null, source: null, fallbackReason: 'NGN unavailable: the ECB does not publish this currency' } });
    const text = render(<ReportsPage />).container.textContent!;
    expect(text).toContain('$230.00');
    expect(text).toContain('Shown in USD — NGN unavailable');
  });
});
