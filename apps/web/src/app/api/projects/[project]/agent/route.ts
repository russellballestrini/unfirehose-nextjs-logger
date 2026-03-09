import { NextRequest, NextResponse } from 'next/server';
import { execFile } from 'child_process';
import { readFile } from 'fs/promises';
import { getDb } from '@unturf/unfirehose/db/schema';
import { getProjectRecentPrompts } from '@unturf/unfirehose/db/ingest';
import { claudePaths } from '@unturf/unfirehose/claude-paths';
import type { SessionsIndex } from '@unturf/unfirehose/types';

/* eslint-disable @typescript-eslint/no-explicit-any */

function gitExec(cwd: string, args: string[], timeout = 10000): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile('git', args, { cwd, timeout, maxBuffer: 1024 * 1024 * 5 }, (err, stdout) => {
      if (err) reject(err);
      else resolve(stdout.trim());
    });
  });
}

async function resolveRepoPath(projectName: string): Promise<string | null> {
  try {
    const raw = await readFile(claudePaths.sessionsIndex(projectName), 'utf-8');
    const index: SessionsIndex = JSON.parse(raw);
    return index.originalPath ?? null;
  } catch {
    return null;
  }
}

interface GitSnapshot {
  branch: string;
  isDirty: boolean;
  dirtyFiles: string[];
  unpushedCount: number;
  unpushedCommits: string[];
  diffStat: string;
  lastCommitAge: string | null;
}

async function getGitSnapshot(repoPath: string): Promise<GitSnapshot | null> {
  try {
    const [statusRaw, branch, unpushedRaw, diffStat, lastCommitDate] = await Promise.all([
      gitExec(repoPath, ['status', '--porcelain']),
      gitExec(repoPath, ['rev-parse', '--abbrev-ref', 'HEAD']),
      gitExec(repoPath, ['log', '--oneline', '@{upstream}..HEAD']).catch(() => ''),
      gitExec(repoPath, ['diff', '--stat', 'HEAD']).catch(() => ''),
      gitExec(repoPath, ['log', '-1', '--format=%aI']).catch(() => null),
    ]);

    const dirtyFiles = statusRaw.split('\n').filter(Boolean).map(l => l.trim());
    const unpushedCommits = unpushedRaw ? unpushedRaw.split('\n').filter(Boolean) : [];

    let lastCommitAge: string | null = null;
    if (lastCommitDate) {
      const ageMs = Date.now() - new Date(lastCommitDate).getTime();
      if (ageMs < 60_000) lastCommitAge = 'just now';
      else if (ageMs < 3_600_000) lastCommitAge = `${Math.floor(ageMs / 60_000)}m ago`;
      else if (ageMs < 86_400_000) lastCommitAge = `${Math.floor(ageMs / 3_600_000)}h ago`;
      else lastCommitAge = `${Math.floor(ageMs / 86_400_000)}d ago`;
    }

    return {
      branch,
      isDirty: dirtyFiles.length > 0,
      dirtyFiles,
      unpushedCount: unpushedCommits.length,
      unpushedCommits,
      diffStat,
      lastCommitAge,
    };
  } catch {
    return null;
  }
}

// GET: list recent actions for a project
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ project: string }> }
) {
  const { project } = await params;
  const db = getDb();
  const actions = db.prepare(
    'SELECT * FROM agent_actions WHERE project_name = ? ORDER BY created_at DESC LIMIT 20'
  ).all(project);
  return NextResponse.json({ actions });
}

// POST: dispatch an action
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ project: string }> }
) {
  const { project } = await params;
  const body = await request.json();
  const action = body.action as string;

  if (!['status', 'finish', 'blockers'].includes(action)) {
    return NextResponse.json({ error: 'action must be status, finish, or blockers' }, { status: 400 });
  }

  const repoPath = await resolveRepoPath(project);
  if (!repoPath) {
    return NextResponse.json({ error: 'Could not resolve repo path' }, { status: 404 });
  }

  const db = getDb();
  const git = await getGitSnapshot(repoPath);
  const prompts = getProjectRecentPrompts(project, 5) as any[];

  // Record the action
  const row = db.prepare(`
    INSERT INTO agent_actions (project_name, action, status, trigger_type, request_context)
    VALUES (?, ?, 'running', ?, ?)
  `).run(project, action, body.trigger ?? 'manual', JSON.stringify({ git, repoPath }));
  const actionId = row.lastInsertRowid;

  try {
    let result: any;

    if (action === 'status') {
      result = buildStatus(git, prompts, repoPath);
    } else if (action === 'finish') {
      result = await executeFinish(git, repoPath, body.message);
    } else if (action === 'blockers') {
      result = buildBlockers(git, prompts, repoPath);
    }

    db.prepare(
      "UPDATE agent_actions SET status = 'done', result = ?, completed_at = datetime('now') WHERE id = ?"
    ).run(JSON.stringify(result), actionId);

    return NextResponse.json({ ok: true, actionId, result });
  } catch (err: any) {
    db.prepare(
      "UPDATE agent_actions SET status = 'failed', result = ?, completed_at = datetime('now') WHERE id = ?"
    ).run(JSON.stringify({ error: err.message }), actionId);
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}

function buildStatus(git: GitSnapshot | null, prompts: any[], repoPath: string) {
  const lines: string[] = [];

  if (!git) {
    return { summary: 'Could not read git state', lines: [], severity: 'error' };
  }

  // Branch
  lines.push(`Branch: ${git.branch}`);

  // Dirty state
  if (git.isDirty) {
    lines.push(`${git.dirtyFiles.length} uncommitted file(s):`);
    for (const f of git.dirtyFiles.slice(0, 10)) lines.push(`  ${f}`);
    if (git.dirtyFiles.length > 10) lines.push(`  ... and ${git.dirtyFiles.length - 10} more`);
  } else {
    lines.push('Working tree clean');
  }

  // Unpushed
  if (git.unpushedCount > 0) {
    lines.push(`${git.unpushedCount} unpushed commit(s):`);
    for (const c of git.unpushedCommits.slice(0, 5)) lines.push(`  ${c}`);
  }

  // Diff stat
  if (git.diffStat) {
    lines.push('');
    lines.push(git.diffStat);
  }

  // Last activity
  if (prompts.length > 0) {
    const last = prompts[0];
    lines.push('');
    lines.push(`Last prompt: ${(last.prompt ?? '').slice(0, 150)}`);
    if (last.response) {
      lines.push(`Response: ${(last.response ?? '').slice(0, 200)}`);
    }
  }

  const severity = git.isDirty ? (git.unpushedCount > 0 ? 'warning' : 'info') : 'ok';
  const summary = git.isDirty
    ? `${git.dirtyFiles.length} dirty files on ${git.branch}` + (git.unpushedCount > 0 ? `, ${git.unpushedCount} unpushed` : '')
    : git.unpushedCount > 0
      ? `Clean tree, ${git.unpushedCount} unpushed on ${git.branch}`
      : `All clean on ${git.branch}`;

  return { summary, lines, severity, git };
}

async function executeFinish(git: GitSnapshot | null, repoPath: string, message?: string) {
  if (!git) throw new Error('Could not read git state');

  const actions: string[] = [];

  // Step 1: commit if dirty
  if (git.isDirty) {
    await gitExec(repoPath, ['add', '-A']);
    const commitMsg = message || `chore: auto-commit ${git.dirtyFiles.length} file(s) from agent action`;
    await gitExec(repoPath, ['commit', '-m', commitMsg]);
    const hash = await gitExec(repoPath, ['log', '--oneline', '-1']);
    actions.push(`Committed: ${hash}`);
  }

  // Step 2: push if unpushed (including the commit we just made)
  const unpushedAfter = await gitExec(repoPath, ['log', '--oneline', '@{upstream}..HEAD']).catch(() => '');
  if (unpushedAfter.trim()) {
    await gitExec(repoPath, ['push'], 30000);
    actions.push(`Pushed ${unpushedAfter.split('\n').filter(Boolean).length} commit(s)`);
  }

  if (actions.length === 0) {
    return { summary: 'Nothing to do — tree clean and up to date', actions };
  }

  return { summary: actions.join(', '), actions };
}

function buildBlockers(git: GitSnapshot | null, prompts: any[], repoPath: string) {
  const blockers: Array<{ type: string; description: string; severity: string }> = [];

  if (!git) {
    blockers.push({ type: 'git', description: 'Cannot read git state for this project', severity: 'error' });
    return { blockers, summary: 'Cannot access repository', needsHuman: true };
  }

  // Stale uncommitted work (dirty for 1hr+)
  if (git.isDirty && git.lastCommitAge) {
    const ageMatch = git.lastCommitAge.match(/(\d+)([hd])/);
    if (ageMatch) {
      const val = parseInt(ageMatch[1]);
      const unit = ageMatch[2];
      if (unit === 'h' && val >= 1 || unit === 'd') {
        blockers.push({
          type: 'stale-uncommitted',
          description: `${git.dirtyFiles.length} uncommitted files, last commit was ${git.lastCommitAge}`,
          severity: 'warning',
        });
      }
    }
  }

  // Unpushed commits
  if (git.unpushedCount > 0) {
    blockers.push({
      type: 'unpushed',
      description: `${git.unpushedCount} commit(s) not pushed to remote`,
      severity: 'warning',
    });
  }

  // Check if last prompt had no matching commit (agent may be stuck)
  if (prompts.length > 0) {
    const last = prompts[0];
    const promptAge = Date.now() - new Date(last.timestamp).getTime();
    if (promptAge > 3_600_000 && git.isDirty) {
      blockers.push({
        type: 'agent-stalled',
        description: `Last prompt was ${Math.floor(promptAge / 3_600_000)}h ago, work still uncommitted: "${(last.prompt ?? '').slice(0, 100)}"`,
        severity: 'error',
      });
    }
  }

  // Dirty files that look like they shouldn't be committed
  const suspicious = git.dirtyFiles.filter(f =>
    /\.(env|key|pem|secret|credentials)/.test(f) || f.includes('node_modules')
  );
  if (suspicious.length > 0) {
    blockers.push({
      type: 'suspicious-files',
      description: `Potentially sensitive files in working tree: ${suspicious.join(', ')}`,
      severity: 'error',
    });
  }

  const needsHuman = blockers.some(b => b.severity === 'error');
  const summary = blockers.length === 0
    ? 'No blockers detected'
    : `${blockers.length} blocker(s)` + (needsHuman ? ' — needs human decision' : '');

  return { blockers, summary, needsHuman };
}
