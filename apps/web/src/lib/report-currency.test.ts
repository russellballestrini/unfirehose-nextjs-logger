import { describe, it, expect, vi } from 'vitest';
import { reportRate, rateDateFor, reportCurrencyCode } from './report-currency';

const answer = (body: unknown, status = 200) => vi.fn(async () => new Response(JSON.stringify(body), { status }));

describe('report currency', () => {
  it('takes the first display currency, defaulting to dollars', () => {
    expect(reportCurrencyCode({ display_currency: 'GBP, USD' })).toBe('GBP');
    expect(reportCurrencyCode({})).toBe('USD');
  });

  it('rates a closed month on its last day and a running one today', () => {
    const now = new Date('2026-10-22T12:00:00Z');
    expect(rateDateFor('2026-02', now)).toBe('2026-02-28');
    expect(rateDateFor('2026-10', now)).toBe('2026-10-22');
  });

  it('takes the ECB working day Frankfurter answers with', async () => {
    const f = answer({ date: '2026-08-28', rates: { GBP: 0.79 } });
    expect(await reportRate('GBP', '2026-08-31', { fetch: f })).toEqual({ code: 'GBP', rate: 0.79, rateDate: '2026-08-28', source: 'ECB via Frankfurter' });
  });

  it('inverts a coin\'s dollar price for the day', async () => {
    const f = answer({ market_data: { current_price: { usd: 50_000 } } });
    const r = await reportRate('BTC', '2026-09-30', { fetch: f });
    expect(f).toHaveBeenCalledWith(expect.stringContaining('/coins/bitcoin/history?date=30-09-2026'), expect.anything());
    expect(r).toMatchObject({ code: 'BTC', rate: 1 / 50_000, rateDate: '2026-09-30' });
  });

  it('falls back to dollars with a reason on any miss', async () => {
    expect((await reportRate('EUR', '2026-09-30', { fetch: answer({}, 503) })).fallbackReason).toBe('EUR unavailable: Frankfurter answered 503');
    expect((await reportRate('EUR', '2026-09-30', { fetch: vi.fn(async () => { throw new TypeError('fetch failed'); }) })).fallbackReason)
      .toBe('EUR unavailable: the rate source could not be reached');
    expect(await reportRate('USD', '2026-09-30')).toEqual({ code: 'USD', rate: 1, rateDate: null, source: null });
  });
});
