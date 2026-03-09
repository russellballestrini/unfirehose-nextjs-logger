import { NextRequest, NextResponse } from 'next/server';
import { execFile, spawn } from 'child_process';
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
  // Try sessions-index.json first
  try {
    const raw = await readFile(claudePaths.sessionsIndex(projectName), 'utf-8');
    const index: SessionsIndex = JSON.parse(raw);
    if (index.originalPath) return index.originalPath;
  } catch { /* no index file */ }

  // Try DB path
  try {
    const db = getDb();
    const row = db.prepare('SELECT path FROM projects WHERE name = ?').get(projectName) as any;
    if (row?.path) return row.path;
  } catch { /* no db path */ }

  // Decode from project name: -home-fox-git-unfirehose-nextjs-logger → /home/fox/git/unfirehose-nextjs-logger
  // Dashes are ambiguous (separator vs literal), so try all split points and check which path is a git repo
  const parts = projectName.replace(/^-/, '').split('-');
  const { existsSync } = await import('fs');

  // Try combining parts greedily from right (longer directory names first)
  const tryCombinations = (idx: number, current: string): string | null => {
    if (idx >= parts.length) {
      // Check if this is a git repo
      if (existsSync(current + '/.git')) return current;
      return null;
    }
    // Try joining remaining parts with dashes (greedy: longer names first)
    for (let end = parts.length; end > idx; end--) {
      const segment = parts.slice(idx, end).join('-');
      const candidate = current + '/' + segment;
      const result = tryCombinations(end, candidate);
      if (result) return result;
    }
    return null;
  };

  const decoded = tryCombinations(0, '');
  if (decoded) return decoded;

  return null;
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

  if (!['status', 'finish', 'blockers', 'nudge'].includes(action)) {
    return NextResponse.json({ error: 'action must be status, finish, blockers, or nudge' }, { status: 400 });
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
    } else if (action === 'nudge') {
      // Get project harness from most recent session
      const harness = getProjectHarness(db, project);
      const diff = git?.isDirty ? await gitExec(repoPath, ['diff', 'HEAD'], 15000).catch(() => '') : '';
      // Fire and forget — spawn agent in background, update DB when done
      spawnNudgeAgent(db, Number(actionId), repoPath, harness, git, prompts, diff);
      return NextResponse.json({ ok: true, actionId, status: 'spawned', harness });
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

function getProjectHarness(db: any, projectName: string): string {
  // Get the most common harness from recent sessions
  const row = db.prepare(`
    SELECT s.harness, COUNT(*) as cnt
    FROM sessions s
    JOIN projects p ON s.project_id = p.id
    WHERE p.name = ? AND s.harness IS NOT NULL
    GROUP BY s.harness
    ORDER BY cnt DESC
    LIMIT 1
  `).get(projectName) as any;
  return row?.harness ?? 'claude-code';
}

function buildNudgePrompt(git: GitSnapshot | null, prompts: any[], diff: string): string {
  const sections: string[] = [];

  sections.push('You have been triggered by the unfirehose dashboard to finish stale work in this repo.');
  sections.push('Review the state below and take ONE of these actions:');
  sections.push('1. If the work is complete and safe to ship: commit all changes with a descriptive message, then push.');
  sections.push('2. If the work is incomplete but you can finish it: finish it, commit, and push.');
  sections.push('3. If you cannot finish (needs human decision, blocked, or risky): create TODO items describing exactly what remains and why it is blocked. Do NOT commit partial/broken work.');
  sections.push('');

  if (git) {
    sections.push(`## Git State`);
    sections.push(`Branch: ${git.branch}`);
    sections.push(`Dirty files: ${git.dirtyFiles.length}`);
    if (git.dirtyFiles.length > 0) {
      sections.push(git.dirtyFiles.slice(0, 20).join('\n'));
    }
    sections.push(`Unpushed commits: ${git.unpushedCount}`);
    if (git.unpushedCommits.length > 0) {
      sections.push(git.unpushedCommits.slice(0, 5).join('\n'));
    }
    sections.push('');
  }

  if (diff) {
    // Truncate diff to avoid token explosion
    const maxDiff = 8000;
    const truncated = diff.length > maxDiff ? diff.slice(0, maxDiff) + '\n... (diff truncated)' : diff;
    sections.push('## Diff');
    sections.push(truncated);
    sections.push('');
  }

  if (prompts.length > 0) {
    sections.push('## Recent prompts (what the human last asked for)');
    for (const p of prompts.slice(0, 3)) {
      sections.push(`- "${(p.prompt ?? '').slice(0, 200)}"`);
      if (p.response) {
        sections.push(`  Agent responded: "${(p.response ?? '').slice(0, 300)}"`);
      }
    }
    sections.push('');
  }

  sections.push('Now act. Be concise. If committing, write a good commit message. If creating TODOs, be specific about what is blocked and what a human needs to decide.');

  return sections.join('\n');
}

function spawnNudgeAgent(
  db: any,
  actionId: number,
  repoPath: string,
  harness: string,
  git: GitSnapshot | null,
  prompts: any[],
  diff: string,
) {
  const prompt = buildNudgePrompt(git, prompts, diff);

  // Determine the command based on harness
  let cmd: string;
  let args: string[];

  switch (harness) {
    case 'claude-code':
    default:
      // claude -p reads prompt from stdin, respects CLAUDE.md in the repo
      cmd = 'claude';
      args = ['-p', '--model', 'sonnet', '--output-format', 'json'];
      break;
  }

  const child = spawn(cmd, args, {
    cwd: repoPath,
    stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env, CLAUDE_CODE_ENTRYPOINT: 'nudge' },
    detached: true,
  });

  // Pipe the prompt via stdin to avoid CLI argument length limits
  child.stdin.write(prompt);
  child.stdin.end();

  let stdout = '';
  let stderr = '';

  child.stdout.on('data', (chunk: Buffer) => { stdout += chunk.toString(); });
  child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString(); });

  child.on('close', (code) => {
    try {
      let parsed: any = null;
      try { parsed = JSON.parse(stdout); } catch { /* not JSON */ }

      const stderrClean = stderr.trim().slice(0, 1500);
      const result = {
        harness,
        exitCode: code,
        response: parsed?.result ?? stdout.slice(0, 5000),
        stderr: stderrClean || undefined,
        costUsd: parsed?.cost_usd ?? null,
        duration: parsed?.duration_ms ?? null,
        summary: code === 0
          ? `Agent finished (${harness})`
          : `Agent exited with code ${code}${stderrClean ? ': ' + stderrClean.split('\n')[0] : ''}`,
        severity: code === 0 ? 'ok' : 'error',
      };

      db.prepare(
        "UPDATE agent_actions SET status = ?, result = ?, completed_at = datetime('now') WHERE id = ?"
      ).run(code === 0 ? 'done' : 'failed', JSON.stringify(result), actionId);
    } catch {
      db.prepare(
        "UPDATE agent_actions SET status = 'failed', result = ?, completed_at = datetime('now') WHERE id = ?"
      ).run(JSON.stringify({ error: 'Failed to process agent output' }), actionId);
    }
  });

  child.on('error', (err) => {
    db.prepare(
      "UPDATE agent_actions SET status = 'failed', result = ?, completed_at = datetime('now') WHERE id = ?"
    ).run(JSON.stringify({ error: `Spawn failed: ${err.message}`, harness }), actionId);
  });

  // Unref so the Node process doesn't wait for the child
  child.unref();
}
