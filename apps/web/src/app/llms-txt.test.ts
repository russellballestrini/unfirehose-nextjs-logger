/// <reference types="vite/client" />
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import path from 'path';

/**
 * public/llms.txt documents every endpoint, and only real ones.
 *
 * It drifted once already: five endpoints it described had been deleted,
 * and twenty-odd route files never made it in. Agents read that file to
 * learn what to call, so a missing endpoint is invisible to them and a dead
 * one is a 404 they were told to expect an answer from.
 *
 * Each route file is read as source, never imported — which methods it
 * exports is a fact about its text, and importing seventy-nine modules to
 * learn it would drag in every database and SSH dependency they carry.
 * OPTIONS is CORS preflight plumbing and is left out on purpose.
 */

const METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD'] as const;
const EXPORT_RE = new RegExp(
  `export\\s+(?:async\\s+)?(?:function|const)\\s+(${METHODS.join('|')})\\b`,
  'g',
);

const sources = import.meta.glob('./api/**/route.ts', {
  query: '?raw',
  import: 'default',
  eager: true,
}) as Record<string, string>;

/** `./api/todos/[id]/route.ts` → `/api/todos/{id}` */
function apiPath(file: string): string {
  return file
    .replace(/^\./, '')
    .replace(/\/route\.ts$/, '')
    .replace(/\[([^\]]+)\]/g, '{$1}');
}

const routes = new Set<string>();
for (const [file, src] of Object.entries(sources)) {
  for (const m of src.matchAll(EXPORT_RE)) routes.add(`${m[1]} ${apiPath(file)}`);
}

const llms = readFileSync(path.resolve(__dirname, '../../public/llms.txt'), 'utf8');
const documented = new Set(
  [...llms.matchAll(new RegExp(`^### ((?:${METHODS.join('|')}) /api/\\S+)\\s*$`, 'gm'))].map((m) => m[1]),
);

describe('public/llms.txt', () => {
  it('finds the route files, so this test cannot quietly cover nothing', () => {
    expect(Object.keys(sources).length).toBeGreaterThanOrEqual(70);
    expect(routes.size).toBeGreaterThanOrEqual(100);
  });

  it('documents every exported route method under a `### METHOD /api/path` heading', () => {
    const missing = [...routes].filter((r) => !documented.has(r)).sort();
    expect(missing).toEqual([]);
  });

  it('documents no endpoint that has no route behind it', () => {
    const stale = [...documented].filter((r) => !routes.has(r)).sort();
    expect(stale).toEqual([]);
  });
});
