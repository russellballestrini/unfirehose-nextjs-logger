// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';

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
  it('renders all navigation items', () => {
    render(<Sidebar />);
    expect(screen.getByText('Live')).toBeTruthy();
    expect(screen.getByText('Active')).toBeTruthy();
    expect(screen.getByText('Terminals')).toBeTruthy();
    expect(screen.getByText('Dashboard')).toBeTruthy();
    expect(screen.getByText('Projects')).toBeTruthy();
    expect(screen.getByText('Todos')).toBeTruthy();
    expect(screen.getByText('Thinking')).toBeTruthy();
    expect(screen.getByText('All Logs')).toBeTruthy();
    expect(screen.getByText('Tokens')).toBeTruthy();
    expect(screen.getByText('Usage')).toBeTruthy();
    expect(screen.getByText('Scrobble')).toBeTruthy();
    expect(screen.getByText('Permacomputer')).toBeTruthy();
    expect(screen.getByText('Schema')).toBeTruthy();
    expect(screen.getByText('Styleguide')).toBeTruthy();
    expect(screen.getByText('Settings')).toBeTruthy();
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
