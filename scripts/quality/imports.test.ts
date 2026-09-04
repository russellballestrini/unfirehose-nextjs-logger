import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { resolveSpecifier, importsOf, exportsOf } from './imports.ts';
import { ROOT } from './workspaces.ts';

/**
 * Resolution decides what the orphan report calls dead, so these cases are
 * the ones that would produce a false accusation if they broke.
 */
let dir: string;
const write = (name: string, source: string) => {
  const file = path.join(dir, name);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, source);
  return file;
};

beforeAll(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'unfirehose-imports-'));
});
afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

describe('resolveSpecifier', () => {
  it('finds a sibling with its extension left off', () => {
    const from = write('a.ts', '');
    const target = write('b.ts', '');
    expect(resolveSpecifier('./b', from)).toBe(target);
  });

  it('finds a directory index', () => {
    const from = write('a.ts', '');
    const target = write('nested/index.ts', '');
    expect(resolveSpecifier('./nested', from)).toBe(target);
  });

  it('reads .js in a specifier as the .ts on disk', () => {
    // ESM TypeScript writes the emitted name; the file is still .ts.
    const from = write('a.ts', '');
    const target = write('c.ts', '');
    expect(resolveSpecifier('./c.js', from)).toBe(target);
  });

  it('resolves a workspace subpath through its package exports map', () => {
    const resolved = resolveSpecifier('@unturf/unfirehose/db/schema', path.join(ROOT, 'apps/web/x.ts'));
    expect(resolved).toBe(path.join(ROOT, 'packages/core/db/schema.ts'));
  });

  it('resolves our @/ alias to apps/web/src', () => {
    const resolved = resolveSpecifier('@/lib/cloud-account', path.join(ROOT, 'apps/web/src/x.ts'));
    expect(resolved).toBe(path.join(ROOT, 'apps/web/src/lib/cloud-account.ts'));
  });

  it('gives up on a package we do not own', () => {
    expect(resolveSpecifier('react', path.join(ROOT, 'apps/web/x.ts'))).toBeUndefined();
  });
});

describe('importsOf', () => {
  it('records the names taken from each target', () => {
    write('dep.ts', 'export const a = 1; export const b = 2;');
    const file = write('user.ts', "import { a, b as c } from './dep';\n");
    const found = importsOf(file);
    const names = found.names.get(path.join(dir, 'dep.ts'))!;
    // `b as c` takes `b` — the exporting file never hears the alias.
    expect([...names].sort()).toEqual(['a', 'b']);
  });

  it('marks a namespace import as taking everything', () => {
    write('dep.ts', 'export const a = 1;');
    const file = write('ns.ts', "import * as dep from './dep';\n");
    expect([...importsOf(file).names.get(path.join(dir, 'dep.ts'))!]).toEqual(['*']);
  });

  it('follows a dynamic import, which is still a use', () => {
    write('lazy.ts', 'export const a = 1;');
    const file = write('dyn.ts', "const load = () => import('./lazy');\n");
    expect(importsOf(file).targets).toContain(path.join(dir, 'lazy.ts'));
  });

  it('treats export * as keeping the whole surface alive', () => {
    write('all.ts', 'export const a = 1;');
    const file = write('barrel.ts', "export * from './all';\n");
    expect(importsOf(file).starReexports).toEqual([path.join(dir, 'all.ts')]);
  });

  it('reports a relative specifier it cannot resolve rather than dropping it', () => {
    // Silence here is how a live file gets called dead.
    const file = write('broken.ts', "import { x } from './nowhere';\n");
    expect(importsOf(file).unresolved).toEqual(['./nowhere']);
  });

  it('stays quiet about packages from node_modules', () => {
    const file = write('ext.ts', "import React from 'react';\n");
    expect(importsOf(file).unresolved).toEqual([]);
  });
});

describe('exportsOf', () => {
  it('names every kind of export a file can offer', () => {
    const file = write('surface.ts', [
      'export const a = 1;',
      'export function b() {}',
      'export class C {}',
      'export interface D { x: number }',
      'export type E = string;',
      'export enum F { G }',
      'const h = 1;',
      'export { h };',
      'export default b;',
    ].join('\n'));
    expect(exportsOf(file).map((e) => e.name).sort())
      .toEqual(['C', 'D', 'E', 'F', 'a', 'b', 'default', 'h']);
  });

  it('leaves what a file keeps to itself out of its surface', () => {
    const file = write('private.ts', 'const hidden = 1;\nfunction alsoHidden() {}\nexport const shown = 2;\n');
    expect(exportsOf(file).map((e) => e.name)).toEqual(['shown']);
  });
});
