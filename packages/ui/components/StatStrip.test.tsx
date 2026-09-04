import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { Stat, StatStrip, costSub, cacheCostOf } from './StatStrip';

describe('costSub', () => {
  it('never renders an unknown cost as free', () => {
    expect(costSub(undefined)).toBe('—');
    expect(costSub(null)).toBe('—');
    expect(costSub(0)).toBe('$0.00');
  });

  it('keeps cents on small figures and drops them on large ones', () => {
    expect(costSub(0.84)).toBe('$0.84');
    expect(costSub(9.99)).toBe('$9.99');
    expect(costSub(4674.57)).toBe('$4,675');
  });
});

describe('cacheCostOf', () => {
  it('sums read and write, and stays undefined when there is no split', () => {
    expect(cacheCostOf({ cacheRead: 1.5, cacheWrite: 2 })).toBe(3.5);
    expect(cacheCostOf({ cacheRead: 1.5 })).toBe(1.5);
    expect(cacheCostOf(undefined)).toBeUndefined();
  });
});

describe('Stat', () => {
  it('renders label, value and sub', () => {
    render(<StatStrip><Stat label="Sessions" value={131} sub="since 42 minutes ago" /></StatStrip>);
    expect(screen.getByText('Sessions')).toBeTruthy();
    expect(screen.getByText('131')).toBeTruthy();
    expect(screen.getByText('since 42 minutes ago')).toBeTruthy();
  });
});
