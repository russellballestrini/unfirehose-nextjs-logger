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
  { href: '/tmux', label: 'Terminals', icon: '▹' },
  // Navigate — browse your data
  { separator: 'navigate' },
  { href: '/', label: 'Dashboard', icon: '◇' },
  { href: '/projects', label: 'Projects', icon: '■' },
  { href: '/todos', label: 'Todos', icon: '☰' },
  // Analyze — deep dives
  { separator: 'analyze' },
  { href: '/training', label: 'Training', icon: '◆' },
  { href: '/thinking', label: 'Thinking', icon: '◎' },
  { href: '/tokens', label: 'Tokens', icon: '¤' },
  { href: '/usage', label: 'Usage', icon: '△' },
  { href: '/logs', label: 'All Logs', icon: '≡' },
  // Configure
  { separator: 'configure' },
  { href: '/scrobble', label: 'Scrobble', icon: '♪' },
  { href: '/permacomputer', label: 'Permacomputer', icon: '▣' },
  { href: '/schema', label: 'Schema', icon: '{' },
  { href: '/styleguide', label: 'Styleguide', icon: '◐' },
  { href: '/settings', label: 'Settings', icon: '⚙' },
];

const NAV_LINKS = NAV_ITEMS.filter(isLink);

export function Sidebar() {
  const pathname = usePathname();

  return (
    <aside className="w-72 shrink-0 bg-[var(--color-surface)] border-r border-[var(--color-border)] flex flex-col sticky top-0 h-screen overflow-y-auto">
      <div className="px-6 py-8 border-b border-[var(--color-border)]">
        <Link href="/" className="block">
          <h1 className="font-black leading-none whitespace-nowrap" style={{ fontSize: '3.2rem', letterSpacing: '-0.06em', WebkitTextStroke: '0.5px currentColor' }}>
            <span className="text-[var(--color-foreground)]">un</span><span className="text-[var(--color-accent)]">firehose</span>
          </h1>
          <p className="text-base text-[var(--color-muted)] mt-3 tracking-wide uppercase font-bold">nextjs logger</p>
        </Link>
      </div>
      <nav className="flex-1 p-2">
        {NAV_ITEMS.map((item, i) => {
          if (!isLink(item)) {
            return (
              <div
                key={item.separator}
                className={`text-xs uppercase tracking-widest text-[var(--color-muted)] px-3 ${i === 0 ? 'pt-1' : 'pt-3'} pb-1 select-none opacity-60`}
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
                  ? 'bg-[var(--color-accent)]/15 text-[var(--color-accent)]'
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
