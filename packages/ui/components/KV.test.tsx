import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { KV, MiniStat } from './KV';

describe('KV', () => {
  it('shows a label and its value', () => {
    render(<KV label="Kernel" value="6.8.0-generic" />);
    expect(screen.getByText('6.8.0-generic')).toBeInTheDocument();
  });

  it('says n/a when there is no reading', () => {
    // On a detail panel the absence of a reading is itself information
    // about the probe, so it gets a row.
    const { container } = render(<KV label="Uplink" value={null} />);
    expect(container.textContent).toContain('n/a');
  });

  it('hides the row instead when asked', () => {
    // On a service panel a field that does not apply is noise.
    const { container } = render(<KV label="Command" value={null} hideEmpty />);
    expect(container.firstChild).toBeNull();
  });

  it('still renders a row for a real zero', () => {
    // 0 is a value. Treating it as empty is the classic falsy bug.
    const { container } = render(<KV label="Errors" value={0} hideEmpty />);
    expect(container.textContent).toContain('0');
  });
});

describe('MiniStat', () => {
  it('puts label and figure on one line', () => {
    render(<MiniStat label="nodes" value={5} />);
    expect(screen.getByText('nodes')).toBeInTheDocument();
    expect(screen.getByText('5')).toBeInTheDocument();
  });

  it('accents the figure when asked, never the label', () => {
    render(<MiniStat label="watts" value="387W" accent />);
    expect(screen.getByText('387W').className).toContain('text-[var(--color-accent)]');
    expect(screen.getByText('watts').className).not.toContain('text-[var(--color-accent)]');
  });
});
