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

  it('the witness overrides a clean chain: a re-hashed rewrite reads rewritten, in red', () => {
    const { container } = render(<ChainBadge state="verified" anchor="rewritten" entries={9} />);
    const el = container.querySelector('[data-chain-state]')!;
    expect(el.textContent).toContain('rewritten');
    expect(el.getAttribute('data-anchor-state')).toBe('rewritten');
    expect(el.getAttribute('title')).toContain('REWRITTEN after ingest');
    const missing = render(<ChainBadge state="verified" anchor="missing" />).container.querySelector('[data-chain-state]')!;
    expect(missing.textContent).toContain('missing');
    const intact = render(<ChainBadge state="verified" anchor="intact" />).container.querySelector('[data-chain-state]')!;
    expect(intact.textContent).toContain('verified');
    expect(intact.getAttribute('title')).toContain('witness: intact');
  });

  it('an unchained transcript the witness holds reads witnessed, not unchained', () => {
    const el = render(<ChainBadge state="unchained" anchor="intact" entries={4} />).container.querySelector('[data-chain-state]')!;
    expect(el.textContent).toContain('witnessed');
    expect(el.getAttribute('title')).toContain('witnessed at ingest and unchanged since');
    const plain = render(<ChainBadge state="unchained" />).container.querySelector('[data-chain-state]')!;
    expect(plain.textContent).toContain('unchained');
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
