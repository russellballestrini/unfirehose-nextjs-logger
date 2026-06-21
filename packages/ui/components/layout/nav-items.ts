// Single source of truth for the nav.
// Sidebar (client) and the sitemap route (server) and the styleguide route
// inventory all import from here. Keep this file free of React + 'use client'
// so it stays safe to import from server components.

export type NavLink = {
  href: string;
  label: string;
  icon: string;
  /** Only render when NODE_ENV !== 'production'. */
  dev?: boolean;
};
export type NavSeparator = { separator: string };
export type NavItem = NavLink | NavSeparator;

export function isLink(item: NavItem): item is NavLink {
  return 'href' in item;
}

export const NAV_ITEMS: NavItem[] = [
  // Monitor — what's happening now
  { separator: 'monitor' },
  { href: '/live', label: 'Live', icon: '●' },
  { href: '/active', label: 'Active', icon: '▸' },
  { href: '/tmux', label: 'Terminals', icon: '▹' },
  // Navigate — browse your data
  { separator: 'navigate' },
  { href: '/', label: 'Dashboard', icon: '◇' },
  { href: '/projects', label: 'Projects', icon: '■' },
  // Hot projects injected here dynamically by Sidebar
  { href: '/todos', label: 'Todos', icon: '☰' },
  // Analyze — deep dives
  { separator: 'analyze' },
  { href: '/tokens', label: 'Tokens', icon: '¤' },
  { href: '/usage', label: 'Usage', icon: '△' },
  { href: '/logs', label: 'All Logs', icon: '≡' },
  // Configure
  { separator: 'configure' },
  { href: '/scrobble', label: 'Scrobble', icon: '♪' },
  { href: '/permacomputer', label: 'Permacomputer', icon: '▣' },
  { href: '/schema', label: 'Schema', icon: '{' },
  { href: '/settings', label: 'Settings', icon: '⚙' },
  // Dev — local-only tools, hidden in production builds
  { separator: 'dev' },
  { href: '/db', label: 'Database', icon: '▤', dev: true },
  { href: '/styleguide', label: 'Styleguide', icon: '◐', dev: true },
];

/** All NavLink entries that pass the production filter. */
export function visibleNavLinks(isProduction: boolean): NavLink[] {
  return NAV_ITEMS.filter(isLink).filter((l) => !(l.dev && isProduction));
}

/**
 * Group NavItems by the preceding separator. Returns one entry per group
 * in NAV_ITEMS order. The dev separator group is dropped when filtered
 * out by NODE_ENV.
 */
export function groupNavItems(isProduction: boolean): { section: string; links: NavLink[] }[] {
  const groups: { section: string; links: NavLink[] }[] = [];
  let current: { section: string; links: NavLink[] } | null = null;
  for (const item of NAV_ITEMS) {
    if (!isLink(item)) {
      if (current && current.links.length > 0) groups.push(current);
      current = { section: item.separator, links: [] };
      continue;
    }
    if (item.dev && isProduction) continue;
    if (!current) current = { section: 'misc', links: [] };
    current.links.push(item);
  }
  if (current && current.links.length > 0) groups.push(current);
  return groups;
}
