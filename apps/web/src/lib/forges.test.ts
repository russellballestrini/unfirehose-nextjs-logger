import { describe, it, expect } from 'vitest';
import { parseRemoteForCheck } from './forges';

/**
 * Turning a git remote into a forge API call.
 *
 * This decides whether our scrobble profile calls a repository public. The
 * check is "does an unauthenticated API request succeed", so a malformed
 * API URL answers 404 — which reads exactly like "this repo is private"
 * rather than like a defect. That is why the shapes are pinned here.
 *
 * It was three near-identical match-and-return blocks, each with its own
 * copy of the `.git` handling.
 */

describe('GitHub', () => {
  it('reads an ssh remote', () => {
    expect(parseRemoteForCheck('git@github.com:fxhp/unfirehose.git')).toEqual({
      apiUrl: 'https://api.github.com/repos/fxhp/unfirehose',
      webUrl: 'https://github.com/fxhp/unfirehose',
    });
  });

  it('reads an https remote', () => {
    expect(parseRemoteForCheck('https://github.com/fxhp/unfirehose.git')?.apiUrl)
      .toBe('https://api.github.com/repos/fxhp/unfirehose');
  });

  it('reads a remote with no .git suffix', () => {
    expect(parseRemoteForCheck('https://github.com/fxhp/unfirehose')?.webUrl)
      .toBe('https://github.com/fxhp/unfirehose');
  });
});

describe('our GitLab', () => {
  it('reads an ssh remote carrying a port', () => {
    // git.unturf.com answers ssh on 2222. A port left in the captured path
    // produces an API URL that 404s, which we would read as "private".
    expect(parseRemoteForCheck('ssh://git@git.unturf.com:2222/fox/unfirehose.git')).toEqual({
      apiUrl: 'https://git.unturf.com/api/v4/projects/fox%2Funfirehose',
      webUrl: 'https://git.unturf.com/fox/unfirehose',
    });
  });

  it('encodes the full path, since GitLab addresses a project that way', () => {
    // Not owner/repo — GitLab takes the whole namespace, URL-encoded, so a
    // nested group needs every separator escaped.
    expect(parseRemoteForCheck('https://git.unturf.com/group/sub/repo.git')?.apiUrl)
      .toBe('https://git.unturf.com/api/v4/projects/group%2Fsub%2Frepo');
  });

  it('leaves the browsable URL unencoded', () => {
    expect(parseRemoteForCheck('https://git.unturf.com/group/sub/repo.git')?.webUrl)
      .toBe('https://git.unturf.com/group/sub/repo');
  });
});

describe('Codeberg', () => {
  it('reads ssh and https alike', () => {
    for (const url of ['git@codeberg.org:fox/repo.git', 'https://codeberg.org/fox/repo']) {
      expect(parseRemoteForCheck(url)?.apiUrl).toBe('https://codeberg.org/api/v1/repos/fox/repo');
    }
  });
});

describe('forges we cannot ask', () => {
  it('returns null rather than guessing an API shape', () => {
    // Guessing would produce a URL that 404s, and a 404 here means
    // "private" — so an unknown forge would silently mark a public repo
    // private instead of being reported as unsupported.
    for (const url of [
      'git@bitbucket.org:fox/repo.git',
      'https://example.com/fox/repo.git',
      '/home/fox/git/local-only',
      '',
    ]) {
      expect(parseRemoteForCheck(url), url).toBeNull();
    }
  });

  it('is not fooled by a host that merely contains a forge name', () => {
    // `github.com.evil.test` is not GitHub. Matching it would send a
    // request naming our repo to somebody else's server.
    expect(parseRemoteForCheck('https://github.com.evil.test/a/b.git')).toBeNull();
  });
});
