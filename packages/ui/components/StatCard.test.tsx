import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { StatCard } from './StatCard';

describe('StatCard', () => {
  it('shows its label, value and sub', () => {
    render(<StatCard label="Total Sessions" value="412" sub="+12 today" />);
    expect(screen.getByText('Total Sessions')).toBeInTheDocument();
    expect(screen.getByText('412')).toBeInTheDocument();
    expect(screen.getByText('+12 today')).toBeInTheDocument();
  });

  it('omits the sub line rather than leaving a gap', () => {
    const { container } = render(<StatCard label="Messages" value={0} />);
    // Label and value only — an empty third div would push every card in
    // the row taller than the ones beside it.
    expect(container.firstElementChild!.children).toHaveLength(2);
  });

  it('takes a number as readily as a string', () => {
    render(<StatCard label="Agents" value={3} />);
    expect(screen.getByText('3')).toBeInTheDocument();
  });

  it('reddens the whole card when it is the alarm', () => {
    // The border carries the warning as much as the text: a warn card has to
    // be findable in a grid without reading it.
    const { container } = render(<StatCard label="Rate" value="$8.50/hr" tone="warn" />);
    const card = container.firstElementChild!;
    expect(card.className).toContain('border-[var(--color-error)]');
    expect(screen.getByText('Rate').className).toContain('text-[var(--color-error)]');
    expect(screen.getByText('$8.50/hr').className).toContain('text-[var(--color-error)]');
  });

  it('accents only the value, leaving the card quiet', () => {
    const { container } = render(<StatCard label="Streak" value="7d" tone="accent" />);
    expect(container.firstElementChild!.className).toContain('border-[var(--color-border)]');
    expect(screen.getByText('7d').className).toContain('text-[var(--color-accent)]');
  });

  it('lets a series keep its own colour', () => {
    // Token types carry their chart colour onto the card, so the two read as
    // the same series.
    render(<StatCard label="Cache" value="9.4B" color="#4ade80" />);
    expect(screen.getByText('9.4B')).toHaveStyle({ color: '#4ade80' });
  });

  it('prefers an explicit colour over the tone', () => {
    render(<StatCard label="Spent" value="$12" tone="accent" color="#ef4444" />);
    const value = screen.getByText('$12');
    expect(value).toHaveStyle({ color: '#ef4444' });
    expect(value.className).not.toContain('text-[var(--color-accent)]');
  });

  it('shrinks type and padding when compact', () => {
    const { container } = render(<StatCard label="CPU" value="Ryzen 7" sub="16 cores" compact />);
    expect(container.firstElementChild!.className).toContain('p-3');
    expect(screen.getByText('CPU').className).toContain('text-xs');
    // Long values are common in dense grids — a CPU model must not wrap the row.
    expect(screen.getByText('Ryzen 7').className).toContain('truncate');
  });
});
