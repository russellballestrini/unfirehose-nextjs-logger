import { NextRequest, NextResponse } from 'next/server';
import { execFile } from 'child_process';
import { readdir, readFile, stat } from 'fs/promises';
import path from 'path';
import { repoPathForProject } from '@unturf/unfirehose/db/repo-path';

/* eslint-disable @typescript-eslint/no-explicit-any */

const treeCache = new Map<string, { data: any; ts: number }>();
const TREE_CACHE_TTL = 10_000; // 10 seconds
const TREE_CACHE_MAX = 100; // LRU cap

function gitExec(cwd: string, args: string[], timeout = 10000): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile('git', args, { cwd, timeout, maxBuffer: 1024 * 1024 * 10 }, (err, stdout) => {
      if (err) reject(err);
      else resolve(stdout);
    });
  });
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
    await gitExec(repoPath, ['rev-parse', '--git-dir'], 3000);
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
    branch: null,
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
  const repoPath = repoPathForProject(project);
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
    // A directory without a checkout is still browsable; only its history
    // is missing.
    if (!(await isGitRepo(repoPath))) {
      const result = await readFromDisk(repoPath, subpath);
      if ('error' in result) return NextResponse.json(result, { status: 400 });
      if (treeCache.size >= TREE_CACHE_MAX) {
        const oldest = treeCache.keys().next().value;
        if (oldest) treeCache.delete(oldest);
      }
      treeCache.set(cacheKey, { data: result, ts: Date.now() });
      return NextResponse.json(result);
    }

    // If subpath looks like it could be a file, try to cat it
    if (subpath && !subpath.endsWith('/')) {
      // Check if it's a file or directory in git
      try {
        const objType = (await gitExec(repoPath, ['cat-file', '-t', `${ref}:${subpath}`])).trim();
        if (objType === 'blob') {
          // Fetch content, size, and last commit in parallel
          const [content, sizeRaw, lastCommitRaw] = await Promise.all([
            gitExec(repoPath, ['show', `${ref}:${subpath}`], 15000),
            gitExec(repoPath, ['cat-file', '-s', `${ref}:${subpath}`]).then(s => s.trim()),
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
          if (treeCache.size >= TREE_CACHE_MAX) {
            const oldest = treeCache.keys().next().value;
            if (oldest) treeCache.delete(oldest);
          }
          treeCache.set(cacheKey, { data: fileResult, ts: Date.now() });
          return NextResponse.json(fileResult);
        }
      } catch {
        // Not a valid git object at this path — fall through to tree listing
      }
    }

    // Run all independent git operations in parallel
    const treePath = subpath ? `${ref}:${subpath}` : ref;
    const logPath = subpath || '.';

    const [treeRaw, lastCommitRaw, branch, readmeResult] = await Promise.all([
      // 1. List directory contents
      gitExec(repoPath, ['ls-tree', '--long', treePath]),
      // 2. Last commit for this directory
      gitExec(repoPath, ['log', '-1', '--format=%H|%s|%ar', '--', logPath]).then(s => s.trim()).catch(() => ''),
      // 3. Branch info
      gitExec(repoPath, ['rev-parse', '--abbrev-ref', 'HEAD']).then(s => s.trim()),
      // 4. README — single ls-tree check then one show, instead of up to 4 blind attempts
      !subpath
        ? gitExec(repoPath, ['ls-tree', '--name-only', ref]).then(async (names) => {
            const files = names.trim().split('\n');
            const readmeName = ['README.md', 'README', 'readme.md', 'README.txt'].find(n => files.includes(n));
            if (!readmeName) return '';
            try { return await gitExec(repoPath, ['show', `${ref}:${readmeName}`], 5000); } catch { return ''; }
          }).catch(() => '')
        : Promise.resolve(''),
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

    const [commitHash, commitMsg, commitAge] = (lastCommitRaw || '||').split('|');

    const treeResult = {
      type: 'tree',
      path: subpath || '',
      branch,
      entries,
      lastCommit: commitHash ? { hash: commitHash, message: commitMsg, age: commitAge } : null,
      readme: readmeResult.slice(0, 10000), // cap at 10KB
      repoPath,
    };
    if (treeCache.size >= TREE_CACHE_MAX) {
      const oldest = treeCache.keys().next().value;
      if (oldest) treeCache.delete(oldest);
    }
    treeCache.set(cacheKey, { data: treeResult, ts: Date.now() });
    return NextResponse.json(treeResult);
  } catch (err) {
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
