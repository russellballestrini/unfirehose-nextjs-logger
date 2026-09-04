import { NextRequest, NextResponse } from 'next/server';
import { execFile } from 'child_process';
import { readdir, readFile, stat } from 'fs/promises';
import path from 'path';
import { Timing } from '@/lib/timing';
import { repoPathForProject } from '@unturf/unfirehose/db/repo-path';
import { gitExec } from '@unturf/unfirehose/git-exec';

/* eslint-disable @typescript-eslint/no-explicit-any */

const treeCache = new Map<string, { data: any; ts: number }>();

/**
 * Spawning git is the expensive part of this route, not git itself.
 *
 * Measured 2026-09-04: `git ls-tree` in a terminal is 0.00s, but each
 * gitExec from inside the Next server costs 300-400ms — forking a large,
 * busy Node process on a throttling laptop. Viewing one file ran four
 * spawns and one directory ran five, so the wait was almost entirely fork
 * cost. Every spawn removed below is worth more than any git flag.
 */
const branchCache = new Map<string, { branch: string; ts: number }>();
const BRANCH_TTL = 30_000;

async function currentBranch(repoPath: string): Promise<string> {
  const hit = branchCache.get(repoPath);
  if (hit && Date.now() - hit.ts < BRANCH_TTL) return hit.branch;
  const branch = (await gitExec(repoPath, ['rev-parse', '--abbrev-ref', 'HEAD'])).trim();
  branchCache.set(repoPath, { branch, ts: Date.now() });
  return branch;
}

/**
 * The branch, read from .git/HEAD rather than asked of git.
 *
 * Even an un-awaited spawn costs this route ~350ms: fork copies the page
 * tables of the Next process synchronously, so the event loop stalls in the
 * parent whether or not anyone waits for the child. `.git/HEAD` is one line
 * — `ref: refs/heads/main` — and reading it costs nothing.
 */
async function branchFromHead(repoPath: string): Promise<string | null> {
  const hit = branchCache.get(repoPath);
  if (hit && Date.now() - hit.ts < BRANCH_TTL) return hit.branch;
  try {
    let gitDir = path.join(repoPath, '.git');
    const st = await stat(gitDir);
    if (st.isFile()) {
      // A worktree or submodule: .git is a file naming the real directory.
      const pointer = (await readFile(gitDir, 'utf-8')).trim();
      const m = /^gitdir:\s*(.+)$/.exec(pointer);
      if (!m) return null;
      gitDir = path.isAbsolute(m[1]) ? m[1] : path.join(repoPath, m[1]);
    }
    const head = (await readFile(path.join(gitDir, 'HEAD'), 'utf-8')).trim();
    const ref = /^ref:\s*refs\/heads\/(.+)$/.exec(head);
    const branch = ref ? ref[1] : head.slice(0, 8);   // detached: show the sha
    branchCache.set(repoPath, { branch, ts: Date.now() });
    return branch;
  } catch {
    return null;
  }
}
const TREE_CACHE_TTL = 10_000; // 10 seconds
const TREE_CACHE_MAX = 100; // LRU cap

/**
 * Store one answer, evicting the oldest when full.
 *
 * The three call sites each wrote this out, and each had its own chance to
 * forget the eviction — a cache that only grows is a leak in a long-running
 * server.
 */
function cacheTree(key: string, data: unknown): void {
  if (treeCache.size >= TREE_CACHE_MAX) {
    const oldest = treeCache.keys().next().value;
    if (oldest) treeCache.delete(oldest);
  }
  treeCache.set(key, { data, ts: Date.now() });
}

// GET: file tree or file content
// ?path=<subpath> — browse directory or read file
/**
 * Is this directory a git checkout?
 *
 * ~/git holds directories that are not repositories — `thinking-room` is
 * files and tests with no `.git` at all. Every listing here went through
 * `git ls-tree`, so browsing one answered 500 and the Code tab showed an
 * error where the files plainly exist.
 */
async function isGitRepo(repoPath: string): Promise<boolean> {
  try {
    await gitExec(repoPath, ['rev-parse', '--git-dir'], { timeout: 3000 });
    return true;
  } catch {
    return false;
  }
}

/** Directories we never expand: enormous, uninteresting, and not the code. */
const SKIP_DIRS = new Set(['.git', 'node_modules', '.next', '__pycache__', '.venv', 'venv', '.pytest_cache', 'dist', 'build']);

/** Browse a plain directory. Same response shape as the git path, with the
 *  git-only fields null — a caller cannot tell which produced it. */
async function readFromDisk(repoPath: string, subpath: string) {
  const target = path.join(repoPath, subpath);
  // Never escape the project directory, whatever the query says.
  const resolved = path.resolve(target);
  if (resolved !== path.resolve(repoPath) && !resolved.startsWith(path.resolve(repoPath) + path.sep)) {
    return { error: 'path outside project' as const };
  }

  const st = await stat(resolved);
  if (st.isFile()) {
    const ext = subpath.split('.').pop() || '';
    const tooBig = st.size > 512 * 1024;
    return {
      type: 'file' as const,
      path: subpath,
      name: subpath.split('/').pop(),
      content: tooBig ? '(file too large to display)' : await readFile(resolved, 'utf-8').catch(() => '(binary or unreadable)'),
      size: st.size,
      language: EXT_TO_LANG[ext] || ext,
      lastCommit: null,
      vcs: false as const,
    };
  }

  const names = await readdir(resolved, { withFileTypes: true });
  const entries = await Promise.all(
    names
      .filter((d) => !SKIP_DIRS.has(d.name))
      .map(async (d) => ({
        name: d.name,
        type: d.isDirectory() ? ('tree' as const) : ('blob' as const),
        size: d.isDirectory() ? 0 : await stat(path.join(resolved, d.name)).then((x) => x.size).catch(() => 0),
      })),
  );
  entries.sort((a, b) => (a.type !== b.type ? (a.type === 'tree' ? -1 : 1) : a.name.localeCompare(b.name)));

  let readme = '';
  if (!subpath) {
    const readmeName = ['README.md', 'README', 'readme.md', 'README.txt'].find((n) => names.some((d) => d.name === n));
    if (readmeName) readme = await readFile(path.join(resolved, readmeName), 'utf-8').catch(() => '');
  }

  return {
    type: 'tree' as const,
    path: subpath || '',
    branch: null as string | null,
    entries,
    lastCommit: null,
    readme: readme.slice(0, 10000),
    vcs: false as const,
  };
}

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ project: string }> }
) {
  const { project } = await params;
  const t = new Timing();
  const repoPath = repoPathForProject(project);
  t.mark('resolve');
  if (!repoPath) {
    return NextResponse.json({ error: 'Could not resolve repo path' }, { status: 404 });
  }

  const url = new URL(request.url);
  const subpath = url.searchParams.get('path') || '';
  const ref = url.searchParams.get('ref') || 'HEAD';

  const cacheKey = `${project}:${subpath}:${ref}`;
  const cached = treeCache.get(cacheKey);
  if (cached && Date.now() - cached.ts < TREE_CACHE_TTL) {
    return NextResponse.json(cached.data);
  }

  try {
    // Read the working tree from disk unless a specific ref was asked for.
    //
    // Measured 2026-09-04: `git ls-tree` costs 0.00s in a terminal and three
    // spawns from a small node process cost 0.06s — but the same calls from
    // inside the Next server cost 1.5-4.3s, because forking a large, busy
    // process on a throttling laptop is the expensive part. Browsing one
    // directory ran five spawns. readdir runs none.
    //
    // It is also the more useful answer for a dashboard on your own machine:
    // the working tree includes what you have not committed yet. Asking for
    // a ref still goes through git, where history is the whole point.
    const wantsHistory = ref !== 'HEAD';
    if (!wantsHistory || !(await isGitRepo(repoPath))) {
      const result = await readFromDisk(repoPath, subpath);
      if ('error' in result) return NextResponse.json(result, { status: 400 });
      // Branch when we have it; otherwise it arrives on the next click.
      if (result.type === 'tree') result.branch = await branchFromHead(repoPath);
      cacheTree(cacheKey, result);
      t.mark('disk');
      return NextResponse.json(result, { headers: { 'Server-Timing': t.header() } });
    }

    // If subpath looks like it could be a file, try to cat it
    if (subpath && !subpath.endsWith('/')) {
      // Check if it's a file or directory in git
      try {
        // `--batch-check` answers type AND size in one spawn; it used to be
        // `cat-file -t` then `cat-file -s`, two forks for two numbers.
        const check = (await gitExec(repoPath, ['cat-file', '--batch-check'], {
          stdin: `${ref}:${subpath}\n`,
        })).trim();
        const [, objType, sizeRaw] = check.split(/\s+/);
        if (objType === 'blob') {
          const [content, lastCommitRaw] = await Promise.all([
            gitExec(repoPath, ['show', `${ref}:${subpath}`], { timeout: 15000 }),
            gitExec(repoPath, ['log', '-1', '--format=%H|%s|%ar', '--', subpath]).then(s => s.trim()).catch(() => ''),
          ]);
          const size = parseInt(sizeRaw, 10);

          const [commitHash, commitMsg, commitAge] = (lastCommitRaw || '||').split('|');
          const ext = subpath.split('.').pop() || '';
          const lang = EXT_TO_LANG[ext] || ext;

          const fileResult = {
            type: 'file',
            path: subpath,
            name: subpath.split('/').pop(),
            content: size > 512 * 1024 ? '(file too large to display)' : content,
            size,
            language: lang,
            lastCommit: commitHash ? { hash: commitHash, message: commitMsg, age: commitAge } : null,
          };
    cacheTree(cacheKey, fileResult);
          t.mark('git_file');
          return NextResponse.json(fileResult, { headers: { 'Server-Timing': t.header() } });
        }
      } catch {
        // Not a valid git object at this path — fall through to tree listing
      }
    }

    // Run all independent git operations in parallel
    const treePath = subpath ? `${ref}:${subpath}` : ref;
    const logPath = subpath || '.';

    const [treeRaw, lastCommitRaw, branch] = await Promise.all([
      // 1. List directory contents
      gitExec(repoPath, ['ls-tree', '--long', treePath]),
      // 2. Last commit for this directory
      gitExec(repoPath, ['log', '-1', '--format=%H|%s|%ar', '--', logPath]).then(s => s.trim()).catch(() => ''),
      // 3. Branch — cached per repo; it does not change between two clicks.
      currentBranch(repoPath),
    ]);

    const entries = treeRaw.trim().split('\n').filter(Boolean).map((line) => {
      // Format: <mode> <type> <hash> <size>\t<name>
      const tabIdx = line.indexOf('\t');
      const meta = line.slice(0, tabIdx).split(/\s+/);
      const name = line.slice(tabIdx + 1);
      return {
        name,
        type: meta[1] as 'blob' | 'tree',
        size: meta[1] === 'blob' ? parseInt(meta[3], 10) : 0,
      };
    });

    // Sort: directories first, then files, both alphabetical
    entries.sort((a, b) => {
      if (a.type !== b.type) return a.type === 'tree' ? -1 : 1;
      return a.name.localeCompare(b.name);
    });

    // The listing above already says whether a README is here, so the only
    // extra spawn is the one that reads it — there used to be a second
    // ls-tree just to ask the question.
    let readme = '';
    if (!subpath) {
      const readmeName = ['README.md', 'README', 'readme.md', 'README.txt']
        .find((n) => entries.some((e) => e.name === n && e.type === 'blob'));
      if (readmeName) {
        readme = await gitExec(repoPath, ['show', `${ref}:${readmeName}`], { timeout: 5000 }).catch(() => '');
      }
    }

    const [commitHash, commitMsg, commitAge] = (lastCommitRaw || '||').split('|');

    const treeResult = {
      type: 'tree',
      path: subpath || '',
      branch,
      entries,
      lastCommit: commitHash ? { hash: commitHash, message: commitMsg, age: commitAge } : null,
      readme: readme.slice(0, 10000), // cap at 10KB
      repoPath,
    };
    cacheTree(cacheKey, treeResult);
    t.mark('git_tree');
    return NextResponse.json(treeResult, { headers: { 'Server-Timing': t.header() } });
  } catch (err) {
    // A path that is not there is a 404 about that path, not a failure of
    // the whole operation. Browsing carries a subdirectory across a project
    // switch, and the old 500 read as "Tree operation failed" with no clue
    // which path was missing.
    if (err && typeof err === 'object' && (err as NodeJS.ErrnoException).code === 'ENOENT') {
      return NextResponse.json(
        { error: 'No such path in this project', path: subpath },
        { status: 404 },
      );
    }
    return NextResponse.json({ error: 'Tree operation failed', detail: String(err) }, { status: 500 });
  }
}

const EXT_TO_LANG: Record<string, string> = {
  ts: 'typescript', tsx: 'typescript', js: 'javascript', jsx: 'javascript',
  py: 'python', rs: 'rust', go: 'go', c: 'c', h: 'c', cpp: 'cpp',
  java: 'java', rb: 'ruby', sh: 'shell', bash: 'shell', zsh: 'shell',
  md: 'markdown', json: 'json', yaml: 'yaml', yml: 'yaml', toml: 'toml',
  css: 'css', html: 'html', sql: 'sql', mojo: 'mojo', cu: 'cuda',
  txt: 'text', cfg: 'text', conf: 'text', env: 'text',
  Makefile: 'makefile', Dockerfile: 'dockerfile',
};
