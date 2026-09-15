import { describe, it, expect } from 'vitest';
import { render } from '@testing-library/react';
import { ChainBadge, chainTitle } from './ChainBadge';

describe('ChainBadge', () => {
  it('renders each verdict with its own state marker', () => {
    for (const state of ['verified', 'open', 'corrupted', 'unchained'] as const) {
      const { container } = render(<ChainBadge state={state} />);
      const el = container.querySelector('[data-chain-state]')!;
      expect(el.getAttribute('data-chain-state')).toBe(state);
      expect(el.textContent).toContain(state);
    }
  });

  it('names the first break on a corrupted chain', () => {
    const { container } = render(
      <ChainBadge state="corrupted" breaks={2} firstBreak={7} firstBreakReason="hash_mismatch" entries={12} source="recorded" />,
    );
    const el = container.querySelector('[data-chain-state]')!;
    expect(el.textContent).toContain('@7');
    expect(el.getAttribute('title')).toBe(
      'Chain corrupted · 2 breaks · first break at line 7 (hash_mismatch) · 12 lines (recorded)',
    );
  });

  it('shows the root prefix on a verified chain and honest text on the rest', () => {
    expect(chainTitle({ state: 'verified', root: 'abcdef0123456789ff', entries: 1, source: 'live' }))
      .toBe('Chain verified · 1 line · root abcdef012345… (live)');
    expect(chainTitle({ state: 'verified' })).toBe('Chain verified · root ?');
    expect(chainTitle({ state: 'open', entries: 3 })).toBe('Chain intact so far · 3 lines · no closed record yet');
    expect(chainTitle({ state: 'unchained' })).toContain('nothing to verify');
    expect(chainTitle({ state: 'corrupted' })).toBe('Chain corrupted');
  });
});
