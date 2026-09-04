import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { resolveSpecifier, importsOf, exportsOf, deadPrivateFunctions } from './imports.ts';
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
    // layout.tsx, because Next.js requires it: a test anchored on an
    // ordinary source file fails the day that file is deleted, which says
    // nothing about whether alias resolution works.
    const resolved = resolveSpecifier('@/app/layout', path.join(ROOT, 'apps/web/src/x.ts'));
    expect(resolved).toBe(path.join(ROOT, 'apps/web/src/app/layout.tsx'));
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

describe('deadPrivateFunctions', () => {
  it('finds a function nothing calls', () => {
    const file = write('dead.ts', [
      'function used() { return 1; }',
      'function unused() { return 2; }',
      'export const answer = used();',
    ].join('\n'));
    expect(deadPrivateFunctions(file).map((f) => f.name)).toEqual(['unused']);
  });

  it('leaves an exported function alone, since callers live elsewhere', () => {
    const file = write('exported.ts', 'export function offered() { return 1; }\n');
    expect(deadPrivateFunctions(file)).toEqual([]);
  });

  it('counts a component used only in JSX as used', () => {
    // The first version of this missed JSX tag names, which would have
    // condemned half the components in the app.
    const file = write('view.tsx', [
      'function Row() { return <li/>; }',
      'export function List() { return <ul><Row/></ul>; }',
    ].join('\n'));
    expect(deadPrivateFunctions(file)).toEqual([]);
  });

  it('sees an unused arrow bound to a const', () => {
    const file = write('arrow.ts', 'const helper = () => 1;\nexport const x = 2;\n');
    expect(deadPrivateFunctions(file).map((f) => f.name)).toEqual(['helper']);
  });

  it('ignores a nested helper, which is scoped to its parent', () => {
    const file = write('nested.ts', [
      'export function outer() {',
      '  function inner() { return 1; }',
      '  return inner();',
      '}',
    ].join('\n'));
    expect(deadPrivateFunctions(file)).toEqual([]);
  });

  it('reports the range to delete, comment excluded', () => {
    const file = write('range.ts', [
      'function gone() {',
      '  return 1;',
      '}',
      'export const x = 1;',
    ].join('\n'));
    expect(deadPrivateFunctions(file)[0]).toMatchObject({ name: 'gone', line: 1, endLine: 3 });
  });
});
