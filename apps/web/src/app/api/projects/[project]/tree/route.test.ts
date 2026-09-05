import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from 'vitest';
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

/**
 * Asking for a ref instead of the working tree.
 *
 * This half only runs when `ref` is something other than HEAD, so browsing
 * never reaches it and neither did any test. It is where every git spawn
 * lives, and where a stray failure turns into a 500 that says nothing about
 * which path was missing.
 */
describe('GET with an explicit ref', () => {
  /** Answer each git subcommand from a table, so a test says what git said. */
  function git(answers: Record<string, string | Error>) {
    gitExec.mockImplementation((async (_repo: string, args: string[]) => {
      const key = args[0] === 'cat-file' ? 'cat-file' : args[0] === 'show' ? `show:${args[1]}` : args[0];
      const hit = answers[key] ?? answers[args[0]];
      if (hit === undefined) return '';
      if (hit instanceof Error) throw hit;
      return hit;
    }) as never);
  }

  beforeEach(() => { gitExec.mockReset(); });

  it('reads a file out of the ref, with its last commit', async () => {
    git({
      'cat-file': '0abc blob 26',
      'show:v1.0:src/index.ts': 'export const answer = 42;\n',
      log: 'deadbeef|bumped the answer|2 days ago',
    });
    const body = await (await get('?ref=v1.0&path=src/index.ts')).json();
    expect(body).toMatchObject({ type: 'file', name: 'index.ts', language: 'typescript', size: 26 });
    expect(body.lastCommit).toEqual({ hash: 'deadbeef', message: 'bumped the answer', age: '2 days ago' });
  });

  it('asks git for type and size in one spawn, not two', async () => {
    // This used to be `cat-file -t` then `cat-file -s`: two forks for two
    // numbers, and forking the Next server is the expensive part.
    git({ 'cat-file': '0abc blob 26', 'show:v1.0:src/index.ts': 'x', log: '' });
    await get('?ref=v1.0&path=src/index.ts');
    const catFiles = gitExec.mock.calls.filter((c: unknown[]) => (c[1] as string[])[0] === 'cat-file');
    expect(catFiles).toHaveLength(1);
    expect((catFiles[0] as unknown[])[1]).toContain('--batch-check');
  });

  it('refuses to inline a file too big to display, but still reports its size', async () => {
    // Sending a 4MB blob down to a browser tab hangs the viewer. The size
    // is still the real one, so the page can offer something else.
    git({ 'cat-file': `0abc blob ${4 * 1024 * 1024}`, 'show:v1.0:big.bin': 'x'.repeat(64), log: '' });
    const body = await (await get('?ref=v1.0&path=big.bin')).json();
    expect(body.size).toBe(4 * 1024 * 1024);
    expect(body.content).toBe('(file too large to display)');
  });

  it('leaves lastCommit null when a path has no history yet', async () => {
    // `git log` on a path git has never seen exits non-zero. A null here
    // is the honest answer; '||'.split gives empty strings, not a commit.
    git({ 'cat-file': '0abc blob 4', 'show:v1.0:new.ts': 'new\n', log: new Error('unknown revision') });
    const body = await (await get('?ref=v1.0&path=new.ts')).json();
    expect(body.lastCommit).toBeNull();
  });

  it('falls through to a listing when the path is a directory in that ref', async () => {
    // cat-file answers 'tree', which is not a blob, so the file branch
    // must not claim it.
    git({
      'cat-file': '0abc tree 100',
      'ls-tree': '100644 blob aaa    12\tindex.ts\n040000 tree bbb       -\tlib',
      log: 'c0ffee|moved things|an hour ago',
    });
    const body = await (await get('?ref=v1.0&path=src')).json();
    expect(body.type).toBe('tree');
    expect(body.entries.map((e: { name: string }) => e.name)).toEqual(['lib', 'index.ts']);
  });

  it('parses a name containing spaces, which only the tab separates', async () => {
    // ls-tree separates metadata from the name with a tab precisely because
    // a name may hold spaces. Splitting the whole line on whitespace loses it.
    git({ 'ls-tree': '100644 blob aaa    9\tmy notes.md', log: '' });
    const body = await (await get('?ref=v1.0')).json();
    expect(body.entries[0]).toMatchObject({ name: 'my notes.md', type: 'blob', size: 9 });
  });

  it('reports a directory as size zero rather than the dash git prints', async () => {
    git({ 'ls-tree': '040000 tree bbb       -\tlib', log: '' });
    expect((await (await get('?ref=v1.0')).json()).entries[0].size).toBe(0);
  });

  it('reads a README at the root of the ref and not in a subdirectory', async () => {
    git({
      'ls-tree': '100644 blob aaa   10\tREADME.md',
      'show:v1.0:README.md': '# from the tag\n',
      log: '',
    });
    expect((await (await get('?ref=v1.0')).json()).readme).toContain('# from the tag');
    git({ 'cat-file': '0abc tree 1', 'ls-tree': '100644 blob aaa   10\tREADME.md', log: '' });
    expect((await (await get('?ref=v1.0&path=src')).json()).readme).toBe('');
  });

  it('caps a README rather than shipping a book', async () => {
    git({
      'ls-tree': '100644 blob aaa 40000\tREADME.md',
      'show:v1.0:README.md': 'x'.repeat(40_000),
      log: '',
    });
    expect((await (await get('?ref=v1.0')).json()).readme).toHaveLength(10_000);
  });

  it('serves the listing even when the README will not read', async () => {
    // A README that is a symlink, or a submodule pointer, throws on show.
    // Losing the whole directory listing over it is the wrong trade.
    git({
      'ls-tree': '100644 blob aaa 10\tREADME.md',
      'show:v1.0:README.md': new Error('bad object'),
      log: '',
    });
    const body = await (await get('?ref=v1.0')).json();
    expect(body.readme).toBe('');
    expect(body.entries).toHaveLength(1);
  });

  it('says which path is missing rather than failing the whole operation', async () => {
    // Browsing carries a subdirectory across a project switch. The old 500
    // read as "Tree operation failed" and named nothing.
    const enoent = Object.assign(new Error('no such file'), { code: 'ENOENT' });
    git({ 'cat-file': enoent, 'ls-tree': enoent, log: enoent });
    const res = await get('?ref=v1.0&path=gone/');
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: 'No such path in this project', path: 'gone/' });
  });

  it('reports an unexpected git failure as a 500 that carries the detail', async () => {
    git({ 'cat-file': new Error('boom'), 'ls-tree': new Error('boom'), log: new Error('boom') });
    const res = await get('?ref=v1.0&path=src/');
    expect(res.status).toBe(500);
    expect((await res.json()).detail).toContain('boom');
  });
});
