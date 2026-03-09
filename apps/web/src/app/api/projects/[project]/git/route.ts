import { NextRequest, NextResponse } from 'next/server';
import { execFile } from 'child_process';
import { readFile, stat } from 'fs/promises';
import { claudePaths } from '@unturf/unfirehose/claude-paths';
import { getSetting } from '@unturf/unfirehose/db/ingest';
import type { SessionsIndex } from '@unturf/unfirehose/types';

/* eslint-disable @typescript-eslint/no-explicit-any */

function gitExec(cwd: string, args: string[], timeout = 10000): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile('git', args, { cwd, timeout, maxBuffer: 1024 * 1024 * 5 }, (err, stdout) => {
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

  // Try exact dash-joined name
  const dashJoined = prefix + '/' + projectParts.join('-');
  try { if ((await stat(dashJoined)).isDirectory()) return dashJoined; } catch {}

  // Try TLD patterns (e.g. unsandbox-com → unsandbox.com)
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
  // Try sessions-index.json first
  try {
    const raw = await readFile(claudePaths.sessionsIndex(projectName), 'utf-8');
    const index: SessionsIndex = JSON.parse(raw);
    if (index.originalPath) return index.originalPath;
  } catch {}
  // Fall back to deriving from project directory name
  return resolvePathFromName(projectName);
}

// GET: return git status + diff for a project
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ project: string }> }
) {
  const { project } = await params;
  const repoPath = await resolveRepoPath(project);
  if (!repoPath) {
    return NextResponse.json({ error: 'Could not resolve repo path' }, { status: 404 });
  }

  try {
    const [statusRaw, diffStaged, diffUnstaged, branch, logRaw] = await Promise.all([
      gitExec(repoPath, ['status', '--porcelain']),
      gitExec(repoPath, ['diff', '--cached', '--stat']),
      gitExec(repoPath, ['diff', '--stat']),
      gitExec(repoPath, ['rev-parse', '--abbrev-ref', 'HEAD']),
      gitExec(repoPath, ['log', '--oneline', '-5']),
    ]);

    // Full unified diff (staged + unstaged)
    const fullDiff = await gitExec(repoPath, ['diff', 'HEAD']);

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

    return NextResponse.json({
      repoPath,
      branch: branch.trim(),
      files,
      diffStat: (diffStaged.trim() + '\n' + diffUnstaged.trim()).trim(),
      diff: fullDiff,
      recentCommits: logRaw.trim(),
      isDirty: files.length > 0,
    });
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
  const repoPath = await resolveRepoPath(project);
  if (!repoPath) {
    return NextResponse.json({ error: 'Could not resolve repo path' }, { status: 404 });
  }

  try {
    const body = await request.json();
    const { message, addAll, action } = body;

    // Push-only action
    if (action === 'push') {
      const pushOut = await gitExec(repoPath, ['push'], 30000);
      return NextResponse.json({ success: true, pushed: true, output: pushOut.trim() });
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

    // Auto-push if setting enabled (default: true)
    const autoPush = getSetting('git_auto_push') !== 'false';
    let pushed = false;
    let pushError: string | undefined;
    if (autoPush) {
      try {
        await gitExec(repoPath, ['push'], 30000);
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
