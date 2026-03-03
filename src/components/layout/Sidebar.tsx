'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';

const NAV_ITEMS = [
  { href: '/live', label: 'Live', icon: '*' },
  { href: '/', label: 'Dashboard', icon: '~' },
  { href: '/projects', label: 'Projects', icon: '>' },
  { href: '/thinking', label: 'Thinking', icon: '?' },
  { href: '/logs', label: 'All Logs', icon: '#' },
  { href: '/tokens', label: 'Tokens', icon: '$' },
  { href: '/usage', label: 'Usage Monitor', icon: '!' },
  { href: '/styleguide', label: 'Styleguide', icon: '&' },
];

export function Sidebar() {
  const pathname = usePathname();

  return (
    <aside className="w-56 shrink-0 bg-[var(--color-surface)] border-r border-[var(--color-border)] flex flex-col">
      <div className="p-4 border-b border-[var(--color-border)]">
        <Link href="/" className="block">
          <h1 className="text-sm font-bold text-[var(--color-accent)]">
            claude_sexy_logger
          </h1>
          <p className="text-xs text-[var(--color-muted)] mt-1">session viewer</p>
        </Link>
      </div>
      <nav className="flex-1 p-2">
        {NAV_ITEMS.map((item) => {
          const isActive =
            item.href === '/'
              ? pathname === '/'
              : pathname.startsWith(item.href);
          return (
            <Link
              key={item.href}
              href={item.href}
              className={`flex items-center gap-3 px-3 py-2 rounded text-sm transition-colors ${
                isActive
                  ? 'bg-[var(--color-surface-hover)] text-[var(--color-foreground)]'
                  : 'text-[var(--color-muted)] hover:text-[var(--color-foreground)] hover:bg-[var(--color-surface-hover)]'
              }`}
            >
              <span className="text-[var(--color-accent)] font-bold w-4 text-center">
                {item.icon}
              </span>
              {item.label}
            </Link>
          );
        })}
      </nav>
      <div className="p-4 border-t border-[var(--color-border)] text-xs text-[var(--color-muted)]">
        blackops // local
      </div>
    </aside>
  );
}
