import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import { EmptyState, describeRange } from './EmptyState';

afterEach(() => cleanup());

describe('EmptyState', () => {
  it('says what appears, the action, the command and a link', () => {
    render(
      <EmptyState
        what="Sessions will appear here."
        action="Run a harness session in any git repo:"
        command="cd ~/your/repo && claude"
        link={{ href: '/schema', label: 'Adapter docs' }}
      />,
    );
    expect(screen.getByText('Sessions will appear here.')).toBeInTheDocument();
    expect(screen.getByText('Run a harness session in any git repo:', { exact: false })).toBeInTheDocument();
    const code = screen.getByText('cd ~/your/repo && claude');
    expect(code.tagName).toBe('CODE');
    const a = screen.getByRole('link', { name: 'Adapter docs' });
    expect(a.getAttribute('href')).toBe('/schema');
  });

  it('defaults to first-run and marks its kind for tests and styles', () => {
    const { container } = render(<EmptyState what="Todos will appear here." />);
    expect(container.firstElementChild!.getAttribute('data-empty-kind')).toBe('first-run');
    // A first run with no action says only what will appear — no widen copy.
    expect(container.textContent).not.toMatch(/Widen/);
  });

  it('suggests widening the range when quiet, naming the range', () => {
    const { container } = render(<EmptyState kind="quiet" what="No sessions in range." range="7d" />);
    expect(container.firstElementChild!.getAttribute('data-empty-kind')).toBe('quiet');
    expect(container.textContent).toContain('Nothing landed in last 7 days');
    expect(container.textContent).toContain('Widen our range');
  });

  it('offers the wider range as a button when the page can widen it', () => {
    const widen = vi.fn();
    render(<EmptyState kind="quiet" what="No sessions in range." range="24h" onWiden={widen} />);
    fireEvent.click(screen.getByRole('button', { name: 'Show lifetime' }));
    expect(widen).toHaveBeenCalledOnce();
  });

  it('never shows a widen button on a first run', () => {
    // Widening finds nothing when nothing ever landed.
    render(<EmptyState what="Nothing yet." onWiden={() => {}} />);
    expect(screen.queryByRole('button')).toBeNull();
  });

  it('lets an explicit action replace the quiet default', () => {
    const { container } = render(<EmptyState kind="quiet" what="No matches." action="Clear our search." />);
    expect(container.textContent).toContain('Clear our search.');
    expect(container.textContent).not.toContain('Nothing landed');
  });

  it('opens outside links in a new tab and keeps ours in place', () => {
    render(<EmptyState what="x" link={{ href: 'https://example.com/docs', label: 'Docs' }} />);
    const a = screen.getByRole('link', { name: 'Docs' });
    expect(a.getAttribute('target')).toBe('_blank');
    expect(a.getAttribute('rel')).toBe('noreferrer');
  });

  it('keeps a hash link on this page', () => {
    render(<EmptyState what="x" link={{ href: '#Rules', label: 'Rules' }} />);
    const a = screen.getByRole('link', { name: 'Rules' });
    expect(a.getAttribute('href')).toBe('#Rules');
    expect(a.getAttribute('target')).toBeNull();
  });

  it('uses tokens only, and drops the frame when compact', () => {
    const { container, rerender } = render(<EmptyState what="x" />);
    const cls = container.firstElementChild!.className;
    expect(cls).toContain('border-[var(--color-border)]');
    expect(cls).toContain('bg-[var(--color-surface)]');
    expect(container.innerHTML).not.toMatch(/#[0-9a-f]{3,6}\b/i);
    rerender(<EmptyState what="x" compact />);
    expect(container.firstElementChild!.className).not.toContain('border-dashed');
  });
});

describe('describeRange', () => {
  it('names our time range values in words', () => {
    expect(describeRange('7d')).toBe('last 7 days');
    expect(describeRange('1h')).toBe('last hour');
    expect(describeRange('24h')).toBe('last 24 hours');
    expect(describeRange('180d')).toBe('last 6 months');
    expect(describeRange('365d')).toBe('last year');
    expect(describeRange('all')).toBe('lifetime');
    expect(describeRange(undefined)).toBe('this range');
    expect(describeRange('March 2026')).toBe('March 2026');
  });
});
