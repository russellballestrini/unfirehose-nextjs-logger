// @vitest-environment jsdom
import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, screen, cleanup, act } from '@testing-library/react';
import { Donut } from './Donut';

/**
 * The React half of our donut. The canvas is a no-op under jsdom (see the
 * test setup), so what is under test is the wrapper's own decisions: the
 * order and folding of the legend, the total in the hole, the hover readout,
 * and that the chart is torn down with the component.
 */

afterEach(cleanup);
const fmt = (v: number) => `${v}t`;
const shares = (...vals: number[]) => vals.map((v, i) => ({ name: `m${i}`, value: v, color: `#${i}${i}${i}` }));

describe('Donut', () => {
  it('draws one canvas and lists every slice beneath it, biggest first', () => {
    render(<Donut data={shares(5, 50, 20)} format={fmt} />);
    expect(document.querySelectorAll('canvas')).toHaveLength(1);
    const names = [...document.querySelectorAll('li')].map((li) => li.textContent?.slice(0, 2));
    expect(names).toEqual(['m1', 'm2', 'm0']);
  });

  it('prints each value with the caller\'s format', () => {
    render(<Donut data={shares(75, 25)} format={fmt} />);
    expect(screen.getByText('75t')).toBeTruthy();
  });

  it('folds the tail into one "other" slice', () => {
    render(<Donut data={shares(...Array.from({ length: 12 }, (_, i) => 12 - i))} format={fmt} topN={3} />);
    const items = document.querySelectorAll('li');
    expect(items).toHaveLength(4);
    expect(items[3].textContent).toContain('other (9)');
  });

  it('leaves out zero rows', () => {
    render(<Donut data={shares(10, 0, 5)} format={fmt} />);
    expect(document.querySelectorAll('li')).toHaveLength(2);
  });

  it('says so, with no canvas, when there is nothing to share', () => {
    render(<Donut data={[]} format={fmt} />);
    expect(screen.getByText('nothing yet')).toBeTruthy();
    expect(document.querySelector('canvas')).toBeNull();
  });

  it('shows the full name on hover when the label is an abbreviation', () => {
    render(<Donut data={[{ name: 'opus', fullName: 'claude-opus-4-6-20260301', value: 1, color: '#000' }]} format={fmt} />);
    expect(screen.getByTitle('claude-opus-4-6-20260301')).toBeTruthy();
  });

  it('does not rebuild the chart when equal data arrives as a new array', () => {
    // SWR hands back a fresh object on every poll. Tearing the canvas down
    // and up for identical numbers is a flicker every few seconds.
    const { rerender } = render(<Donut data={shares(1, 2)} format={fmt} />);
    const first = document.querySelector('canvas');
    rerender(<Donut data={shares(1, 2)} format={fmt} />);
    expect(document.querySelector('canvas')).toBe(first);
  });

  it('rebuilds when the numbers change', () => {
    const { rerender } = render(<Donut data={shares(1, 2)} format={fmt} />);
    const first = document.querySelector('canvas');
    rerender(<Donut data={shares(1, 3)} format={fmt} />);
    expect(document.querySelector('canvas')).not.toBe(first);
  });

  it('removes the canvas on unmount', () => {
    const { unmount } = render(<Donut data={shares(1, 2)} format={fmt} />);
    unmount();
    expect(document.querySelector('canvas')).toBeNull();
  });
});
