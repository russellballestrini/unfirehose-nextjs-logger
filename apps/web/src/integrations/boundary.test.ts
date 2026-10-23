/// <reference types="vite/client" />
import { describe, it, expect } from 'vitest';
import { INTEGRATION_IDS } from './catalog';

/**
 * Each integration is one removable directory.
 *
 * Only our integration registry (`src/integrations/*`) and an integration's
 * own thin route wrappers (`src/app/api/<id>/**\/route.ts`) may import from
 * `src/integrations/<id>/`. Anything else reaching in means deleting the
 * directory breaks a page that should not have known it existed. And the
 * directory imports nothing from `src/app/` outside its tests, so it carries
 * no hidden dependency on a page it would be deleted out from under.
 *
 * Sources are read as text, never imported.
 */

const sources = import.meta.glob(['../**/*.ts', '../**/*.tsx'], {
  query: '?raw',
  import: 'default',
  eager: true,
}) as Record<string, string>;

/** `../app/tmux/page.tsx` → `src/app/tmux/page.tsx` */
const srcPath = (file: string) => file.replace(/^\.\.\//, 'src/');

/** Every module specifier a file imports or re-exports, static or dynamic. */
const IMPORT_RE = /(?:\bfrom\s*|\bimport\s*\(\s*|\bimport\s+|vi\.mock\(\s*)['"]([^'"]+)['"]/g;
function specifiers(src: string): string[] {
  return [...src.matchAll(IMPORT_RE)].map((m) => m[1]);
}

/** A specifier, resolved to a `src/...` path where it is ours. */
function resolve(fromFile: string, spec: string): string | null {
  if (spec.startsWith('@/')) return 'src/' + spec.slice(2);
  if (!spec.startsWith('.')) return null;
  const parts = fromFile.split('/').slice(0, -1);
  for (const seg of spec.split('/')) {
    if (seg === '.' || seg === '') continue;
    if (seg === '..') parts.pop();
    else parts.push(seg);
  }
  return parts.join('/');
}

const files = Object.keys(sources).map((f) => ({ path: srcPath(f), src: sources[f] }));

describe('integration boundaries', () => {
  it('reads our sources, so this cannot quietly cover nothing', () => {
    expect(files.length).toBeGreaterThan(200);
    expect(files.some((f) => f.path === 'src/app/permacomputer/page.tsx')).toBe(true);
  });

  for (const id of INTEGRATION_IDS) {
    const dir = `src/integrations/${id}`;
    const isInside = (p: string) => p === dir || p.startsWith(`${dir}/`);
    const allowed = (p: string) =>
      isInside(p)
      || /^src\/integrations\/[^/]+\.tsx?$/.test(p)
      || new RegExp(`^src/app/api/${id}/(.+/)?route\\.ts$`).test(p);

    it(`nothing outside our registry and ${id}'s route wrappers imports ${dir}/`, () => {
      const offenders = files.flatMap(({ path, src }) =>
        allowed(path) ? [] : specifiers(src)
          .map((s) => resolve(path, s))
          .filter((r): r is string => !!r && isInside(r))
          .map((r) => `${path} → ${r}`),
      );
      expect(offenders).toEqual([]);
    });

    it(`${dir}/ imports nothing from src/app/ outside its tests`, () => {
      const offenders = files
        .filter(({ path }) => isInside(path) && !/\.test\.tsx?$/.test(path))
        .flatMap(({ path, src }) => specifiers(src)
          .map((s) => resolve(path, s))
          .filter((r): r is string => !!r && r.startsWith('src/app/'))
          .map((r) => `${path} → ${r}`));
      expect(offenders).toEqual([]);
    });

    it(`${id}'s route wrappers stay thin`, () => {
      const wrappers = files.filter(({ path }) => new RegExp(`^src/app/api/${id}/`).test(path) && !/\.test\./.test(path));
      expect(wrappers.length).toBeGreaterThan(0);
      for (const { path, src } of wrappers) {
        // Imports and gated re-exports only: a handler body here is code
        // that would survive the directory it belongs to.
        const code = src.split('\n').filter((l) => l.trim() && !l.trim().startsWith('//'));
        for (const line of code) {
          expect(line, path).toMatch(/^(import .+ from '.+';|export const [A-Z]+ = gated\('[a-z0-9-]+', \w+\.[A-Z]+\);)$/);
        }
      }
    });
  }

  it('catches an import that crosses, so the scan is not vacuous', () => {
    const fake = `import { UnsandboxPanel } from '@/integrations/unsandbox/MeshPanel';\nimport x from '../../integrations/unsandbox/client';`;
    const hits = specifiers(fake).map((s) => resolve('src/app/permacomputer/page.tsx', s));
    expect(hits).toEqual(['src/integrations/unsandbox/MeshPanel', 'src/integrations/unsandbox/client']);
  });
});
