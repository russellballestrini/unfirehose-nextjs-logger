'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import useSWR from 'swr';
import { NAV_ITEMS, isLink, visibleNavLinks, type NavLink } from './nav-items';

const fetcher = (url: string) =>
  fetch(url).then(async (r) => {
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return r.json();
  });

const IS_PRODUCTION = process.env.NODE_ENV === 'production';
const VISIBLE_NAV_ITEMS = NAV_ITEMS.filter((i) => isLink(i) ? !(i.dev && IS_PRODUCTION) : true);
const NAV_LINKS = visibleNavLinks(IS_PRODUCTION);

// Extract short display name from project name or display_name
function shortName(name: string, displayName?: string): string {
  const raw = displayName || name;
  const parts = raw.replace(/^\[.*?\]\s*/, '').split(/[/\\]/);
  const last = parts[parts.length - 1] || raw;
  return last.length > 20 ? last.slice(0, 18) + '..' : last;
}

/**
 * Our navigation. From `lg` (1024px) up it is a column beside the page; below
 * that, on phones and portrait tablets, it would leave a page 87px wide at
 * 375, so it folds into a drawer behind a menu button in a top bar. The
 * drawer closes on navigation, on Escape and on a tap outside it.
 */
export function Sidebar() {
  const pathname = usePathname();
  const [open, setOpen] = useState(false);

  // A link tapped in our drawer lands on a new page; the drawer should not
  // still be covering it.
  useEffect(() => { setOpen(false); }, [pathname]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
    globalThis.addEventListener('keydown', onKey);
    return () => globalThis.removeEventListener('keydown', onKey);
  }, [open]);

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data: activityData } = useSWR<any[]>('/api/projects/activity?days=7', fetcher, { refreshInterval: 30000 });
  // Defensive: if API errors or returns a non-array shape (e.g. error object),
  // fall back to empty so the navbar never crashes on every page render.
  const hotProjects = Array.isArray(activityData) ? activityData.slice(0, 5) : [];

  function renderNavLink(item: NavLink) {
    const isActive =
      item.href === '/'
        ? pathname === '/'
        : pathname === item.href || (pathname.startsWith(item.href + '/') && !NAV_LINKS.some(n => n !== item && n.href.startsWith(item.href + '/') && pathname.startsWith(n.href)));
    return (
      <Link
        key={item.href}
        href={item.href}
        className={`flex items-center gap-3 px-3 py-2 lg:py-1.5 min-h-10 lg:min-h-0 rounded text-base transition-colors ${
          isActive
            ? 'bg-[var(--color-accent)]/15 text-[var(--color-accent)]'
            : 'text-[var(--color-muted)] hover:text-[var(--color-foreground)] hover:bg-[var(--color-accent)]/8'
        }`}
      >
        <span className={`font-bold w-4 text-center ${isActive ? 'text-[var(--color-accent)]' : 'text-[var(--color-border)]'}`}>
          {item.icon}
        </span>
        {item.label}
      </Link>
    );
  }

  return (
    <>
    <header
      data-mobile-bar
      className="lg:hidden shrink-0 grid grid-cols-[auto_1fr] items-center gap-3 px-2 h-14 bg-[var(--color-surface)] border-b border-[var(--color-border)]"
    >
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-label={open ? 'Close menu' : 'Open menu'}
        aria-expanded={open}
        aria-controls="site-nav"
        className="w-11 h-11 grid place-items-center rounded text-2xl leading-none text-[var(--color-foreground)] hover:bg-[var(--color-surface-hover)] cursor-pointer"
      >
        {open ? '\u00d7' : '\u2630'}
      </button>
      <Link href="/" className="block py-2 font-black leading-none text-2xl whitespace-nowrap" style={{ letterSpacing: '-0.04em' }}>
        <span className="text-[var(--color-foreground)]">un</span><span className="text-[var(--color-accent)]">firehose</span>
      </Link>
    </header>
    {open && (
      <div
        data-nav-backdrop
        aria-hidden="true"
        onClick={() => setOpen(false)}
        className="lg:hidden fixed inset-0 z-40 bg-black/60"
      />
    )}
    <aside
      id="site-nav"
      data-open={open ? 'true' : 'false'}
      className={`w-72 max-w-[85vw] shrink-0 bg-[var(--color-surface)] border-r border-[var(--color-border)] flex flex-col h-screen overflow-y-auto
        fixed inset-y-0 left-0 z-50 transition-[translate,visibility] duration-200 ease-out ${open ? 'translate-x-0' : '-translate-x-full invisible lg:visible'}
        lg:sticky lg:top-0 lg:z-auto lg:translate-x-0 lg:max-w-none`}
    >
      <div className="px-6 py-8 border-b border-[var(--color-border)]">
        <Link href="/" className="block">
          <h1 className="font-black leading-none whitespace-nowrap" style={{ fontSize: '3.2rem', letterSpacing: '-0.06em', WebkitTextStroke: '0.5px currentColor' }}>
            <span className="text-[var(--color-foreground)]">un</span><span className="text-[var(--color-accent)]">firehose</span>
          </h1>
          <p className="text-base text-[var(--color-muted)] mt-3 tracking-wide uppercase font-bold">nextjs logger</p>
        </Link>
      </div>
      <nav className="flex-1 p-2">
        {VISIBLE_NAV_ITEMS.map((item, i) => {
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

          const node = renderNavLink(item);

          // Inject hot projects right after the Projects link
          if (item.href === '/projects' && hotProjects.length > 0) {
            return (
              <div key="projects-group">
                {node}
                {hotProjects.map((p: { name: string; display_name?: string }) => {
                  const href = `/projects/${encodeURIComponent(p.name)}`;
                  const active = pathname === href || pathname.startsWith(href + '/');
                  return (
                    <Link
                      key={p.name}
                      href={href}
                      className={`flex items-center gap-2 pl-8 pr-3 py-2 lg:py-0.5 min-h-10 lg:min-h-0 rounded text-sm transition-colors truncate ${
                        active
                          ? 'text-[var(--color-accent)]'
                          : 'text-[var(--color-muted)] opacity-70 hover:opacity-100 hover:text-[var(--color-foreground)]'
                      }`}
                      title={p.display_name || p.name}
                    >
                      <span className="truncate">{shortName(p.name, p.display_name)}</span>
                    </Link>
                  );
                })}
              </div>
            );
          }

          return node;
        })}
      </nav>
      <div className="p-4 border-t border-[var(--color-border)] text-base text-[var(--color-muted)]">
        blackops // local
      </div>
    </aside>
    </>
  );
}
