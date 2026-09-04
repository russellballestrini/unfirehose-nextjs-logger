import { describe, it, expect } from 'vitest';
import { formatCurrency, AVAILABLE_CURRENCIES } from './useCurrency';

describe('formatCurrency', () => {
  it('shows dollars as dollars without a rate', () => {
    expect(formatCurrency(12.5, 'USD', 1)).toBe('$12.50');
  });

  it('converts and prefixes the currency symbol', () => {
    expect(formatCurrency(10, 'EUR', 0.9)).toBe('€9.00');
    expect(formatCurrency(10, 'GBP', 0.8)).toBe('£8.00');
  });

  it('falls back to dollars when no rate is known', () => {
    // Showing an unconverted number under a foreign symbol claims a
    // conversion we did not make.
    expect(formatCurrency(10, 'EUR', null)).toBe('$10.00');
  });

  it('keeps four decimals below a cent, where two would read as zero', () => {
    expect(formatCurrency(0.0042, 'USD', 1)).toBe('$0.0042');
    expect(formatCurrency(0.01, 'USD', 1)).toBe('$0.01');
  });

  it('shows nothing as nothing', () => {
    expect(formatCurrency(0, 'USD', 1)).toBe('$0.00');
  });

  it('gives crypto the precision its unit size needs', () => {
    // Two decimals would round most real amounts to zero.
    expect(formatCurrency(100_000, 'BTC', 0.00001)).toBe('₿1.0000');
    expect(formatCurrency(100, 'BTC', 0.00001)).toBe('₿0.001000');
    expect(formatCurrency(1, 'BTC', 0.00000001)).toBe('₿1.00e-8');
  });

  it('falls back to a spaced code for a currency with no symbol', () => {
    expect(formatCurrency(10, 'XXX', 2)).toBe('XXX 20.00');
  });
});

describe('AVAILABLE_CURRENCIES', () => {
  it('carries one row per code', () => {
    const codes = AVAILABLE_CURRENCIES.map((c) => c.code);
    expect(new Set(codes).size).toBe(codes.length);
  });

  it('gives every currency a symbol, so none can silently fall back', () => {
    // The drift this table replaced: a symbol map and a selectable list that
    // disagreed, leaving one currency with a symbol nothing could pick.
    for (const c of AVAILABLE_CURRENCIES) {
      expect(c.symbol, c.code).toBeTruthy();
      expect(c.label, c.code).toBeTruthy();
    }
  });

  it('marks crypto by group, which is what drives its precision', () => {
    const crypto = AVAILABLE_CURRENCIES.filter((c) => c.group === 'Crypto');
    expect(crypto.map((c) => c.code)).toContain('XMR');
    expect(formatCurrency(1, 'XMR', 0.005)).toBe('XMR 0.005000');
  });

  it('leads with the dollar, which everything converts from', () => {
    expect(AVAILABLE_CURRENCIES[0].code).toBe('USD');
  });
});
