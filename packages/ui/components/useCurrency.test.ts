import { describe, it, expect } from 'vitest';
import { formatCurrency, AVAILABLE_CURRENCIES } from './useCurrency';

/**
 * Showing a cost in the currency somebody thinks in.
 *
 * Two things have to hold. A converted figure must never be shown without
 * a live rate — a dollar amount under a foreign symbol is a lie, not a
 * rounding error — and a fraction of a cent must not round to zero, since
 * most single-request costs are exactly that and a page of 0.00 says the
 * work was free.
 */

describe('formatCurrency', () => {
  it('shows dollars as dollars', () => {
    expect(formatCurrency(2.5, 'USD', null)).toBe('$2.50');
    expect(formatCurrency(2.5, 'USD', 0.92)).toBe('$2.50');
  });

  it('converts at the rate it was given', () => {
    expect(formatCurrency(10, 'EUR', 0.92)).toBe('€9.20');
  });

  it('falls back to dollars when there is no rate', () => {
    // Showing an unconverted figure under a euro sign is a wrong number,
    // not a missing one.
    expect(formatCurrency(10, 'EUR', null)).toBe('$10.00');
  });

  it('names a currency it has no symbol for rather than dropping it', () => {
    expect(formatCurrency(10, 'XYZ', 2)).toBe('XYZ 20.00');
  });

  it('keeps four decimals below a cent, which most requests are', () => {
    // Two decimals would show every small amount as 0.00, and a page of
    // zeroes reads as work that was free.
    expect(formatCurrency(0.0042, 'USD', null)).toBe('$0.0042');
    expect(formatCurrency(0.01, 'USD', null)).toBe('$0.01');
  });

  it('shows a genuine zero as zero', () => {
    expect(formatCurrency(0, 'USD', null)).toBe('$0.00');
  });

  it('gives crypto the precision it needs to be a number at all', () => {
    // At current rates a request costs about 0.00000002 BTC. Two decimals
    // is not a rounding choice there, it is the whole value.
    expect(formatCurrency(1, 'BTC', 0.00001)).toBe('₿1.00e-5');
    expect(formatCurrency(1, 'BTC', 0.5)).toBe('₿0.5000');
    expect(formatCurrency(10, 'BTC', 0.5)).toBe('₿5.0000');
  });

  it('does not treat crypto specially without a rate', () => {
    expect(formatCurrency(1, 'BTC', null)).toBe('$1.00');
  });
});

describe('AVAILABLE_CURRENCIES', () => {
  it('gives every currency a code, a label, a group and a symbol', () => {
    // This list used to be three parallel tables that had already drifted:
    // FJD carried a symbol and appeared in no list, so nothing could
    // select it. One row per currency makes that unrepresentable.
    for (const c of AVAILABLE_CURRENCIES) {
      expect(c.code, c.code).toMatch(/^[A-Z]{3,5}$/);
      expect(c.label, c.code).toBeTruthy();
      expect(c.symbol, c.code).toBeTruthy();
      expect(c.group, c.code).toBeTruthy();
    }
  });

  it('lists each code once', () => {
    const codes = AVAILABLE_CURRENCIES.map(c => c.code);
    expect(codes).toEqual([...new Set(codes)]);
  });

  it('formats every currency it offers with that currency\'s own symbol', () => {
    // A code the formatter has no symbol for falls back to printing the
    // code, which is legible but is not what the picker promised.
    for (const c of AVAILABLE_CURRENCIES) {
      expect(formatCurrency(1, c.code, 1), c.code).toContain(c.symbol);
    }
  });

  it('leads with the dollar, which everything is priced in', () => {
    expect(AVAILABLE_CURRENCIES[0].code).toBe('USD');
  });
});
