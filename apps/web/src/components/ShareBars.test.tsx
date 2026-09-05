// @vitest-environment jsdom
import { describe, it, expect, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import { ShareBars } from './ShareBars';

/**
 * Shares of a whole, as a list of bars — the candidate replacement for the
 * model-share donuts, which uPlot cannot draw and recharts charges 326KB
 * for. What a pie is asked is "which matter and by how much"; these tests
 * pin that this answers it in order and with the numbers.
 */

afterEach(cleanup);
const fmt = (v: number) => `${v}t`;
const rows = (...vals: number[]) => vals.map((v, i) => ({ name: `m${i}`, value: v, color: '#000' }));

describe('ShareBars', () => {
  it('lists the biggest first', () => {
    render(<ShareBars data={rows(5, 50, 20)} format={fmt} />);
    const names = screen.getAllByRole('listitem').map((el) => el.textContent?.slice(0, 2));
    expect(names).toEqual(['m1', 'm2', 'm0']);
  });

  it('prints the share and the value beside each bar', () => {
    render(<ShareBars data={rows(75, 25)} format={fmt} />);
    const [top] = screen.getAllByRole('listitem');
    expect(top.textContent).toContain('75%');
    expect(top.textContent).toContain('75t');
  });

  it('draws the head at full width and the rest against it', () => {
    // Relative to the largest, not to the total: a head that is 40% of
    // everything still fills the row, and the eye reads the others off it.
    render(<ShareBars data={rows(40, 20)} format={fmt} />);
    const bars = document.querySelectorAll('[role=listitem] span span.block') as NodeListOf<HTMLElement>;
    expect(bars[0].style.width).toBe('100%');
    expect(bars[1].style.width).toBe('50%');
  });

  it('folds the long tail into one "other" row', () => {
    render(<ShareBars data={rows(...Array.from({ length: 12 }, (_, i) => 12 - i))} format={fmt} topN={3} />);
    const items = screen.getAllByRole('listitem');
    expect(items).toHaveLength(4);
    expect(items[3].textContent).toContain('other (9)');
  });

  it('never shows a bare 0% for something that exists', () => {
    render(<ShareBars data={rows(1000, 1)} format={fmt} />);
    expect(screen.getAllByRole('listitem')[1].textContent).toContain('<1%');
  });

  it('leaves out zero rows, which a pie would draw as nothing anyway', () => {
    render(<ShareBars data={rows(10, 0, 5)} format={fmt} />);
    expect(screen.getAllByRole('listitem')).toHaveLength(2);
  });

  it('says so when there is nothing to share', () => {
    render(<ShareBars data={[]} format={fmt} />);
    expect(screen.getByText('nothing yet')).toBeTruthy();
  });

  it('shows the full name on hover when the label is an abbreviation', () => {
    render(<ShareBars data={[{ name: 'opus-4-6', fullName: 'claude-opus-4-6-20260301', value: 1, color: '#000' }]} format={fmt} />);
    expect(screen.getByRole('listitem').getAttribute('title')).toBe('claude-opus-4-6-20260301');
  });
});
