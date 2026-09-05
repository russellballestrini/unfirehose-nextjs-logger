// @vitest-environment jsdom
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { renderHook } from '@testing-library/react';

/**
 * The hook that reads which currencies to show.
 *
 * Rates cost a network call, so it only asks for them when something
 * needs converting — a dashboard set to dollars should not be fetching an
 * exchange-rate table every hour to multiply by one.
 */

let settings: Record<string, string> | undefined;
let rates: Record<string, unknown> | undefined;
let asked: (string | null)[];

vi.mock('swr', () => ({
  default: (key: string | null) => {
    asked.push(key);
    return {
      data: key === '/api/settings' ? settings : key ? rates : undefined,
      isLoading: false, error: undefined, mutate: vi.fn(),
    };
  },
}));
vi.mock('./fetcher', () => ({ fetcher: vi.fn() }));

const { useCurrency } = await import('./useCurrency');

beforeEach(() => {
  asked = [];
  settings = { display_currency: 'USD' };
  rates = { fiat: { EUR: 0.92, GBP: 0.79 }, crypto: { BTC: 0.00001 } };
});

describe('useCurrency', () => {
  it('defaults to dollars when nothing was chosen', () => {
    settings = {};
    const { result } = renderHook(() => useCurrency());
    expect(result.current.code).toBe('USD');
    expect(result.current.format(2.5)).toBe('$2.50');
  });

  it('does not fetch rates for a dashboard priced in dollars', () => {
    renderHook(() => useCurrency());
    expect(asked).toContain(null);
  });

  it('fetches rates as soon as one currency needs converting', () => {
    settings = { display_currency: 'EUR' };
    renderHook(() => useCurrency());
    expect(asked).toContain('/api/mesh/rates');
  });

  it('formats in the chosen currency', () => {
    settings = { display_currency: 'EUR' };
    const { result } = renderHook(() => useCurrency());
    expect(result.current.format(10)).toBe('€9.20');
    expect(result.current.rate).toBe(0.92);
  });

  it('shows every chosen currency at once', () => {
    // Somebody paid in one currency and billed in another wants both, and
    // reading them side by side is the point.
    settings = { display_currency: 'USD, EUR, GBP' };
    const { result } = renderHook(() => useCurrency());
    expect(result.current.codes).toEqual(['USD', 'EUR', 'GBP']);
    expect(result.current.formatAll(10)).toBe('$10.00 · €9.20 · £7.90');
  });

  it('takes the first as primary', () => {
    settings = { display_currency: 'GBP,USD' };
    expect(renderHook(() => useCurrency()).result.current.code).toBe('GBP');
  });

  it('finds a crypto rate in its own table', () => {
    settings = { display_currency: 'BTC' };
    expect(renderHook(() => useCurrency()).result.current.format(1)).toBe('₿1.00e-5');
  });

  it('falls back to dollars for a currency with no rate yet', () => {
    // The rates call is still in flight, or that currency is not in the
    // table. Either way a converted-looking figure would be wrong.
    settings = { display_currency: 'ZAR' };
    const { result } = renderHook(() => useCurrency());
    expect(result.current.format(10)).toBe('$10.00');
    expect(result.current.rate).toBe(1);
  });

  it('ignores empty entries in a comma-separated list', () => {
    settings = { display_currency: 'USD,,EUR, ' };
    expect(renderHook(() => useCurrency()).result.current.codes).toEqual(['USD', 'EUR']);
  });
});
