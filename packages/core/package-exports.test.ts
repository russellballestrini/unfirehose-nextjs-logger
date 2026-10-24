import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync } from 'fs';
import path from 'path';

/**
 * Every subpath we publish resolves to a file. `./training` pointed at a
 * training.ts that never existed until 2026-10-24; an import of it failed
 * only in someone else's project.
 */
describe('package exports', () => {
  const pkg = JSON.parse(readFileSync(path.join(__dirname, 'package.json'), 'utf8'));
  const targets = Object.entries(pkg.exports as Record<string, string | Record<string, string>>)
    .flatMap(([key, v]) => (typeof v === 'string' ? [[key, v]] : Object.values(v).map((t) => [key, t])));

  it.each(targets)('%s → %s exists', (_key, target) => {
    if (target.includes('*')) return;
    expect(existsSync(path.join(__dirname, target))).toBe(true);
  });
});
