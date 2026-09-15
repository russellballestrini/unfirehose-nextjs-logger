import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync } from 'fs';
import { execFileSync } from 'child_process';
import { tmpdir } from 'os';
import path from 'path';

/**
 * The batch git-status sweep against real repositories in a temp tree:
 * a clean checkout, a dirty one, a project that is not a checkout at all,
 * and the memo that keeps a second poll from forking git again.
 */
const root = mkdtempSync(path.join(tmpdir(), 'git-status-'));
const projects = path.join(root, 'projects');
const repos: Record<string, string> = {};

vi.mock('@unturf/unfirehose/claude-paths', () => ({ claudePaths: { projects } }));
vi.mock('@unturf/unfirehose/db/repo-path', () => ({ repoPathForProject: (dir: string) => repos[dir] ?? null }));

const gitRuns: string[][] = [];
vi.mock('@unturf/unfirehose/git-exec', async (importOriginal) => {
  const real = await importOriginal<typeof import('@unturf/unfirehose/git-exec')>();
  return { gitExec: (repo: string, args: string[], opts: unknown) => { gitRuns.push(args); return real.gitExec(repo, args, opts as never); } };
});

const { GET } = await import('./route');

const git = (cwd: string, ...args: string[]) =>
  execFileSync('git', args, { cwd, stdio: 'pipe', env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@x', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@x' } });

function makeRepo(name: string, opts: { dirty?: boolean; branch?: string } = {}): string {
  const dir = path.join(root, name);
  mkdirSync(dir, { recursive: true });
  git(dir, 'init', '-q', '-b', opts.branch ?? 'main');
  writeFileSync(path.join(dir, 'a.txt'), 'one\n');
  git(dir, 'add', 'a.txt');
  git(dir, 'commit', '-q', '-m', 'one');
  if (opts.dirty) {
    writeFileSync(path.join(dir, 'a.txt'), 'two\n');
    writeFileSync(path.join(dir, 'b.txt'), 'new\n');
  }
  return dir;
}

/** Poll until the background sweep has published every expected key. */
async function settled(keys: string[]): Promise<Record<string, unknown>> {
  let body: Record<string, unknown> = {};
  for (let i = 0; i < 40; i++) {
    body = await (await GET()).json();
    if (keys.every((k) => k in body)) return body;
    await new Promise((r) => setTimeout(r, 100));
  }
  return body;
}

beforeAll(() => {
  mkdirSync(projects, { recursive: true });
  for (const dir of ['-clean', '-dirty', '-plain', '-unknown']) mkdirSync(path.join(projects, dir));
  repos['-clean'] = makeRepo('clean');
  repos['-dirty'] = makeRepo('dirty', { dirty: true, branch: 'feature/x' });
  repos['-plain'] = path.join(root, 'plain');       // a directory, not a checkout
  mkdirSync(repos['-plain']);
  // '-unknown' has no repo path at all.
});

afterAll(() => rmSync(root, { recursive: true, force: true }));

describe('GET /api/projects/git-status', () => {
  it('answers at once and fills in as the sweep runs', async () => {
    const first = await GET();
    expect(first.headers.get('X-Sweep-Complete')).toBe('false');
    const body = await settled(['-clean', '-dirty']);
    expect(body['-clean']).toEqual({ dirty: 0, unpushed: 0, branch: 'main' });
    expect(body['-dirty']).toEqual({ dirty: 2, unpushed: 0, branch: 'feature/x' });
    expect('-plain' in body).toBe(false);
    expect('-unknown' in body).toBe(false);
    expect((await GET()).headers.get('X-Sweep-Complete')).toBe('true');
  });

  it('does not fork git again while a repository’s index and HEAD are unchanged', async () => {
    await settled(['-clean', '-dirty']);
    const before = gitRuns.length;
    for (let i = 0; i < 3; i++) await (await GET()).json();
    await new Promise((r) => setTimeout(r, 200));
    expect(gitRuns.length).toBe(before);
    expect(existsSync(path.join(repos['-clean'], '.git', 'index'))).toBe(true);
  });

  it('reports commits ahead of an upstream', async () => {
    // A bare remote, a push, then one more local commit.
    const bare = path.join(root, 'bare.git');
    git(root, 'init', '-q', '--bare', bare);
    const dir = repos['-clean'];
    git(dir, 'remote', 'add', 'origin', bare);
    git(dir, 'push', '-q', '-u', 'origin', 'main');
    writeFileSync(path.join(dir, 'c.txt'), 'three\n');
    git(dir, 'add', 'c.txt');
    git(dir, 'commit', '-q', '-m', 'three');
    // The commit rewrote index and HEAD, so the memo is stale for this repo.
    // Sweeps are rate-limited by the wall clock; move the clock, not the test.
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(Date.now() + 31_000);
    try {
      const body = await settled(['-clean']);
      for (let i = 0; i < 20 && (body['-clean'] as { unpushed: number }).unpushed !== 1; i++) {
        await new Promise((r) => setTimeout(r, 100));
        Object.assign(body, await (await GET()).json());
      }
      expect(body['-clean']).toEqual({ dirty: 0, unpushed: 1, branch: 'main' });
      expect(body['-dirty']).toEqual({ dirty: 2, unpushed: 0, branch: 'feature/x' });   // unchanged, memo reused
    } finally {
      vi.useRealTimers();
    }
  });
});
