import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { resolveProjectPath } from './project-name';

/**
 * An encoded project name, back to the directory it came from.
 *
 * Every harness names a project by its path with the separators replaced —
 * `/home/fox/git/unsandbox.com` becomes `-home-fox-git-unsandbox-com` — and
 * that encoding is not reversible: a dash in the result was a slash, a dot,
 * or a dash in the original, and nothing records which. So this probes the
 * filesystem, and the order it probes in is the whole of it: the greedy
 * split is what stops `unfirehose-nextjs-logger` becoming three directories.
 */

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'unfirehose-names-'));
const at = (...p: string[]) => path.join(root, ...p);
const encodedRoot = root.replace(/\//g, '-');

beforeAll(() => {
  for (const dir of [
    'git/unfirehose-nextjs-logger',
    'git/unsandbox.com',
    'git/www-makepostsell.com',
    'work/thinking-room',
  ]) fs.mkdirSync(at(...dir.split('/')), { recursive: true });
});
afterAll(() => fs.rmSync(root, { recursive: true, force: true }));

describe('resolveProjectPath', () => {
  it('prefers what the database already knows', async () => {
    // The path was recorded at ingest time from the transcript's own cwd.
    // Probing is a fallback for rows written before we kept it.
    expect(await resolveProjectPath('anything-at-all', {
      dbLookup: () => '/somewhere/known',
    })).toBe('/somewhere/known');
  });

  it('takes the sessions index over probing', async () => {
    const index = at('index.json');
    fs.writeFileSync(index, JSON.stringify({ originalPath: '/from/the/index' }));
    expect(await resolveProjectPath('x', { sessionsIndexPath: index })).toBe('/from/the/index');
  });

  it('ignores an index that is not readable', async () => {
    expect(await resolveProjectPath(`${encodedRoot}-work-thinking-room`, {
      sessionsIndexPath: at('no-such-index.json'),
    })).toBe(at('work', 'thinking-room'));
  });

  it('keeps a hyphenated directory name together', async () => {
    // The greedy split is what stops this becoming
    // <root>/git/unfirehose/nextjs/logger, none of which exist.
    expect(await resolveProjectPath(`${encodedRoot}-git-unfirehose-nextjs-logger`))
      .toBe(at('git', 'unfirehose-nextjs-logger'));
  });

  it('reads a trailing dash as the dot in a domain name', async () => {
    expect(await resolveProjectPath(`${encodedRoot}-git-unsandbox-com`))
      .toBe(at('git', 'unsandbox.com'));
  });

  it('handles a name that is both hyphenated and a domain', async () => {
    expect(await resolveProjectPath(`${encodedRoot}-git-www-makepostsell-com`))
      .toBe(at('git', 'www-makepostsell.com'));
  });

  it('resolves a project that does not live under git at all', async () => {
    // The previous copy of this in our todos route required a 'git'
    // segment and returned nothing without one.
    expect(await resolveProjectPath(`${encodedRoot}-work-thinking-room`))
      .toBe(at('work', 'thinking-room'));
  });

  it('answers null for a project that is not on this machine', async () => {
    // A transcript from another node. Returning a plausible-looking path
    // would send a boot into a directory that does not exist.
    expect(await resolveProjectPath(`${encodedRoot}-git-never-existed`)).toBeNull();
  });

  it('answers null rather than the root for an empty name', async () => {
    expect(await resolveProjectPath('')).toBeNull();
  });
});
