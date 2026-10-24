import { describe, it, expect, afterEach, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { groupNavItems } from '@unturf/unfirehose-ui/layout/nav-items';
import { GET } from './route';

/**
 * /sitemap is built from the sidebar's own nav config, so the two cannot
 * drift. HTML for a person, XML for a crawler: chosen by ?format, or by an
 * Accept header that prefers XML over HTML.
 */

const get = (qs = '', accept?: string) =>
  GET(new NextRequest(`http://localhost:3000/sitemap${qs}`, accept ? { headers: { accept } } : undefined));

afterEach(() => vi.unstubAllEnvs());

describe('GET /sitemap', () => {
  it('serves HTML by default, every sidebar page grouped under its section', async () => {
    const res = await get();
    expect(res.headers.get('content-type')).toBe('text/html; charset=utf-8');
    const html = await res.text();
    const groups = groupNavItems(false);
    const pages = groups.flatMap((g) => g.links);
    for (const g of groups) expect(html).toContain(`<h2>${g.section}</h2>`);
    for (const p of pages) expect(html).toContain(`<li><a href="${p.href}">${p.label}</a> <code>${p.href}</code></li>`);
    expect(html).toContain(`${pages.length} pages · http://localhost:3000`);
  });

  it('serves XML when asked by format, with absolute locations', async () => {
    const res = await get('?format=xml');
    expect(res.headers.get('content-type')).toBe('application/xml; charset=utf-8');
    const xml = await res.text();
    expect(xml.startsWith('<?xml version="1.0" encoding="UTF-8"?>')).toBe(true);
    const locs = [...xml.matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => m[1]);
    expect(locs).toEqual(groupNavItems(false).flatMap((g) => g.links).map((l) => `http://localhost:3000${l.href}`));
  });

  it('serves XML to a crawler whose Accept prefers it, and HTML to a browser that lists both', async () => {
    expect((await get('', 'application/xml')).headers.get('content-type')).toContain('xml');
    expect((await get('', 'text/html,application/xml;q=0.9')).headers.get('content-type')).toContain('html');
    // An explicit format beats the header.
    expect((await get('?format=html', 'application/xml')).headers.get('content-type')).toContain('html');
  });

  it('leaves development-only pages out of a production build', async () => {
    vi.stubEnv('NODE_ENV', 'production');
    const xml = await (await get('?format=xml')).text();
    const count = (xml.match(/<loc>/g) ?? []).length;
    expect(count).toBe(groupNavItems(true).flatMap((g) => g.links).length);
    expect(count).toBeLessThanOrEqual(groupNavItems(false).flatMap((g) => g.links).length);
  });
});
