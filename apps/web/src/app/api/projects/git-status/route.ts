import { NextResponse } from 'next/server';
import { execFile } from 'child_process';
import { readdir } from 'fs/promises';
import { claudePaths } from '@unturf/unfirehose/claude-paths';
import { repoPathForProject } from '@unturf/unfirehose/db/repo-path';

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
        const repoPath = repoPathForProject(dir);
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
