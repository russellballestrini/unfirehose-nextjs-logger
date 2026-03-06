'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';

type NavLink = { href: string; label: string; icon: string };
type NavSeparator = { separator: string };
type NavItem = NavLink | NavSeparator;

function isLink(item: NavItem): item is NavLink {
  return 'href' in item;
}

const NAV_ITEMS: NavItem[] = [
  // Monitor — what's happening now
  { separator: 'monitor' },
  { href: '/live', label: 'Live', icon: '●' },
  { href: '/active', label: 'Active', icon: '▸' },
  // Navigate — browse your data
  { separator: 'navigate' },
  { href: '/', label: 'Dashboard', icon: '◇' },
  { href: '/projects', label: 'Projects', icon: '■' },
  { href: '/todos', label: 'Todos', icon: '☰' },
  { href: '/todos/graph', label: 'Graph', icon: '◈' },
  // Analyze — deep dives
  { separator: 'analyze' },
  { href: '/thinking', label: 'Thinking', icon: '◎' },
  { href: '/logs', label: 'All Logs', icon: '≡' },
  { href: '/tokens', label: 'Tokens', icon: '¤' },
  { href: '/usage', label: 'Usage', icon: '△' },
  // Configure
  { separator: 'configure' },
  { href: '/scrobble', label: 'Scrobble', icon: '♪' },
  { href: '/permacomputer', label: 'Permacomputer', icon: '▣' },
  { href: '/bootstrap', label: 'Bootstrap', icon: '⚡' },

  { href: '/schema', label: 'Schema', icon: '{' },
  { href: '/styleguide', label: 'Styleguide', icon: '◐' },
  { href: '/settings', label: 'Settings', icon: '⚙' },
];

const NAV_LINKS = NAV_ITEMS.filter(isLink);

export function Sidebar() {
  const pathname = usePathname();

  return (
    <aside className="w-56 shrink-0 bg-[var(--color-surface)] border-r border-[var(--color-border)] flex flex-col sticky top-0 h-screen overflow-y-auto">
      <div className="px-4 py-6 border-b border-[var(--color-border)]">
        <Link href="/" className="block">
          <h1 className="text-6xl font-black tracking-tighter leading-[0.85]">
            <span className="text-[var(--color-foreground)]">un</span><span className="text-[var(--color-accent)]">fire</span><br />
            <span className="text-[var(--color-accent)]">hose</span>
          </h1>
          <p className="text-xs text-[var(--color-muted)] mt-2 tracking-wide uppercase">nextjs logger</p>
        </Link>
      </div>
      <nav className="flex-1 p-2">
        {NAV_ITEMS.map((item, i) => {
          if (!isLink(item)) {
            return (
              <div
                key={item.separator}
                className={`text-[10px] uppercase tracking-widest text-[var(--color-muted)] px-3 ${i === 0 ? 'pt-1' : 'pt-3'} pb-1 select-none opacity-60`}
              >
                {item.separator}
              </div>
            );
          }
          const isActive =
            item.href === '/'
              ? pathname === '/'
              : pathname === item.href || (pathname.startsWith(item.href + '/') && !NAV_LINKS.some(n => n !== item && n.href.startsWith(item.href + '/') && pathname.startsWith(n.href)));
          return (
            <Link
              key={item.href}
              href={item.href}
              className={`flex items-center gap-3 px-3 py-1.5 rounded text-base transition-colors ${
                isActive
                  ? 'bg-[var(--color-surface-hover)] text-[var(--color-foreground)]'
                  : 'text-[var(--color-muted)] hover:text-[var(--color-foreground)] hover:bg-[var(--color-surface-hover)]'
              }`}
            >
              <span className={`font-bold w-4 text-center ${isActive ? 'text-[var(--color-accent)]' : 'text-[var(--color-border)]'}`}>
                {item.icon}
              </span>
              {item.label}
            </Link>
          );
        })}
      </nav>
      <div className="p-4 border-t border-[var(--color-border)] text-base text-[var(--color-muted)]">
        blackops // local
      </div>
    </aside>
  );
}
