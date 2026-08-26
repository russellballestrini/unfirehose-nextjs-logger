// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
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
    expect(screen.getByText('firehose', { exact: false })).toBeTruthy();
  });

  it('renders correct href for nav items', () => {
    render(<Sidebar />);
    const liveLink = screen.getByText('Live').closest('a');
    expect(liveLink?.getAttribute('href')).toBe('/live');
    const projectsLink = screen.getByText('Projects').closest('a');
    expect(projectsLink?.getAttribute('href')).toBe('/projects');
  });
});
