import { describe, it, expect } from 'vitest';
import { gitExec } from './git-exec';

const REPO = process.cwd();   // packages/core, inside this repo

describe('gitExec', () => {
  it('returns stdout for a command that succeeds', async () => {
    const out = await gitExec(REPO, ['rev-parse', '--abbrev-ref', 'HEAD']);
    expect(out.trim().length).toBeGreaterThan(0);
  });

  it('rejects when git fails, rather than resolving empty', async () => {
    await expect(gitExec(REPO, ['cat-file', '-t', 'definitely-not-an-object'])).rejects.toThrow();
  });

  it('feeds stdin and closes it — a batch command must not hang', async () => {
    // Without the close this waits out the full timeout, which is exactly
    // how it failed the first time.
    const out = await gitExec(REPO, ['cat-file', '--batch-check'], {
      stdin: 'HEAD\n',
      timeout: 5000,
    });
    expect(out).toMatch(/commit/);
  });

  it('closes stdin even when none was given', async () => {
    // `git hash-object --stdin` reads until EOF; if we never close it, this
    // times out instead of returning the hash of nothing.
    const out = await gitExec(REPO, ['hash-object', '--stdin'], { timeout: 5000 });
    expect(out.trim()).toHaveLength(40);
  });
});
