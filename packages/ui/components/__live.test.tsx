import { describe, it, expect, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import { TokenSplitCards } from './TokenSplit';

afterEach(() => cleanup());

// Exact payload the live dashboard API returns right now.
const summary = {
  totalCost: 5935.25,
  inputTokens: 800054136,
  outputTokens: 32509871,
  cacheReadTokens: 9266088987,
  cacheWriteTokens: 113121958,
  costSplit: { input: 17.76663, output: 634.5057400000001, cacheRead: 4349.97007375, cacheWrite: 916.32365 },
};

describe('homepage render with live payload', () => {
  it('renders all four tiles without throwing', () => {
    const { container } = render(
      <TokenSplitCards
        tokens={{
          input: summary.inputTokens,
          output: summary.outputTokens,
          cacheRead: summary.cacheReadTokens,
          cacheWrite: summary.cacheWriteTokens,
        }}
        costs={summary.costSplit && { ...summary.costSplit, total: summary.totalCost }}
      />
    );
    console.log('RENDERED:', container.textContent);
    expect(screen.getByText('Input')).toBeTruthy();
    expect(screen.getByText('Cache')).toBeTruthy();
    expect(screen.getByText('Output')).toBeTruthy();
  });
});
