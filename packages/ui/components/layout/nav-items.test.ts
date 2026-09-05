import { describe, it, expect } from 'vitest';
import { NAV_ITEMS, isLink, groupNavItems, type NavLink } from './nav-items';
import fs from 'fs';
import path from 'path';

/**
 * The nav, which three places read.
 *
 * Our sidebar, the sitemap route and the styleguide inventory all import
 * this list, so a page missing from it is a page nobody can reach and
 * nothing reports. That is what these check — every entry points at a page
 * that exists, and every page worth reaching is in the list.
 */

const links = NAV_ITEMS.filter(isLink) as NavLink[];
const appDir = path.resolve(__dirname, '../../../../apps/web/src/app');

/** Route paths Next would serve, from the files on disk. */
function routes(dir = appDir, prefix = ''): string[] {
  const out: string[] = [];
  // The root page sits directly in app/, so the walk below never sees it.
  if (dir === appDir && fs.existsSync(path.join(dir, 'page.tsx'))) out.push('/');
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (!e.isDirectory()) continue;
    if (e.name.startsWith('_') || e.name === 'api') continue;
    const seg = /^\(.*\)$/.test(e.name) ? '' : `/${e.name}`;
    const child = path.join(dir, e.name);
    if (fs.existsSync(path.join(child, 'page.tsx'))) out.push(`${prefix}${seg}` || '/');
    out.push(...routes(child, `${prefix}${seg}`));
  }
  return out;
}

describe('isLink', () => {
  it('tells a link from a separator', () => {
    expect(isLink({ href: '/live', label: 'Live', icon: '●' })).toBe(true);
    expect(isLink({ separator: 'monitor' })).toBe(false);
  });
});

describe('NAV_ITEMS', () => {
  it('gives every link a label and an icon', () => {
    // The sidebar collapses to icons only, so a link without one is a
    // blank row that still navigates somewhere.
    for (const l of links) {
      expect(l.label, l.href).toBeTruthy();
      expect(l.icon, l.href).toBeTruthy();
    }
  });

  it('names every href once', () => {
    const hrefs = links.map(l => l.href);
    expect(hrefs).toEqual([...new Set(hrefs)]);
  });

  it('points every link at a page that exists', () => {
    // A link to a route nobody built is a 404 reachable from every page.
    const built = new Set(routes());
    const dead = links
      .filter(l => !l.href.includes('['))
      .map(l => l.href)
      .filter(h => !built.has(h));
    expect(dead).toEqual([]);
  });

  it('starts each group with a separator', () => {
    // The groups are what make sixteen links readable.
    expect(NAV_ITEMS[0]).toHaveProperty('separator');
  });

  it('marks development-only entries rather than shipping them', () => {
    // The styleguide is for us. Anything flagged dev must still be a real
    // page, since we open it.
    const built = new Set(routes());
    for (const l of links.filter(l => l.dev)) {
      expect(built.has(l.href), l.href).toBe(true);
    }
  });

  it('reaches every page a person would look for', () => {
    // Not every route belongs in the nav — detail pages are reached from
    // a list — but a top-level page that nothing links to is invisible.
    const linked = new Set(links.map(l => l.href));
    const topLevel = routes().filter(r => r !== '/' && r.split('/').length === 2 && !r.includes('['));
    const unreachable = topLevel.filter(r => !linked.has(r));
    expect(unreachable).toEqual([]);
  });
});


describe('groupNavItems', () => {
  it('turns the flat list into the sections the sidebar draws', () => {
    const groups = groupNavItems(false);
    expect(groups.length).toBeGreaterThan(1);
    expect(groups[0].section).toBe('monitor');
    expect(groups.every(g => g.links.length > 0)).toBe(true);
  });

  it('hides development-only entries in production', () => {
    // The styleguide is for us. It is a page of component swatches, and
    // shipping it in the nav is shipping a tour of our own internals.
    const dev = groupNavItems(false).flatMap(g => g.links).map(l => l.href);
    const prod = groupNavItems(true).flatMap(g => g.links).map(l => l.href);
    expect(prod.length).toBeLessThan(dev.length);
    for (const l of NAV_ITEMS.filter(isLink).filter(l => (l as NavLink).dev)) {
      expect(prod).not.toContain((l as NavLink).href);
      expect(dev).toContain((l as NavLink).href);
    }
  });

  it('drops a section that has nothing left in it', () => {
    // A heading over an empty list is a section that looks broken rather
    // than one that is empty on purpose.
    for (const g of groupNavItems(true)) expect(g.links.length).toBeGreaterThan(0);
  });

  it('keeps every non-dev link, in order', () => {
    const flat = groupNavItems(false).flatMap(g => g.links).map(l => l.href);
    const expected = NAV_ITEMS.filter(isLink).map(l => (l as NavLink).href);
    expect(flat).toEqual(expected);
  });
});
