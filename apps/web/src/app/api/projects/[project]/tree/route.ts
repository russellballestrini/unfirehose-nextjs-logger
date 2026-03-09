import { NextRequest, NextResponse } from 'next/server';
import { execFile } from 'child_process';
import { readFile, stat } from 'fs/promises';
import { claudePaths } from '@unturf/unfirehose/claude-paths';
import type { SessionsIndex } from '@unturf/unfirehose/types';

/* eslint-disable @typescript-eslint/no-explicit-any */

function gitExec(cwd: string, args: string[], timeout = 10000): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile('git', args, { cwd, timeout, maxBuffer: 1024 * 1024 * 10 }, (err, stdout) => {
      if (err) reject(err);
      else resolve(stdout);
    });
  });
}

async function resolvePathFromName(name: string): Promise<string | null> {
  const parts = name.replace(/^-/, '').split('-');
  const gitIdx = parts.lastIndexOf('git');
  if (gitIdx < 0 || gitIdx >= parts.length - 1) return null;
  const prefix = '/' + parts.slice(0, gitIdx + 1).join('/');
  const projectParts = parts.slice(gitIdx + 1);
  const dashJoined = prefix + '/' + projectParts.join('-');
  try { if ((await stat(dashJoined)).isDirectory()) return dashJoined; } catch {}
  if (projectParts.length >= 2) {
    const lastPart = projectParts[projectParts.length - 1];
    if (['com', 'net', 'org', 'io', 'dev', 'ai', 'app'].includes(lastPart)) {
      const dotted = prefix + '/' + projectParts.slice(0, -1).join('-') + '.' + lastPart;
      try { if ((await stat(dotted)).isDirectory()) return dotted; } catch {}
      const allDots = prefix + '/' + projectParts.join('.');
      try { if ((await stat(allDots)).isDirectory()) return allDots; } catch {}
    }
  }
  return null;
}

async function resolveRepoPath(projectName: string): Promise<string | null> {
  try {
    const raw = await readFile(claudePaths.sessionsIndex(projectName), 'utf-8');
    const index: SessionsIndex = JSON.parse(raw);
    if (index.originalPath) return index.originalPath;
  } catch {}
  return resolvePathFromName(projectName);
}

// GET: file tree or file content
// ?path=<subpath> — browse directory or read file
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ project: string }> }
) {
  const { project } = await params;
  const repoPath = await resolveRepoPath(project);
  if (!repoPath) {
    return NextResponse.json({ error: 'Could not resolve repo path' }, { status: 404 });
  }

  const url = new URL(request.url);
  const subpath = url.searchParams.get('path') || '';
  const ref = url.searchParams.get('ref') || 'HEAD';

  try {
    // If subpath looks like it could be a file, try to cat it
    if (subpath && !subpath.endsWith('/')) {
      // Check if it's a file or directory in git
      try {
        const objType = (await gitExec(repoPath, ['cat-file', '-t', `${ref}:${subpath}`])).trim();
        if (objType === 'blob') {
          // It's a file — return its content
          const content = await gitExec(repoPath, ['show', `${ref}:${subpath}`], 15000);
          const sizeRaw = (await gitExec(repoPath, ['cat-file', '-s', `${ref}:${subpath}`])).trim();
          const size = parseInt(sizeRaw, 10);

          // Get last commit for this file
          let lastCommit = '';
          try {
            lastCommit = (await gitExec(repoPath, ['log', '-1', '--format=%H|%s|%ar', '--', subpath])).trim();
          } catch {}

          const [commitHash, commitMsg, commitAge] = lastCommit.split('|');
          const ext = subpath.split('.').pop() || '';
          const lang = EXT_TO_LANG[ext] || ext;

          return NextResponse.json({
            type: 'file',
            path: subpath,
            name: subpath.split('/').pop(),
            content: size > 512 * 1024 ? '(file too large to display)' : content,
            size,
            language: lang,
            lastCommit: commitHash ? { hash: commitHash, message: commitMsg, age: commitAge } : null,
          });
        }
      } catch {
        // Not a valid git object at this path — fall through to tree listing
      }
    }

    // List directory contents via git ls-tree
    const treePath = subpath ? `${ref}:${subpath}` : ref;
    const treeRaw = await gitExec(repoPath, ['ls-tree', '--long', treePath]);

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

    // Get last commit for this directory
    const logPath = subpath || '.';
    let lastCommit = '';
    try {
      lastCommit = (await gitExec(repoPath, ['log', '-1', '--format=%H|%s|%ar', '--', logPath])).trim();
    } catch {}
    const [commitHash, commitMsg, commitAge] = (lastCommit || '||').split('|');

    // Get branch info
    const branch = (await gitExec(repoPath, ['rev-parse', '--abbrev-ref', 'HEAD'])).trim();

    // Get README if at root
    let readme = '';
    if (!subpath) {
      for (const name of ['README.md', 'README', 'readme.md', 'README.txt']) {
        try {
          readme = await gitExec(repoPath, ['show', `${ref}:${name}`], 5000);
          if (readme) break;
        } catch {}
      }
    }

    return NextResponse.json({
      type: 'tree',
      path: subpath || '',
      branch,
      entries,
      lastCommit: commitHash ? { hash: commitHash, message: commitMsg, age: commitAge } : null,
      readme: readme.slice(0, 10000), // cap at 10KB
      repoPath,
    });
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
