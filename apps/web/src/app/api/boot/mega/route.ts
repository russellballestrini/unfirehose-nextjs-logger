import { NextRequest, NextResponse } from 'next/server';
import { execFile } from 'child_process';
import { stat, writeFile, unlink } from 'fs/promises';
import path from 'path';
import { tmpdir } from 'os';
import { getDb } from '@sexy-logger/core/db/schema';

/* eslint-disable @typescript-eslint/no-explicit-any */

function execAsync(cmd: string, args: string[], opts: { timeout: number }): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, opts, (err, stdout, stderr) => {
      if (err) reject(Object.assign(err, { stderr }));
      else resolve({ stdout, stderr });
    });
  });
}

const AGENT_SYSTEM_PROMPT = `You are a deployed agent working through a todo list. Follow these rules:

## Completing Work
- Work through each todo systematically. Read the codebase before making changes.
- After completing a todo, mark it done via the API:
  curl -X PATCH localhost:3000/api/todos -H 'Content-Type: application/json' -d '{"id": TODO_ID, "status": "completed"}'
- Commit and push your work after completing each todo or logical group.

## Tickets
- Check docs/tickets/ for ticket files related to your todos. Tickets have status, plan, and context.
- When a ticket's work is complete, update its status line to: **Status:** closed (completed YYYY-MM-DD)
- If a ticket is partially done, update it to reflect what remains.
- If you create substantial new work (>15 min), create a ticket in docs/tickets/ following the format in docs/tickets/README.md if it exists.

## Documentation
- Update relevant docs (README, CHANGELOG, inline docs) when your changes affect them.
- Don't create unnecessary docs — only update what the change touches.

## Guardrails
- Never force push. Never delete branches without asking.
- If something is unclear or risky, skip it and move to the next todo.
- If all todos are done, exit cleanly.`;

async function spawnAgent(tmuxName: string, projectPath: string, prompt: string): Promise<void> {
  // Step 1: Create tmux session with bash login shell
  await execAsync('tmux', [
    'new-session', '-d',
    '-s', tmuxName,
    '-c', projectPath,
    'bash', '-l',
  ], { timeout: 5000 });

  // Step 2: Write prompt and system prompt to temp files
  const promptFile = path.join(tmpdir(), `claude-prompt-${tmuxName}.txt`);
  const sysFile = path.join(tmpdir(), `claude-sys-${tmuxName}.txt`);
  await writeFile(promptFile, prompt, 'utf-8');
  await writeFile(sysFile, AGENT_SYSTEM_PROMPT, 'utf-8');

  // Step 3: Send claude command via send-keys (unset CLAUDECODE to allow nesting)
  const cmd = `unset CLAUDECODE && claude --dangerously-skip-permissions --append-system-prompt "$(cat ${sysFile})" "$(cat ${promptFile})"`;
  await execAsync('tmux', [
    'send-keys', '-t', tmuxName,
    cmd,
    'Enter',
  ], { timeout: 5000 });

  // Clean up temp files after claude reads them
  setTimeout(() => {
    unlink(promptFile).catch(() => {});
    unlink(sysFile).catch(() => {});
  }, 15000);
}

// POST: Spawn one agent per project with active todos
export async function POST(request: NextRequest) {
  const db = getDb();
  const body = await request.json().catch(() => ({}));
  const maxAgents = body.maxAgents ?? 10;

  // Get projects with active todos + filesystem path
  const projects = db.prepare(`
    SELECT p.id, p.name, p.display_name, p.path,
           COUNT(t.id) as todo_count,
           GROUP_CONCAT(t.id) as todo_id_list
    FROM todos t
    JOIN projects p ON t.project_id = p.id
    WHERE t.status IN ('pending', 'in_progress')
      AND p.path IS NOT NULL
    GROUP BY p.id
    ORDER BY todo_count DESC
    LIMIT ?
  `).all(maxAgents) as any[];

  if (projects.length === 0) {
    return NextResponse.json({ error: 'No projects with active todos found' }, { status: 404 });
  }

  // Clean up stale deployments: check which "running" entries still have live tmux sessions
  let liveTmux: Set<string>;
  try {
    const { stdout } = await execAsync('tmux', ['list-sessions', '-F', '#{session_name}'], { timeout: 3000 });
    liveTmux = new Set(stdout.trim().split('\n').filter(Boolean));
  } catch {
    liveTmux = new Set();
  }

  const staleDeployments = db.prepare(
    "SELECT id, tmux_session FROM agent_deployments WHERE status = 'running'"
  ).all() as any[];
  for (const d of staleDeployments) {
    if (!liveTmux.has(d.tmux_session)) {
      db.prepare(
        "UPDATE agent_deployments SET status = 'failed', stopped_at = datetime('now') WHERE id = ?"
      ).run(d.id);
    }
  }

  // Check which projects still have actually running deployments
  const runningProjects = new Set(
    (db.prepare(
      "SELECT project_id FROM agent_deployments WHERE status = 'running'"
    ).all() as any[]).map(r => r.project_id)
  );

  const results: any[] = [];
  const now = new Date();
  const ts = [
    String(now.getHours()).padStart(2, '0'),
    String(now.getMinutes()).padStart(2, '0'),
    String(now.getSeconds()).padStart(2, '0'),
  ].join('');

  for (const proj of projects) {
    // Skip if already has a running agent
    if (runningProjects.has(proj.id)) {
      results.push({
        project: proj.display_name,
        status: 'skipped',
        reason: 'already running',
      });
      continue;
    }

    // Validate path exists
    try {
      const s = await stat(proj.path);
      if (!s.isDirectory()) throw new Error('Not a directory');
    } catch {
      results.push({
        project: proj.display_name,
        status: 'skipped',
        reason: `invalid path: ${proj.path}`,
      });
      continue;
    }

    // Get the actual todo contents for the prompt
    const todoIds = proj.todo_id_list.split(',').map(Number);
    const todos = db.prepare(`
      SELECT id, content, estimated_minutes FROM todos
      WHERE id IN (${todoIds.map(() => '?').join(',')})
      ORDER BY
        CASE status WHEN 'in_progress' THEN 0 ELSE 1 END,
        estimated_minutes ASC NULLS LAST
      LIMIT 20
    `).all(...todoIds) as any[];

    const todoList = todos
      .map(t => `- [#${t.id}] ${t.content}${t.estimated_minutes ? ` (~${t.estimated_minutes}m)` : ''}`)
      .join('\n');

    const prompt = [
      `You have ${todoIds.length} pending todos for this project. Work through them, marking each completed via the API when done:`,
      '',
      `curl -X PATCH localhost:3000/api/todos -H 'Content-Type: application/json' -d '{"id": TODO_ID, "status": "completed"}'`,
      '',
      'Todos:',
      todoList,
    ].join('\n');

    const repoName = path.basename(proj.path).replace(/[^a-zA-Z0-9_-]/g, '-') || 'claude';
    const tmuxName = `mega-${repoName}-${ts}`;

    try {
      await spawnAgent(tmuxName, proj.path, prompt);

      // Record deployment
      db.prepare(`
        INSERT INTO agent_deployments (tmux_session, project_id, todo_ids, status, started_at)
        VALUES (?, ?, ?, 'running', datetime('now'))
      `).run(tmuxName, proj.id, JSON.stringify(todoIds));

      results.push({
        project: proj.display_name,
        status: 'launched',
        tmuxSession: tmuxName,
        todoCount: todoIds.length,
      });
    } catch (err: any) {
      // Clean up partial tmux session if it was created
      try { await execAsync('tmux', ['kill-session', '-t', tmuxName], { timeout: 3000 }); } catch { /* ignore */ }
      results.push({
        project: proj.display_name,
        status: 'failed',
        reason: err.stderr || String(err),
      });
    }
  }

  const launched = results.filter(r => r.status === 'launched').length;
  return NextResponse.json({
    launched,
    total: projects.length,
    results,
  });
}

// GET: Status of all active deployments
export async function GET() {
  const db = getDb();

  // Get all running deployments
  const deployments = db.prepare(`
    SELECT d.*, p.name as project_name, p.display_name as project_display
    FROM agent_deployments d
    JOIN projects p ON d.project_id = p.id
    WHERE d.status = 'running'
    ORDER BY d.started_at DESC
  `).all() as any[];

  // Get live tmux sessions
  let tmuxSessions: Set<string>;
  try {
    const { stdout } = await execAsync('tmux', ['list-sessions', '-F', '#{session_name}'], { timeout: 3000 });
    tmuxSessions = new Set(stdout.trim().split('\n').filter(Boolean));
  } catch {
    tmuxSessions = new Set();
  }

  const results = deployments.map(d => {
    const todoIds: number[] = JSON.parse(d.todo_ids);
    const alive = tmuxSessions.has(d.tmux_session);

    // Check todo completion
    const completed = todoIds.length > 0
      ? (db.prepare(`
          SELECT COUNT(*) as c FROM todos
          WHERE id IN (${todoIds.map(() => '?').join(',')})
            AND status = 'completed'
        `).get(...todoIds) as any).c
      : 0;

    return {
      id: d.id,
      tmuxSession: d.tmux_session,
      project: d.project_display,
      projectName: d.project_name,
      alive,
      todoCount: todoIds.length,
      todosCompleted: completed,
      todosRemaining: todoIds.length - completed,
      allDone: completed >= todoIds.length,
      startedAt: d.started_at,
    };
  });

  // Also mark dead sessions (tmux gone but DB still says running)
  for (const r of results) {
    if (!r.alive) {
      db.prepare(
        "UPDATE agent_deployments SET status = 'failed', stopped_at = datetime('now') WHERE id = ? AND status = 'running'"
      ).run(r.id);
    }
  }

  return NextResponse.json({
    active: results.filter(r => r.alive).length,
    dead: results.filter(r => !r.alive).length,
    allDone: results.filter(r => r.allDone && r.alive).length,
    deployments: results,
  });
}

// DELETE: Cull completed deployments (kill tmux sessions where all todos are done)
export async function DELETE() {
  const db = getDb();

  const deployments = db.prepare(`
    SELECT d.*, p.display_name as project_display
    FROM agent_deployments d
    JOIN projects p ON d.project_id = p.id
    WHERE d.status = 'running'
  `).all() as any[];

  let tmuxSessions: Set<string>;
  try {
    const { stdout } = await execAsync('tmux', ['list-sessions', '-F', '#{session_name}'], { timeout: 3000 });
    tmuxSessions = new Set(stdout.trim().split('\n').filter(Boolean));
  } catch {
    tmuxSessions = new Set();
  }

  const culled: string[] = [];
  const dead: string[] = [];

  for (const d of deployments) {
    const todoIds: number[] = JSON.parse(d.todo_ids);
    const alive = tmuxSessions.has(d.tmux_session);

    if (!alive) {
      db.prepare(
        "UPDATE agent_deployments SET status = 'failed', stopped_at = datetime('now') WHERE id = ?"
      ).run(d.id);
      dead.push(d.project_display);
      continue;
    }

    // Check if all todos are completed
    const completed = todoIds.length > 0
      ? (db.prepare(`
          SELECT COUNT(*) as c FROM todos
          WHERE id IN (${todoIds.map(() => '?').join(',')})
            AND status = 'completed'
        `).get(...todoIds) as any).c
      : 0;

    if (completed >= todoIds.length) {
      try {
        await execAsync('tmux', ['kill-session', '-t', d.tmux_session], { timeout: 3000 });
      } catch { /* session may already be gone */ }
      db.prepare(
        "UPDATE agent_deployments SET status = 'culled', stopped_at = datetime('now') WHERE id = ?"
      ).run(d.id);
      culled.push(d.project_display);
    }
  }

  return NextResponse.json({
    culled: culled.length,
    dead: dead.length,
    culledProjects: culled,
    deadProjects: dead,
  });
}
