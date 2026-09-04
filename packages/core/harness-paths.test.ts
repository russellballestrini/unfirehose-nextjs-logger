import { describe, it, expect } from 'vitest';
import { harnessPaths } from './harness-paths';
import { agntPaths } from './agnt-paths';
import { fetchPaths } from './fetch-paths';
import { uncloseaiPaths } from './uncloseai-paths';

describe('harnessPaths', () => {
  it('lays a session out as {root}/{slug}/{id}.jsonl', () => {
    const p = harnessPaths('/data/harness');
    expect(p.projectDir('-home-fox-git-demo')).toBe('/data/harness/-home-fox-git-demo');
    expect(p.sessionFile('-home-fox-git-demo', 'abc-123'))
      .toBe('/data/harness/-home-fox-git-demo/abc-123.jsonl');
  });

  it('gives every native harness the same layout', () => {
    // The point of the factory: a fourth adopter cannot get the shape wrong,
    // only its root.
    for (const paths of [agntPaths, fetchPaths, uncloseaiPaths]) {
      expect(paths.sessionFile('slug', 'id')).toBe(`${paths.root}/slug/id.jsonl`);
    }
  });

  it('roots each harness in its own directory', () => {
    const roots = [agntPaths.root, fetchPaths.root, uncloseaiPaths.root];
    expect(new Set(roots).size).toBe(3);
    expect(agntPaths.root).toContain('.agnt');
    expect(fetchPaths.root).toContain('.fetch');
    expect(uncloseaiPaths.root).toContain('.uncloseai');
  });
});
