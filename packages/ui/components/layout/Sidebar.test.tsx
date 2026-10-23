// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent } from '@testing-library/react';
import { NAV_ITEMS, isLink } from './nav-items';

vi.mock('next/navigation', () => ({
  usePathname: vi.fn().mockReturnValue('/'),
}));

vi.mock('next/link', () => ({
  default: ({ children, href, ...props }: { children: React.ReactNode; href: string; [key: string]: unknown }) => (
    <a href={href} {...props}>{children}</a>
  ),
}));

const { Sidebar } = await import('./Sidebar');

afterEach(() => cleanup());

describe('Sidebar', () => {
  // Driven from NAV_ITEMS rather than a hand-copied list of labels. The copy
  // had drifted: it required a 'Thinking' item this nav has never declared,
  // so the suite reported a broken sidebar for a link that does not exist,
  // while genuinely missing items like 'Rate Limits' went unasserted because
  // nobody remembered to add them. Reading the source means a new link is
  // covered when it is added and a removed one stops being demanded.
  it('renders every declared navigation item', () => {
    render(<Sidebar />);
    const labels = NAV_ITEMS.filter(isLink).map((l) => l.label);
    expect(labels.length).toBeGreaterThan(0);
    for (const label of labels) {
      expect(screen.queryByText(label), `nav item "${label}" did not render`)
        .toBeTruthy();
    }
  });

  it('renders the app title', () => {
    render(<Sidebar />);
    expect(screen.getAllByText('firehose', { exact: false }).length).toBeGreaterThan(0);
  });

  // Below lg our sidebar is a drawer; the menu button in the top bar opens
  // it, and Escape or a tap on the backdrop closes it again.
  it('opens and closes the phone drawer from the menu button', () => {
    const { container } = render(<Sidebar />);
    const aside = container.querySelector('#site-nav')!;
    const button = screen.getByRole('button', { name: 'Open menu' });
    expect(aside.getAttribute('data-open')).toBe('false');
    expect(button.getAttribute('aria-expanded')).toBe('false');

    fireEvent.click(button);
    expect(aside.getAttribute('data-open')).toBe('true');
    expect(screen.getByRole('button', { name: 'Close menu' }).getAttribute('aria-expanded')).toBe('true');

    fireEvent.keyDown(window, { key: 'Escape' });
    expect(aside.getAttribute('data-open')).toBe('false');

    fireEvent.click(screen.getByRole('button', { name: 'Open menu' }));
    fireEvent.click(container.querySelector('[data-nav-backdrop]')!);
    expect(aside.getAttribute('data-open')).toBe('false');
    expect(container.querySelector('[data-nav-backdrop]')).toBeNull();
  });

  it('renders correct href for nav items', () => {
    render(<Sidebar />);
    const liveLink = screen.getByText('Live').closest('a');
    expect(liveLink?.getAttribute('href')).toBe('/live');
    const projectsLink = screen.getByText('Projects').closest('a');
    expect(projectsLink?.getAttribute('href')).toBe('/projects');
  });
});
