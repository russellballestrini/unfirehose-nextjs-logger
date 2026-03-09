import { NextRequest, NextResponse } from 'next/server';

const PAGES = [
  { path: '/', label: 'Dashboard', section: 'Navigate' },
  { path: '/live', label: 'Live', section: 'Monitor' },
  { path: '/active', label: 'Active', section: 'Monitor' },
  { path: '/tmux', label: 'Terminals', section: 'Monitor' },
  { path: '/projects', label: 'Projects', section: 'Navigate' },
  { path: '/todos', label: 'Todos', section: 'Navigate' },
  { path: '/training', label: 'Training', section: 'Analyze' },
  { path: '/thinking', label: 'Thinking', section: 'Analyze' },
  { path: '/tokens', label: 'Tokens', section: 'Analyze' },
  { path: '/usage', label: 'Usage', section: 'Analyze' },
  { path: '/logs', label: 'All Logs', section: 'Analyze' },
  { path: '/scrobble', label: 'Scrobble', section: 'Configure' },
  { path: '/permacomputer', label: 'Permacomputer', section: 'Configure' },
  { path: '/permacomputer/unsandbox', label: 'Unsandbox', section: 'Configure' },
  { path: '/schema', label: 'Schema', section: 'Configure' },
  { path: '/styleguide', label: 'Styleguide', section: 'Configure' },
  { path: '/settings', label: 'Settings', section: 'Configure' },
  { path: '/blog', label: 'Blog', section: 'Other' },
  { path: '/keys', label: 'Keys', section: 'Other' },
  { path: '/login', label: 'Login', section: 'Other' },
];

export async function GET(request: NextRequest) {
  const accept = request.headers.get('accept') ?? '';
  const url = request.nextUrl;
  const format = url.searchParams.get('format');

  // XML if explicitly requested or Accept prefers XML
  if (format === 'xml' || (!format && accept.includes('xml') && !accept.includes('html'))) {
    return xmlSitemap(url.origin);
  }
  return htmlSitemap(url.origin);
}

function xmlSitemap(origin: string): NextResponse {
  const urls = PAGES.map(p =>
    `  <url>\n    <loc>${origin}${p.path}</loc>\n  </url>`
  ).join('\n');

  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${urls}
</urlset>`;

  return new NextResponse(xml, {
    headers: { 'Content-Type': 'application/xml; charset=utf-8' },
  });
}

function htmlSitemap(origin: string): NextResponse {
  const sections = new Map<string, typeof PAGES>();
  for (const p of PAGES) {
    if (!sections.has(p.section)) sections.set(p.section, []);
    sections.get(p.section)!.push(p);
  }

  let body = '';
  for (const [section, pages] of sections) {
    body += `<h2>${section}</h2>\n<ul>\n`;
    for (const p of pages) {
      body += `  <li><a href="${p.path}">${p.label}</a> <code>${p.path}</code></li>\n`;
    }
    body += `</ul>\n`;
  }

  const html = `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <title>Sitemap — unfirehose</title>
  <style>
    body { font-family: monospace; background: #09090b; color: #fafafa; max-width: 640px; margin: 2rem auto; padding: 0 1rem; }
    a { color: #d40000; }
    code { color: #a1a1aa; font-size: 0.9em; }
    h1 { border-bottom: 1px solid #3f3f46; padding-bottom: 0.5rem; }
    h2 { color: #a1a1aa; font-size: 0.8rem; text-transform: uppercase; letter-spacing: 0.1em; margin-top: 1.5rem; }
    ul { list-style: none; padding: 0; }
    li { padding: 0.25rem 0; }
    .formats { color: #a1a1aa; font-size: 0.9rem; }
    .formats a { color: #60a5fa; }
  </style>
</head>
<body>
  <h1>unfirehose sitemap</h1>
  <p class="formats">Formats: <a href="/sitemap?format=html">HTML</a> · <a href="/sitemap?format=xml">XML</a></p>
${body}
  <p style="color:#3f3f46;margin-top:2rem">${PAGES.length} pages · ${origin}</p>
</body>
</html>`;

  return new NextResponse(html, {
    headers: { 'Content-Type': 'text/html; charset=utf-8' },
  });
}
