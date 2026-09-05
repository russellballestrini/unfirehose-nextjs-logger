// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { render, cleanup, renderHook, act } from '@testing-library/react';
import {
  TIME_RANGE_OPTIONS, getTimeRangeMinutes, getTimeRangeFrom, useTimeRange, TimeRangeSelect,
} from './TimeRangeSelect';

/**
 * The range control every page carries.
 *
 * Its value is remembered per page, and the remembering is where it has to
 * be careful: legacy keys were written as bare strings rather than JSON,
 * so a stored value that will not parse is still accepted when it names a
 * range we know. A page that reset to its default on every visit for
 * everyone who used it before that change would look broken to exactly the
 * people who use it most.
 */

beforeEach(() => localStorage.clear());
afterEach(cleanup);

describe('getTimeRangeMinutes', () => {
  it('converts each range to minutes', () => {
    expect(getTimeRangeMinutes('1h')).toBe(60);
    expect(getTimeRangeMinutes('24h')).toBe(1440);
    expect(getTimeRangeMinutes('7d')).toBe(10080);
  });

  it('reads lifetime as no bound rather than as zero minutes', () => {
    // Callers treat 0 as "no cutoff"; returning a number would query a
    // window of nothing.
    expect(getTimeRangeMinutes('all')).toBe(0);
  });

  it('reads a range it does not know as no bound', () => {
    expect(getTimeRangeMinutes('since-tuesday')).toBe(0);
  });
});

describe('getTimeRangeFrom', () => {
  it('gives a timestamp that far back', () => {
    const from = Date.parse(getTimeRangeFrom('1h')!);
    expect(Date.now() - from).toBeGreaterThan(59 * 60_000);
    expect(Date.now() - from).toBeLessThan(61 * 60_000);
  });

  it('gives nothing for lifetime, so the query has no lower bound', () => {
    expect(getTimeRangeFrom('all')).toBeUndefined();
    expect(getTimeRangeFrom('nonsense')).toBeUndefined();
  });
});

describe('useTimeRange', () => {
  it('starts at the default it was given', () => {
    const { result } = renderHook(() => useTimeRange('k', '24h'));
    expect(result.current[0]).toBe('24h');
  });

  it('remembers a choice', () => {
    const { result, rerender } = renderHook(() => useTimeRange('k', '24h'));
    act(() => { result.current[1]('7d'); });
    rerender();
    expect(result.current[0]).toBe('7d');
    expect(localStorage.getItem('k')).toContain('7d');
  });

  it('accepts a legacy value stored as a bare string', () => {
    // Written before these were JSON. Rejecting them resets the range for
    // everyone who used the page before that change.
    localStorage.setItem('k', '7d');
    const { result } = renderHook(() => useTimeRange('k', '24h'));
    expect(result.current[0]).toBe('7d');
  });

  it('falls back to the default for a range that no longer exists', () => {
    // Options have been removed before, and a stored value naming one
    // would otherwise query a window nothing understands.
    localStorage.setItem('k', JSON.stringify('since-tuesday'));
    const { result } = renderHook(() => useTimeRange('k', '24h'));
    expect(result.current[0]).toBe('24h');
  });

  it('keeps one page range from another', () => {
    localStorage.setItem('a', JSON.stringify('1h'));
    const { result } = renderHook(() => useTimeRange('b', '7d'));
    expect(result.current[0]).toBe('7d');
  });
});

describe('TimeRangeSelect', () => {
  it('offers every range', () => {
    const { container } = render(<TimeRangeSelect value="7d" onChange={() => {}} />);
    const labels = [...container.querySelectorAll('option, button')].map(e => e.textContent?.trim());
    for (const o of TIME_RANGE_OPTIONS) expect(labels).toContain(o.label);
  });

  it('reports the range that was picked', () => {
    let picked = '';
    const { container } = render(
      <TimeRangeSelect value="7d" onChange={(v) => { picked = v; }} />,
    );
    const select = container.querySelector('select');
    if (select) {
      select.value = '1h';
      select.dispatchEvent(new Event('change', { bubbles: true }));
    } else {
      const btn = [...container.querySelectorAll('button')].find(b => b.textContent?.trim() === '1h');
      (btn as HTMLElement)?.click();
    }
    expect(picked).toBe('1h');
  });
});
