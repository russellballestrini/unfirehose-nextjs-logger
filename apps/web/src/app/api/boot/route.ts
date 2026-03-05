import { NextRequest, NextResponse } from 'next/server';
import { execFile } from 'child_process';
import { stat } from 'fs/promises';
import { writeFile, unlink } from 'fs/promises';
import path from 'path';
import { tmpdir } from 'os';

const UUID_RE = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;

const AGENT_SYSTEM_PROMPT = `You are a deployed agent. Follow these rules:
- Work through your assigned task. Read the codebase before making changes.
- Mark todos done: curl -X PATCH localhost:3000/api/todos -H 'Content-Type: application/json' -d '{"id": TODO_ID, "status": "completed"}'
- Commit and push your work after completing each task or logical group.
- Check docs/tickets/ for related ticket files. Update ticket status when work is complete.
- Update relevant docs when your changes affect them.
- Never force push. If something is unclear or risky, skip it.`;

function exec(cmd: string, args: string[], opts: { timeout: number }): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, opts, (err, stdout, stderr) => {
      if (err) reject(Object.assign(err, { stderr }));
      else resolve({ stdout, stderr });
    });
  });
}

export async function POST(request: NextRequest) {
  const body = await request.json();
  const { projectPath, sessionId, yolo, prompt } = body;

  // Validate projectPath exists
  if (!projectPath || typeof projectPath !== 'string') {
    return NextResponse.json({ error: 'Missing projectPath' }, { status: 400 });
  }
  try {
    const s = await stat(projectPath);
    if (!s.isDirectory()) throw new Error('Not a directory');
  } catch {
    return NextResponse.json({ error: `Invalid project path: ${projectPath}` }, { status: 400 });
  }

  // Validate sessionId if provided
  if (sessionId && !UUID_RE.test(sessionId)) {
    return NextResponse.json({ error: 'Invalid session ID format' }, { status: 400 });
  }

  // Build tmux session name
  const now = new Date();
  const ts = [
    String(now.getHours()).padStart(2, '0'),
    String(now.getMinutes()).padStart(2, '0'),
    String(now.getSeconds()).padStart(2, '0'),
  ].join('');
  const repoName = path.basename(projectPath).replace(/[^a-zA-Z0-9_-]/g, '-') || 'claude';
  const tmuxName = `${repoName}-${ts}`;

  try {
    // Step 1: Create tmux session with bash (avoids CLAUDECODE inheritance issues)
    await exec('tmux', [
      'new-session', '-d',
      '-s', tmuxName,
      '-c', projectPath,
      'bash', '-l',
    ], { timeout: 5000 });

    // Step 2: Build claude command and send via send-keys (avoids shell escaping issues)
    const parts = ['unset CLAUDECODE &&', 'claude'];
    if (sessionId) {
      parts.push('--resume', sessionId);
    }
    if (yolo) {
      parts.push('--dangerously-skip-permissions');
    }

    // Inject system prompt when in yolo mode (deployed agent)
    const cleanupFiles: string[] = [];
    if (yolo) {
      const sysFile = path.join(tmpdir(), `claude-sys-${tmuxName}.txt`);
      await writeFile(sysFile, AGENT_SYSTEM_PROMPT, 'utf-8');
      parts.push(`--append-system-prompt "$(cat ${sysFile})"`);
      cleanupFiles.push(sysFile);
    }

    // If there's a prompt, write to temp file and use cat substitution
    if (prompt && typeof prompt === 'string') {
      const promptFile = path.join(tmpdir(), `claude-prompt-${tmuxName}.txt`);
      await writeFile(promptFile, prompt, 'utf-8');
      parts.push(`"$(cat ${promptFile})"`);
      cleanupFiles.push(promptFile);
    }

    await exec('tmux', [
      'send-keys', '-t', tmuxName,
      parts.join(' '),
      'Enter',
    ], { timeout: 5000 });

    // Clean up temp files after claude reads them
    if (cleanupFiles.length) {
      setTimeout(() => cleanupFiles.forEach(f => unlink(f).catch(() => {})), 15000);
    }

    return NextResponse.json({
      success: true,
      tmuxSession: tmuxName,
      command: `tmux attach -t ${tmuxName}`,
    });
  } catch (err: unknown) {
    const detail = (err as { stderr?: string }).stderr || String(err);
    return NextResponse.json({
      error: 'Failed to create tmux session',
      detail,
    }, { status: 500 });
  }
}
