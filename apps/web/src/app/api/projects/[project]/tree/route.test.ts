import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

/**
 * Browsing a project's files.
 *
 * This route answers from the working tree on disk rather than from git,
 * because forking git from inside the Next server costs 300-400ms a spawn
 * and browsing one directory used to run five. That decision is what these
 * check: the disk path is the default, it produces the same response shape
 * the git path does, and it refuses to leave the project directory.
 *
 * A real temp repo, because what is under test is reading a filesystem.
 */

const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'unfirehose-tree-'));
let repoPath: string | null = repo;

vi.mock('@unturf/unfirehose/db/repo-path', () => ({ repoPathForProject: () => repoPath }));
const gitExec = vi.fn(async () => '');
vi.mock('@unturf/unfirehose/git-exec', () => ({ gitExec: (...a: unknown[]) => gitExec(...(a as [])) }));

const { GET } = await import('./route');

beforeAll(() => {
  fs.mkdirSync(path.join(repo, 'src'), { recursive: true });
  fs.mkdirSync(path.join(repo, 'node_modules', 'left-pad'), { recursive: true });
  fs.mkdirSync(path.join(repo, '.git'), { recursive: true });
  fs.writeFileSync(path.join(repo, '.git', 'HEAD'), 'ref: refs/heads/main\n');
  fs.writeFileSync(path.join(repo, 'README.md'), '# demo\n\nwhat this is.\n');
  fs.writeFileSync(path.join(repo, 'src', 'index.ts'), 'export const answer = 42;\n');
  fs.writeFileSync(path.join(repo, 'src', 'notes.txt'), 'plain\n');
});
afterAll(() => fs.rmSync(repo, { recursive: true, force: true }));

/** A fresh path each call, since the route caches by (project, path, ref). */
let n = 0;
const get = (query = '') =>
  GET(
    { url: `http://localhost:3000/api/projects/p/tree${query}` } as never,
    { params: Promise.resolve({ project: `demo-${n++}` }) },
  );

describe('GET /api/projects/[project]/tree', () => {
  it('says it cannot find the repo rather than reading someone else\'s', async () => {
    repoPath = null;
    const res = await get();
    expect(res.status).toBe(404);
    repoPath = repo;
  });

  it('lists a directory without spawning git', async () => {
    const body = await (await get()).json();
    expect(body.type).toBe('tree');
    expect(gitExec).not.toHaveBeenCalled();
    expect(body.entries.map((e: { name: string }) => e.name)).toEqual(['src', 'README.md']);
  });

  it('puts directories before files, each alphabetically', async () => {
    const body = await (await get('?path=src')).json();
    expect(body.entries.map((e: { name: string }) => e.name)).toEqual(['index.ts', 'notes.txt']);
  });

  it('never expands node_modules', async () => {
    // Tens of thousands of entries, and none of them the code.
    const body = await (await get()).json();
    expect(body.entries.map((e: { name: string }) => e.name)).not.toContain('node_modules');
  });

  it('reads the branch out of .git/HEAD instead of asking git for it', async () => {
    // Even an un-awaited spawn stalls this route: fork copies the page
    // tables of the Next process synchronously.
    const body = await (await get()).json();
    expect(body.branch).toBe('main');
    expect(gitExec).not.toHaveBeenCalled();
  });

  it('shows a README at the root and not in a subdirectory', async () => {
    expect((await (await get()).json()).readme).toContain('# demo');
    expect((await (await get('?path=src')).json()).readme).toBe('');
  });

  it('returns a file with its language, so the viewer can colour it', async () => {
    const body = await (await get('?path=src/index.ts')).json();
    expect(body).toMatchObject({ type: 'file', name: 'index.ts', language: 'typescript' });
    expect(body.content).toContain('answer = 42');
  });

  it('marks a disk answer as having no version control, so a caller cannot mistake it', async () => {
    const body = await (await get('?path=src/index.ts')).json();
    expect(body.vcs).toBe(false);
    expect(body.lastCommit).toBeNull();
  });

  it('refuses a path that climbs out of the project', async () => {
    // The subpath comes straight off a query string. Joining it blind
    // serves any file the dashboard's user can read.
    const res = await get('?path=../../../etc/passwd');
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe('path outside project');
  });

  it('reads an absolute-looking path as relative to the project', async () => {
    // path.join treats a leading slash as no different from any other
    // separator, so this asks for <repo>/etc/passwd — which does not
    // exist. The file it names is never reachable.
    const res = await get('?path=/etc/passwd');
    expect(res.status).toBe(404);
  });

  it('serves the same directory from cache on a second read', async () => {
    // Ten seconds of cache is what makes clicking through a tree feel
    // instant; without it every click re-walks the directory.
    const first = await GET(
      { url: 'http://localhost:3000/api/projects/p/tree' } as never,
      { params: Promise.resolve({ project: 'cached' }) },
    );
    expect(first.headers.get('Server-Timing')).toBeTruthy();
    const second = await GET(
      { url: 'http://localhost:3000/api/projects/p/tree' } as never,
      { params: Promise.resolve({ project: 'cached' }) },
    );
    expect(second.headers.get('Server-Timing')).toBeNull();
    expect(await second.json()).toEqual(await first.json());
  });
});
