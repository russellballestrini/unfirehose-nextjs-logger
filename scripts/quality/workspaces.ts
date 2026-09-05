/**
 * Where our code lives, and where a suite drops its coverage.
 *
 * Every report here answers the same question from a different angle, so
 * they all read this list rather than each carrying its own idea of what
 * the monorepo contains.
 */

import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';

// tsx transpiles these to CommonJS, where `import.meta.dirname` is not
// defined but `import.meta.url` is.
export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

export interface Workspace {
  /** Name as npm knows it. */
  name: string;
  /** Directory relative to our repo root. */
  dir: string;
  /** Globs of source we measure, relative to `dir`. */
  src: string[];
  /** Has a vitest suite that can emit coverage. */
  tested: boolean;
}

export const WORKSPACES: Workspace[] = [
  { name: '@unturf/unfirehose', dir: 'packages/core', src: ['.'], tested: true },
  { name: '@unturf/unfirehose-ui', dir: 'packages/ui', src: ['components', 'hooks', 'lib'], tested: true },
  { name: '@unturf/unfirehose-web', dir: 'apps/web', src: ['src'], tested: true },
  { name: '@unturf/unfirehose-router', dir: 'packages/router', src: ['src'], tested: false },
  { name: '@unturf/unfirehose-worker', dir: 'apps/worker', src: ['src'], tested: false },
  { name: '@unturf/unfirehose-schema', dir: 'packages/schema', src: ['.'], tested: false },
  // Our own reporting tools, held to the standard they apply.
  { name: 'scripts', dir: 'scripts', src: ['.'], tested: true },
];

/** Directories no report should ever walk into. */
const SKIP_DIRS = new Set([
  'node_modules', '.next', '.turbo', 'dist', 'build', 'coverage', '.git', 'out',
]);

const CODE = /\.(ts|tsx)$/;

/**
 * A file we count as ours: source, not a test, not generated.
 *
 * Test scaffolding — a fixture builder, a database helper — is excluded
 * along with the tests themselves. It is only ever run by tests, so
 * grading its coverage measures whether our helpers exercise each other,
 * and every line of it that no test happens to need reads as untested
 * shipped code that somebody should go and cover.
 */
export function isSource(file: string): boolean {
  if (!CODE.test(file)) return false;
  if (file.endsWith('.d.ts')) return false;
  if (/\.test\.(ts|tsx)$/.test(file)) return false;
  if (/(^|\/)(test|__tests__|__fixtures__|__mocks__)\//.test(file)) return false;
  return true;
}

export function isTest(file: string): boolean {
  return /\.test\.(ts|tsx)$/.test(file);
}

/** Every `.ts`/`.tsx` under a directory, tests included — callers filter. */
export function walk(dir: string, out: string[] = []): string[] {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue;
      walk(full, out);
    } else if (CODE.test(entry.name)) {
      out.push(full);
    }
  }
  return out;
}

/** Absolute paths of every source file in a workspace. */
export function sourcesOf(ws: Workspace, { tests = false } = {}): string[] {
  const files: string[] = [];
  for (const rel of ws.src) walk(path.join(ROOT, ws.dir, rel), files);
  return files.filter((f) => (tests ? isSource(f) || isTest(f) : isSource(f))).sort();
}

/** Which workspace a path belongs to, longest directory wins. */
export function workspaceOf(file: string): Workspace | undefined {
  const rel = path.relative(ROOT, file);
  return WORKSPACES
    .filter((ws) => rel === ws.dir || rel.startsWith(`${ws.dir}/`))
    .sort((a, b) => b.dir.length - a.dir.length)[0];
}

export const rel = (file: string) => path.relative(ROOT, file);
