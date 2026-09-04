import { NextResponse } from 'next/server';
import { readdir, readFile, stat } from 'fs/promises';
import path from 'path';
import { claudePaths } from '@unturf/unfirehose/claude-paths';
import { repoPathForProject } from '@unturf/unfirehose/db/repo-path';
import { gitExec } from '@unturf/unfirehose/git-exec';

/* Batch git status for all projects — returns dirty/unpushed counts.
   Designed to be fast: runs git commands in parallel with short timeouts. */

interface ProjectGitStatus {
  dirty: number;       // count of uncommitted changes
  unpushed: number;    // commits ahead of remote
  branch: string;
}

/**
 * Per-repo memo, keyed on the mtimes of .git/index and .git/HEAD.
 *
 * This route ran three git commands for each of 96 project directories —
 * about 288 spawns — and took 131 SECONDS while the projects page polled
 * it. git is instant; forking the Next process is not (~400ms each here).
 *
 * Nothing about a repository changes without its index or HEAD being
 * rewritten, except a brand-new untracked file. So: reuse the previous
 * answer while both mtimes are unchanged, and re-check anyway once a
 * minute so an untracked file cannot hide for long.
 */
const repoMemo = new Map<string, { indexMs: number; headMs: number; at: number; status: ProjectGitStatus | null }>();
const MEMO_MAX_AGE = 60_000;

async function gitStamps(repoPath: string): Promise<{ indexMs: number; headMs: number } | null> {
  try {
    const gitDir = path.join(repoPath, '.git');
    const [idx, head] = await Promise.all([
      stat(path.join(gitDir, 'index')).then((s) => s.mtimeMs).catch(() => 0),
      stat(path.join(gitDir, 'HEAD')).then((s) => s.mtimeMs).catch(() => 0),
    ]);
    if (!idx && !head) return null;   // not a checkout
    return { indexMs: idx, headMs: head };
  } catch {
    return null;
  }
}

/** Branch from .git/HEAD — one file read instead of one fork per repo. */
async function branchOf(repoPath: string): Promise<string> {
  try {
    const head = (await readFile(path.join(repoPath, '.git', 'HEAD'), 'utf-8')).trim();
    const m = /^ref:\s*refs\/heads\/(.+)$/.exec(head);
    return m ? m[1] : head.slice(0, 8);
  } catch {
    return '';
  }
}

async function getGitStatus(repoPath: string): Promise<ProjectGitStatus | null> {
  const stamps = await gitStamps(repoPath);
  if (!stamps) return null;

  const memo = repoMemo.get(repoPath);
  if (
    memo &&
    memo.indexMs === stamps.indexMs &&
    memo.headMs === stamps.headMs &&
    Date.now() - memo.at < MEMO_MAX_AGE
  ) {
    return memo.status;
  }

  let status: ProjectGitStatus | null = null;
  try {
    const [statusRaw, branch] = await Promise.all([
      gitExec(repoPath, ['status', '--porcelain'], { timeout: 5000 }),
      branchOf(repoPath),
    ]);

    const dirty = statusRaw.trim().split('\n').filter(Boolean).length;

    // Only ask about upstream when there is something to be ahead of.
    let unpushed = 0;
    try {
      const ahead = await gitExec(repoPath, ['rev-list', '--count', `@{upstream}..HEAD`], { timeout: 5000 });
      unpushed = parseInt(ahead.trim(), 10) || 0;
    } catch { /* no upstream configured */ }

    status = { dirty, unpushed, branch };
  } catch {
    status = null;
  }

  repoMemo.set(repoPath, { ...stamps, at: Date.now(), status });
  return status;
}

/**
 * The page never waits for the sweep.
 *
 * A full pass is 96 repositories, and `git status` on the big ones (large
 * untracked trees) is genuinely slow — 113 SECONDS cold, measured. Blocking
 * a poll on that is why the projects page sat empty. Whatever is known is
 * returned at once and a sweep runs behind the response, so the badges fill
 * in over the next poll or two instead of holding everything hostage.
 */
const known: Record<string, ProjectGitStatus> = {};
let sweeping = false;
let lastSweep = 0;
const SWEEP_INTERVAL = 30_000;

async function sweep() {
  if (sweeping || Date.now() - lastSweep < SWEEP_INTERVAL) return;
  sweeping = true;
  try {
    const dirs = await readdir(claudePaths.projects);
    const eligible = dirs
      .map((dir) => ({ dir, repoPath: repoPathForProject(dir) }))
      .filter((e): e is { dir: string; repoPath: string } => !!e.repoPath);

    // Concurrency cap: 85+ parallel git processes OOMs the server.
    const CONCURRENCY = 8;
    for (let i = 0; i < eligible.length; i += CONCURRENCY) {
      const batch = eligible.slice(i, i + CONCURRENCY);
      await Promise.all(
        batch.map(async ({ dir, repoPath }) => {
          const status = await getGitStatus(repoPath);
          // Publish each repo as it finishes, so a poll mid-sweep sees
          // progress rather than nothing.
          if (status) known[dir] = status;
          else delete known[dir];
        }),
      );
    }
  } catch { /* a sweep that fails leaves the previous answers in place */ } finally {
    lastSweep = Date.now();
    sweeping = false;
  }
}

export async function GET() {
  // Kick the sweep, do not await it.
  void sweep();
  return NextResponse.json(known, {
    headers: { 'X-Sweep-Complete': String(lastSweep > 0) },
  });
}
