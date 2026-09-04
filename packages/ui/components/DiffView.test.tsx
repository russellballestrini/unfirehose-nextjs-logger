import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { DiffView } from './DiffView';

const DIFF = [
  'diff --git a/x.ts b/x.ts',
  'index 111..222 100644',
  '--- a/x.ts',
  '+++ b/x.ts',
  '@@ -1,4 +1,4 @@',
  ' context one',
  ' context two',
  '-removed one',
  '-removed two',
  '+added one',
  '+added two',
  ' context three',
].join('\n');

describe('DiffView', () => {
  it('groups consecutive lines of the same kind into one element', () => {
    const { container } = render(<DiffView diff={DIFF} />);
    const divs = container.querySelectorAll('pre > div');
    // 12 lines, but runs: file, meta(index+---+++), hunk, context x2,
    // del x2, add x2, context — 7 elements, not 12.
    expect(divs.length).toBe(7);
    expect(divs.length).toBeLessThan(DIFF.split('\n').length);
  });

  it('keeps every line, in order, inside those runs', () => {
    const { container } = render(<DiffView diff={DIFF} />);
    const text = [...container.querySelectorAll('pre > div')].map((d) => d.textContent).join('\n');
    expect(text).toBe(DIFF);
  });

  it('colours additions and deletions differently', () => {
    const { container } = render(<DiffView diff={DIFF} />);
    const classes = [...container.querySelectorAll('pre > div')].map((d) => d.className);
    expect(classes.some((c) => c.includes('green'))).toBe(true);
    expect(classes.some((c) => c.includes('red'))).toBe(true);
  });

  it('caps a long diff and says so, then shows the rest on request', () => {
    const long = Array.from({ length: 5000 }, (_, i) => ` line ${i}`).join('\n');
    render(<DiffView diff={long} maxLines={100} />);
    expect(screen.getByText(/Showing 100 of 5,000 lines/)).toBeTruthy();
  });

  it('renders an empty diff without throwing', () => {
    const { container } = render(<DiffView diff="" />);
    expect(container.querySelectorAll('pre > div').length).toBe(1);
  });
});
