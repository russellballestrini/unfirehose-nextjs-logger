import { describe, it, expect, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import {
  TokenSplitCards,
  TokenSplitInline,
  totalOf,
  cacheOf,
  cacheShareOf,
} from './TokenSplit';

afterEach(() => cleanup());

const CLAUDE_SHAPED = { input: 780_220_828, output: 32_533_514, cacheRead: 9_484_921_369, cacheWrite: 109_101_012 };

describe('token arithmetic', () => {
  it('counts every type in the total, cache included', () => {
    expect(totalOf(CLAUDE_SHAPED)).toBe(10_406_776_723);
  });

  it('treats a missing cacheWrite as zero rather than NaN', () => {
    expect(totalOf({ input: 10, output: 5, cacheRead: 100 })).toBe(115);
    expect(cacheOf({ input: 10, output: 5, cacheRead: 100 })).toBe(100);
  });

  it('reports cache as the overwhelming share of a coding-agent workload', () => {
    const share = cacheShareOf(CLAUDE_SHAPED)!;
    expect(share).toBeGreaterThan(0.9);
  });

  it('returns null share when nothing moved, so a fresh install shows no percentage', () => {
    expect(cacheShareOf({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 })).toBeNull();
  });
});

describe('TokenSplitCards', () => {
  it('shows input, cache and output as their own numbers', () => {
    render(<TokenSplitCards tokens={CLAUDE_SHAPED} />);
    expect(screen.getByText('Input')).toBeTruthy();
    expect(screen.getByText('Cache')).toBeTruthy();
    expect(screen.getByText('Output')).toBeTruthy();
    // Cache read + cache write, not cache read alone.
    expect(screen.getByText('9.6B')).toBeTruthy();
  });

  it('prices each type when costs are supplied', () => {
    render(
      <TokenSplitCards
        tokens={CLAUDE_SHAPED}
        costs={{ input: 12.5, output: 158.5, cacheRead: 518.7, cacheWrite: 386.5 }}
      />
    );
    expect(screen.getByText('$12.50')).toBeTruthy();
    expect(screen.getByText('$158.50')).toBeTruthy();
    // Cache read and write priced together on the cache tile.
    expect(screen.getByText(/\$905\.20/)).toBeTruthy();
  });

  it('renders no price at all when cost is unknown — never $0.00', () => {
    const { container } = render(<TokenSplitCards tokens={CLAUDE_SHAPED} />);
    expect(container.textContent).not.toContain('$0.00');
    expect(container.textContent).not.toContain('$');
  });

  it('prices only what it knows when the split is partial', () => {
    const { container } = render(
      <TokenSplitCards tokens={CLAUDE_SHAPED} costs={{ input: 12.5 }} />
    );
    expect(screen.getByText('$12.50')).toBeTruthy();
    // Output price unknown — the output tile stays priceless rather than free.
    expect(container.textContent).not.toContain('$0.00');
  });

  it('honors a caller-supplied cost formatter, so currency settings carry through', () => {
    render(
      <TokenSplitCards
        tokens={CLAUDE_SHAPED}
        costs={{ input: 12.5 }}
        formatCost={(usd) => `€${(usd * 2).toFixed(2)}`}
      />
    );
    expect(screen.getByText('€25.00')).toBeTruthy();
  });

  it('can drop the total tile for surfaces that already show one', () => {
    render(<TokenSplitCards tokens={CLAUDE_SHAPED} showTotal={false} />);
    expect(screen.queryByText('Total Tokens')).toBeNull();
    expect(screen.getByText('Cache')).toBeTruthy();
  });
});

describe('total that the columns cannot account for', () => {
  it('prefers an authoritative total over the sum of the columns', () => {
    // Self-hosted electricity books whole: $16.61 lands in the total and in
    // none of the four columns. Adding the columns understates the page's own
    // cost figure sitting right above this tile.
    render(
      <TokenSplitCards
        tokens={CLAUDE_SHAPED}
        costs={{ input: 14.29, output: 618.44, cacheRead: 4908.52, cacheWrite: 386.50, total: 5944.36 }}
      />
    );
    expect(screen.getByText('$5944.36')).toBeTruthy();
  });

  it('still prices the total when only the authoritative figure is known', () => {
    render(<TokenSplitCards tokens={CLAUDE_SHAPED} costs={{ total: 16.61 }} />);
    expect(screen.getByText('$16.61')).toBeTruthy();
  });

  it('falls back to the column sum when no total is given', () => {
    render(
      <TokenSplitCards
        tokens={CLAUDE_SHAPED}
        costs={{ input: 1, output: 2, cacheRead: 3, cacheWrite: 4 }}
      />
    );
    expect(screen.getByText('$10.00')).toBeTruthy();
  });
});

describe('TokenSplitInline', () => {
  it('puts all three numbers on one line', () => {
    const { container } = render(<TokenSplitInline tokens={CLAUDE_SHAPED} />);
    expect(container.textContent).toContain('in');
    expect(container.textContent).toContain('cache');
    expect(container.textContent).toContain('out');
  });

  it('appends prices only where they exist', () => {
    const { container } = render(
      <TokenSplitInline tokens={CLAUDE_SHAPED} costs={{ cacheRead: 500, cacheWrite: 400 }} />
    );
    expect(container.textContent).toContain('$900.00');
    expect(container.textContent).not.toContain('$0.00');
  });

  it('survives a self-hosted row that reports no cache at all', () => {
    const { container } = render(
      <TokenSplitInline tokens={{ input: 11_690_200, output: 150_260, cacheRead: 0, cacheWrite: 0 }} />
    );
    expect(container.textContent).toContain('cache 0');
  });
});
