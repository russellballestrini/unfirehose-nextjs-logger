import { describe, it, expect } from 'vitest';
import { parseGitState, EMPTY_GIT_STATE } from './git-state';

/**
 * What is uncommitted and what is unpushed.
 *
 * Two routes report these same two facts about the same repository. They
 * have to agree — a page saying "clean" beside a report saying "three dirty
 * files" is a contradiction a reader cannot resolve from the outside.
 */

describe('parseGitState', () => {
  it('reads a clean tree with nothing to push', () => {
    expect(parseGitState('', '')).toEqual(EMPTY_GIT_STATE);
  });

  it('counts each changed file once', () => {
    const s = parseGitState(' M src/a.ts\n?? src/b.ts\n M src/c.ts\n', '');
    expect(s.isDirty).toBe(true);
    expect(s.dirtyFiles).toHaveLength(3);
  });

  it('trims the porcelain status prefix padding', () => {
    // ` M path` carries a leading space for the index column. Left on, the
    // path does not match anything a caller compares it against.
    expect(parseGitState(' M src/a.ts\n', '').dirtyFiles).toEqual(['M src/a.ts']);
  });

  it('does not count the trailing newline git always emits as a file', () => {
    // git's stdout ends in a newline; splitting without filtering gives a
    // phantom empty entry, and a clean tree reports as dirty.
    expect(parseGitState('\n', '').isDirty).toBe(false);
    expect(parseGitState('', '\n').unpushedCount).toBe(0);
  });

  it('counts unpushed commits', () => {
    const s = parseGitState('', 'abc123 first\ndef456 second\n');
    expect(s.unpushedCount).toBe(2);
    expect(s.unpushedCommits).toEqual(['abc123 first', 'def456 second']);
  });

  it('reports dirty and unpushed independently', () => {
    // A clean tree with unpushed commits, and a dirty tree with none, are
    // both ordinary states and neither implies the other.
    expect(parseGitState('', 'abc first\n')).toMatchObject({ isDirty: false, unpushedCount: 1 });
    expect(parseGitState(' M a\n', '')).toMatchObject({ isDirty: true, unpushedCount: 0 });
  });
});
