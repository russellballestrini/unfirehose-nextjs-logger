import { readGitState } from '@/lib/git-state';
import { NextRequest, NextResponse } from 'next/server';
import { execFile, spawn } from 'child_process';
import { getDb } from '@unturf/unfirehose/db/schema';
import { getProjectRecentPrompts } from '@unturf/unfirehose/db/ingest';
import { uuidv7 } from '@unturf/unfirehose/uuidv7';
import { repoPathForProject } from '@unturf/unfirehose/db/repo-path';
import { gitExec } from '@unturf/unfirehose/git-exec';
import {
  type GitSnapshot, buildStatus, buildBlockers, buildNudgePrompt,
} from '@/lib/agent-report';

/* eslint-disable @typescript-eslint/no-explicit-any */


async function getGitSnapshot(repoPath: string): Promise<GitSnapshot | null> {
  try {
    const [state, branch, diffStat, lastCommitDate] = await Promise.all([
      // Dirty and unpushed are shared with our activity feed, which reports
      // the same two facts about the same repository.
      readGitState(repoPath),
      gitExec(repoPath, ['rev-parse', '--abbrev-ref', 'HEAD']),
      gitExec(repoPath, ['diff', '--stat', 'HEAD']).catch(() => ''),
      gitExec(repoPath, ['log', '-1', '--format=%aI']).catch(() => null),
    ]);
    const { dirtyFiles, unpushedCommits } = state;

    // gitExec hands back git's stdout verbatim, newline included, and this
    // branch name is interpolated into every summary line below.
    const branchName = branch.trim();

    let lastCommitAge: string | null = null;
    if (lastCommitDate) {
      const ageMs = Date.now() - new Date(lastCommitDate).getTime();
      if (ageMs < 60_000) lastCommitAge = 'just now';
      else if (ageMs < 3_600_000) lastCommitAge = `${Math.floor(ageMs / 60_000)}m ago`;
      else if (ageMs < 86_400_000) lastCommitAge = `${Math.floor(ageMs / 3_600_000)}h ago`;
      else lastCommitAge = `${Math.floor(ageMs / 86_400_000)}d ago`;
    }

    return {
      branch: branchName,
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

  const repoPath = repoPathForProject(project);
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
      result = buildStatus(git, prompts);
    } else if (action === 'finish') {
      result = await executeFinish(git, repoPath, body.message);
    } else if (action === 'blockers') {
      result = buildBlockers(git, prompts);
    } else if (action === 'nudge') {
      // Get project harness from most recent session
      const harness = getProjectHarness(db, project);
      const diff = git?.isDirty ? await gitExec(repoPath, ['diff', 'HEAD'], { timeout: 15000 }).catch(() => '') : '';
      // Fire and forget — spawn agent in background, update DB when done
      spawnNudgeAgent(db, Number(actionId), project, repoPath, harness, git, prompts, diff);
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
    await gitExec(repoPath, ['push'], { timeout: 30000 });
    actions.push(`Pushed ${unpushedAfter.split('\n').filter(Boolean).length} commit(s)`);
  }

  if (actions.length === 0) {
    return { summary: 'Nothing to do — tree clean and up to date', actions };
  }

  return { summary: actions.join(', '), actions };
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


function extractAndCreateTodos(db: any, projectName: string, responseText: string) {
  // Get or create project
  const project = db.prepare('SELECT id FROM projects WHERE name = ?').get(projectName) as any;
  if (!project) return 0;
  const projectId = project.id;

  // Extract TODO-like items from agent response
  // Match numbered lists, bullet points, or lines starting with TODO/BLOCKED
  const todoPatterns = [
    /^\s*\d+\.\s+\*\*(.+?)\*\*\s*[—–-]\s*(.+)/gm,  // "1. **Title** — description"
    /^\s*\d+\.\s+\*\*(.+?)\*\*:?\s*(.+)/gm,          // "1. **Title**: description" or "1. **Title** description"
    /^\s*[-*]\s+\*\*(.+?)\*\*\s*[—–-]\s*(.+)/gm,     // "- **Title** — description"
    /^\s*[-*]\s+TODO:\s*(.+)/gim,                       // "- TODO: description"
    /^\s*BLOCKED:\s*(.+)/gim,                            // "BLOCKED: description"
  ];

  const todos: string[] = [];
  const seen = new Set<string>();

  for (const pattern of todoPatterns) {
    let match;
    while ((match = pattern.exec(responseText)) !== null) {
      // Combine title + description, or just the match
      const content = match[2]
        ? `${match[1].trim()}: ${match[2].trim()}`
        : match[1].trim();
      // Clean markdown
      const clean = content.replace(/\*\*/g, '').replace(/`/g, '').trim();
      if (clean.length > 5 && !seen.has(clean.toLowerCase())) {
        seen.add(clean.toLowerCase());
        todos.push(clean);
      }
    }
  }

  if (todos.length === 0) return 0;

  const insert = db.prepare(`
    INSERT INTO todos (project_id, content, status, source, uuid, created_at, updated_at)
    VALUES (?, ?, 'pending', 'nudge', ?, datetime('now'), datetime('now'))
  `);

  db.transaction(() => {
    for (const content of todos) {
      insert.run(projectId, content, uuidv7());
    }
  })();

  return todos.length;
}

function spawnNudgeAgent(
  db: any,
  actionId: number,
  projectName: string,
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
      // acceptEdits lets it write files and run git without prompting
      cmd = 'claude';
      args = ['-p', '--model', 'sonnet', '--output-format', 'json', '--permission-mode', 'acceptEdits'];
      break;
  }

  const child = spawn(cmd, args, {
    cwd: repoPath,
    stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env, CLAUDE_CODE_ENTRYPOINT: 'nudge', CLAUDECODE: '', CLAUDE_CODE: '' },
    detached: true,
  });

  // Pipe the prompt via stdin to avoid CLI argument length limits
  child.stdin.write(prompt);
  child.stdin.end();

  let stdout = '';
  let stderr = '';
  let killed = false;

  child.stdout.on('data', (chunk: Buffer) => { stdout += chunk.toString(); });
  child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString(); });

  // Hard timeout: kill agent after 5 minutes
  const NUDGE_TIMEOUT_MS = 5 * 60 * 1000;
  const killTimer = setTimeout(() => {
    killed = true;
    try { process.kill(-child.pid!, 'SIGTERM'); } catch { /* already dead */ }
    // If SIGTERM doesn't work, SIGKILL after 10s
    setTimeout(() => {
      try { process.kill(-child.pid!, 'SIGKILL'); } catch { /* already dead */ }
    }, 10000);
  }, NUDGE_TIMEOUT_MS);

  child.on('close', (code) => {
    clearTimeout(killTimer);
    try {
      let parsed: any = null;
      try { parsed = JSON.parse(stdout); } catch { /* not JSON */ }

      const stderrClean = stderr.trim().slice(0, 1500);
      const responseText = parsed?.result ?? stdout.slice(0, 5000);

      // Extract TODOs from agent response and create them in the DB
      let todosCreated = 0;
      if (code === 0 && responseText) {
        try {
          todosCreated = extractAndCreateTodos(db, projectName, responseText);
        } catch { /* don't fail the whole action */ }
      }

      const result = {
        harness,
        exitCode: code,
        response: responseText,
        stderr: stderrClean || undefined,
        costUsd: parsed?.cost_usd ?? null,
        duration: parsed?.duration_ms ?? null,
        todosCreated,
        killed,
        summary: killed
          ? `Agent killed after 5min timeout (${harness})` + (todosCreated > 0 ? ` — ${todosCreated} todo(s) created from partial output` : '')
          : code === 0
            ? `Agent finished (${harness})` + (todosCreated > 0 ? ` — ${todosCreated} todo(s) created` : '')
            : `Agent exited with code ${code}${stderrClean ? ': ' + stderrClean.split('\n')[0] : ''}`,
        severity: killed ? 'warning' : code === 0 ? 'ok' : 'error',
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
