import { NextRequest, NextResponse } from 'next/server';
import { execFile } from 'child_process';
import { readFile, unlink, appendFile } from 'fs/promises';
import { join } from 'path';
import { getSetting } from '@unturf/unfirehose/db/ingest';
import { repoPathForProject } from '@unturf/unfirehose/db/repo-path';
import { gitExec } from '@unturf/unfirehose/git-exec';

/* eslint-disable @typescript-eslint/no-explicit-any */

const gitCache = new Map<string, { data: any; ts: number }>();
const GIT_CACHE_TTL = 5_000; // 5 seconds

// GET: return git status + diff for a project
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ project: string }> }
) {
  const { project } = await params;

  const cacheKey = project;
  const cached = gitCache.get(cacheKey);
  if (cached && Date.now() - cached.ts < GIT_CACHE_TTL) {
    return NextResponse.json(cached.data);
  }

  const repoPath = repoPathForProject(project);
  if (!repoPath) {
    return NextResponse.json({ error: 'Could not resolve repo path' }, { status: 404 });
  }

  try {
    // A tracked directory need not be a checkout — ~/git/thinking-room is
    // files and tests with no .git. That is not an error, it is a project
    // without history, and saying so beats a 500 the UI renders as a
    // failure to find the path.
    try {
      await gitExec(repoPath, ['rev-parse', '--git-dir'], { timeout: 3000 });
    } catch {
      const notARepo = {
        repoPath, branch: null, files: [], diffStat: '', diff: '',
        recentCommits: '', isDirty: false, vcs: false as const,
      };
      gitCache.set(cacheKey, { data: notARepo, ts: Date.now() });
      return NextResponse.json(notARepo);
    }

    const [statusRaw, diffStat, branch, logRaw, fullDiff] = await Promise.all([
      gitExec(repoPath, ['status', '--porcelain']),
      gitExec(repoPath, ['diff', 'HEAD', '--stat']),
      gitExec(repoPath, ['rev-parse', '--abbrev-ref', 'HEAD']),
      gitExec(repoPath, ['log', '--oneline', '-5']),
      gitExec(repoPath, ['diff', 'HEAD']),
    ]);

    // Parse status into structured files
    // git status --porcelain format: XY<space>filename
    // XY is 2 chars (index + worktree status), may include leading space (e.g. " M")
    // Robust: match first non-space char(s) then skip whitespace to get filename
    const files = statusRaw.trim().split('\n').filter(Boolean).map((line) => {
      // Try standard 2-char XY format first (handles " M", "M ", "??", "MM", etc.)
      if (line.length >= 4 && (line[2] === ' ' || line[2] === '\t')) {
        return { status: line.slice(0, 2).trim(), file: line.slice(3) };
      }
      // Fallback: split on first whitespace run
      const match = line.match(/^(\S+)\s+(.+)$/);
      if (match) return { status: match[1], file: match[2] };
      return { status: '?', file: line.trim() };
    });

    const result = {
      repoPath,
      branch: branch.trim(),
      files,
      diffStat: diffStat.trim(),
      diff: fullDiff,
      recentCommits: logRaw.trim(),
      isDirty: files.length > 0,
    };
    gitCache.set(cacheKey, { data: result, ts: Date.now() });
    return NextResponse.json(result);
  } catch (err) {
    return NextResponse.json({ error: 'Git operation failed', detail: String(err) }, { status: 500 });
  }
}

// POST: commit changes
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ project: string }> }
) {
  const { project } = await params;
  const repoPath = repoPathForProject(project);
  if (!repoPath) {
    return NextResponse.json({ error: 'Could not resolve repo path' }, { status: 404 });
  }

  gitCache.delete(project);

  try {
    const body = await request.json();
    const { message, addAll, action, skipPush } = body;

    // Push-only action — auto rebase-and-retry if remote is ahead
    if (action === 'push') {
      try {
        const pushOut = await gitExec(repoPath, ['push'], { timeout: 30000 });
        return NextResponse.json({ success: true, pushed: true, output: pushOut.trim() });
      } catch (pushErr: any) {
        const msg = String(pushErr.message || pushErr);
        // Remote has commits we don't have — rebase and retry
        if (msg.includes('fetch first') || msg.includes('failed to push') || msg.includes('rejected')) {
          try {
            await gitExec(repoPath, ['pull', '--rebase'], { timeout: 30000 });
          } catch (rebaseErr: any) {
            // Conflict — abort so the repo isn't left mid-rebase
            await gitExec(repoPath, ['rebase', '--abort']).catch(() => {});
            return NextResponse.json({ success: false, error: 'Remote has conflicts that need manual resolution' }, { status: 409 });
          }
          const retryOut = await gitExec(repoPath, ['push'], { timeout: 30000 });
          return NextResponse.json({ success: true, pushed: true, rebased: true, output: retryOut.trim() });
        }
        throw pushErr;
      }
    }

    if (!message || typeof message !== 'string' || message.trim().length === 0) {
      return NextResponse.json({ error: 'Commit message required' }, { status: 400 });
    }

    // Stage files
    if (addAll) {
      await gitExec(repoPath, ['add', '-A']);
    } else {
      // Only stage tracked modified files (safer default)
      await gitExec(repoPath, ['add', '-u']);
    }

    // Check if there's anything staged
    const staged = await gitExec(repoPath, ['diff', '--cached', '--stat']);
    if (!staged.trim()) {
      return NextResponse.json({ error: 'Nothing staged to commit' }, { status: 400 });
    }

    // Commit
    await gitExec(repoPath, ['commit', '-m', message.trim()]);

    // Get the new commit info
    const newCommit = await gitExec(repoPath, ['log', '--oneline', '-1']);

    // Skip push if caller handles it separately (e.g. for step-by-step UI feedback)
    if (skipPush) {
      return NextResponse.json({ success: true, commit: newCommit.trim(), pushed: false });
    }

    // Auto-push if setting enabled (default: true)
    const autoPush = getSetting('git_auto_push') !== 'false';
    let pushed = false;
    let pushError: string | undefined;
    if (autoPush) {
      try {
        await gitExec(repoPath, ['push'], { timeout: 30000 });
        pushed = true;
      } catch (err: any) {
        pushError = String(err.message || err);
      }
    }

    return NextResponse.json({
      success: true,
      commit: newCommit.trim(),
      pushed,
      pushError,
    });
  } catch (err) {
    return NextResponse.json({ error: 'Commit failed', detail: String(err) }, { status: 500 });
  }
}

// DELETE: remove a file or add it to .gitignore
export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ project: string }> }
) {
  const { project } = await params;
  const repoPath = repoPathForProject(project);
  if (!repoPath) {
    return NextResponse.json({ error: 'Could not resolve repo path' }, { status: 404 });
  }

  gitCache.delete(project);

  try {
    const body = await request.json();
    const { file, action } = body;

    if (!file || typeof file !== 'string') {
      return NextResponse.json({ error: 'File path required' }, { status: 400 });
    }

    // Prevent path traversal
    if (file.includes('..') || file.startsWith('/')) {
      return NextResponse.json({ error: 'Invalid file path' }, { status: 400 });
    }

    if (action === 'gitignore') {
      // Append to .gitignore
      const gitignorePath = join(repoPath, '.gitignore');
      const entry = file + '\n';
      // Check if already in .gitignore
      try {
        const existing = await readFile(gitignorePath, 'utf-8');
        if (existing.split('\n').some((l) => l.trim() === file.trim())) {
          return NextResponse.json({ success: true, action: 'gitignore', note: 'Already in .gitignore' });
        }
        // Ensure we append on a new line
        const needsNewline = existing.length > 0 && !existing.endsWith('\n');
        await appendFile(gitignorePath, (needsNewline ? '\n' : '') + entry);
      } catch {
        // .gitignore doesn't exist yet
        await appendFile(gitignorePath, entry);
      }
      // Remove from git tracking if tracked
      try {
        await gitExec(repoPath, ['rm', '--cached', file]);
      } catch { /* not tracked — that's fine */ }
      return NextResponse.json({ success: true, action: 'gitignore', file });
    }

    if (action === 'delete') {
      const fullPath = join(repoPath, file);
      // Remove from git index first (handles both tracked and staged)
      try {
        await gitExec(repoPath, ['rm', '-f', file]);
      } catch {
        // Not tracked — delete from filesystem directly
        await unlink(fullPath);
      }
      return NextResponse.json({ success: true, action: 'delete', file });
    }

    if (action === 'restore') {
      // Unstage staged changes (handles staged deletion, staged addition, etc.)
      try {
        await gitExec(repoPath, ['restore', '--staged', file]);
      } catch { /* not staged — that's fine */ }
      // Also restore working tree if file is missing (e.g. after git rm)
      try {
        await gitExec(repoPath, ['restore', file]);
      } catch { /* not in HEAD — that's fine */ }
      return NextResponse.json({ success: true, action: 'restore', file });
    }

    return NextResponse.json({ error: 'Unknown action — use "delete", "gitignore", or "restore"' }, { status: 400 });
  } catch (err) {
    return NextResponse.json({ error: 'File operation failed', detail: String(err) }, { status: 500 });
  }
}
