import { NextResponse } from 'next/server';
import { execFile } from 'child_process';
import { readdir, readFile, stat } from 'fs/promises';
import { claudePaths } from '@unturf/unfirehose/claude-paths';
import type { SessionsIndex } from '@unturf/unfirehose/types';

/* Batch git status for all projects — returns dirty/unpushed counts.
   Designed to be fast: runs git commands in parallel with short timeouts. */

function gitExec(cwd: string, args: string[], timeout = 3000): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile('git', args, { cwd, timeout, maxBuffer: 256 * 1024 }, (err, stdout) => {
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

interface ProjectGitStatus {
  dirty: number;       // count of uncommitted changes
  unpushed: number;    // commits ahead of remote
  branch: string;
}

async function getGitStatus(repoPath: string): Promise<ProjectGitStatus | null> {
  try {
    const [statusRaw, branchRaw] = await Promise.all([
      gitExec(repoPath, ['status', '--porcelain']),
      gitExec(repoPath, ['rev-parse', '--abbrev-ref', 'HEAD']),
    ]);

    const dirty = statusRaw.trim().split('\n').filter(Boolean).length;
    const branch = branchRaw.trim();

    // Count unpushed commits
    let unpushed = 0;
    try {
      const ahead = await gitExec(repoPath, ['rev-list', '--count', `@{upstream}..HEAD`]);
      unpushed = parseInt(ahead.trim(), 10) || 0;
    } catch { /* no upstream configured */ }

    return { dirty, unpushed, branch };
  } catch {
    return null;
  }
}

// Cache: refreshes every 30s
let cache: { data: Record<string, ProjectGitStatus>; ts: number } | null = null;
const CACHE_TTL = 30_000;

export async function GET() {
  if (cache && Date.now() - cache.ts < CACHE_TTL) {
    return NextResponse.json(cache.data);
  }

  try {
    const dirs = await readdir(claudePaths.projects);
    const results: Record<string, ProjectGitStatus> = {};

    // Resolve all paths in parallel
    const entries = await Promise.all(
      dirs.map(async (dir) => {
        const repoPath = await resolveRepoPath(dir);
        return { dir, repoPath };
      })
    );

    // Get git status with concurrency cap — 85+ parallel git processes OOMs the server
    const CONCURRENCY = 8;
    const eligible = entries.filter((e) => e.repoPath);
    const statuses: Array<{ dir: string; status: ProjectGitStatus | null }> = [];
    for (let i = 0; i < eligible.length; i += CONCURRENCY) {
      const batch = eligible.slice(i, i + CONCURRENCY);
      const batchResults = await Promise.all(
        batch.map(async ({ dir, repoPath }) => {
          const status = await getGitStatus(repoPath!);
          return { dir, status };
        })
      );
      statuses.push(...batchResults);
    }

    for (const { dir, status } of statuses) {
      if (status) results[dir] = status;
    }

    cache = { data: results, ts: Date.now() };
    return NextResponse.json(results);
  } catch (err) {
    return NextResponse.json(
      { error: 'Failed to fetch git status', detail: String(err) },
      { status: 500 }
    );
  }
}
