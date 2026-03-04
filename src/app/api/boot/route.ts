import { NextRequest, NextResponse } from 'next/server';
import { execFile } from 'child_process';
import { stat } from 'fs/promises';
import path from 'path';

const UUID_RE = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;

export async function POST(request: NextRequest) {
  const body = await request.json();
  const { projectPath, projectName, sessionId, yolo } = body;

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

  // Build claude command string (tmux runs this via shell)
  const parts = ['claude'];
  if (sessionId) {
    parts.push('--resume', sessionId);
  }
  if (yolo) {
    parts.push('--dangerously-skip-permissions');
  }
  const claudeCmd = parts.join(' ');

  // Build tmux session name from actual directory basename
  const now = new Date();
  const ts = [
    String(now.getHours()).padStart(2, '0'),
    String(now.getMinutes()).padStart(2, '0'),
    String(now.getSeconds()).padStart(2, '0'),
  ].join('');
  const repoName = path.basename(projectPath).replace(/[^a-zA-Z0-9_-]/g, '-') || 'claude';
  const tmuxName = `${repoName}-${ts}`;

  // Spawn tmux session
  return new Promise<NextResponse>((resolve) => {
    execFile('tmux', [
      'new-session', '-d',
      '-s', tmuxName,
      '-c', projectPath,
      claudeCmd,
    ], { timeout: 5000 }, (err, _stdout, stderr) => {
      if (err) {
        resolve(NextResponse.json({
          error: 'Failed to create tmux session',
          detail: stderr || String(err),
        }, { status: 500 }));
      } else {
        resolve(NextResponse.json({
          success: true,
          tmuxSession: tmuxName,
          command: `tmux attach -t ${tmuxName}`,
        }));
      }
    });
  });
}
