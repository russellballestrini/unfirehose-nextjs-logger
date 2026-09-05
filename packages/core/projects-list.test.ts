import { describe, it, expect } from 'vitest';
import { canonicalNamesByRootCommit } from './projects-list';

/**
 * One name per repository, out of the several our projects table holds.
 *
 * That table is scoped per harness slot on purpose — the same repo worked
 * on by claude, by an arborist subagent and by uncloseai is three rows —
 * which is right for ingestion and wrong for a list somebody reads, where
 * it is the same repo three times. These rows share a root commit, and
 * that is what folds them.
 *
 * Which name wins matters beyond tidiness: it is the name every link on
 * the page and every boot from it will use.
 */

const row = (name: string, hash: string | null = 'abc123') => ({ name, root_commit_hash: hash });

describe('canonicalNamesByRootCommit', () => {
  it('folds three harness rows of one repo onto one name', () => {
    const fold = canonicalNamesByRootCommit([
      row('arborist:-home-fox-git-uncloseai-cli'),
      row('-home-fox-git-uncloseai-cli'),
      row('uncloseai:home-fox-git-uncloseai-cli'),
    ], new Set());
    expect(fold.get('abc123')).toBe('-home-fox-git-uncloseai-cli');
  });

  it('prefers the name that has a directory on disk', () => {
    // That is the name every link and every boot already uses; picking a
    // harness-prefixed sibling sends both somewhere that does not exist.
    const fold = canonicalNamesByRootCommit([
      row('a'),
      row('a-much-longer-name-on-disk'),
    ], new Set(['a-much-longer-name-on-disk']));
    expect(fold.get('abc123')).toBe('a-much-longer-name-on-disk');
  });

  it('keeps the one on disk when a shorter name arrives later', () => {
    const fold = canonicalNamesByRootCommit([
      row('a-much-longer-name-on-disk'),
      row('a'),
    ], new Set(['a-much-longer-name-on-disk']));
    expect(fold.get('abc123')).toBe('a-much-longer-name-on-disk');
  });

  it('falls back to the shortest when neither is on disk', () => {
    // A harness prefix makes a name strictly longer than the bare one it
    // prefixes, so shortest is the bare repo name.
    const fold = canonicalNamesByRootCommit([
      row('arborist:-home-fox-git-demo'),
      row('-home-fox-git-demo'),
    ], new Set());
    expect(fold.get('abc123')).toBe('-home-fox-git-demo');
  });

  it('picks the shortest among several that are all on disk', () => {
    const fold = canonicalNamesByRootCommit([
      row('longer-name'), row('short'),
    ], new Set(['longer-name', 'short']));
    expect(fold.get('abc123')).toBe('short');
  });

  it('keeps two repositories apart', () => {
    const fold = canonicalNamesByRootCommit([
      row('demo', 'aaa'), row('other', 'bbb'),
    ], new Set());
    expect([...fold.entries()]).toEqual([['aaa', 'demo'], ['bbb', 'other']]);
  });

  it('ignores a row whose repository we could not identify', () => {
    // A project outside a git checkout has no root commit, and folding
    // every such row together would merge unrelated projects.
    const fold = canonicalNamesByRootCommit([
      row('no-repo-a', null), row('no-repo-b', null),
    ], new Set());
    expect(fold.size).toBe(0);
  });

  it('has nothing to fold for an empty list', () => {
    expect(canonicalNamesByRootCommit([], new Set()).size).toBe(0);
  });
});
