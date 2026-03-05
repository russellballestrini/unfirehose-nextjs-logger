import { NextRequest, NextResponse } from 'next/server';
import { execFile } from 'child_process';
import { stat } from 'fs/promises';
import { writeFile, unlink } from 'fs/promises';
import path from 'path';
import { tmpdir, platform } from 'os';

const UUID_RE = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const IS_WINDOWS = platform() === 'win32';

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

  // Build session name
  const now = new Date();
  const ts = [
    String(now.getHours()).padStart(2, '0'),
    String(now.getMinutes()).padStart(2, '0'),
    String(now.getSeconds()).padStart(2, '0'),
  ].join('');
  const repoName = path.basename(projectPath).replace(/[^a-zA-Z0-9_-]/g, '-') || 'claude';
  const sessionName = `${repoName}-${ts}`;

  try {
    if (IS_WINDOWS) {
      return await bootWindows({ projectPath, sessionId, yolo, prompt, sessionName });
    }

    // Try tmux first, fall back to screen
    const mux = await detectMultiplexer();
    if (mux === 'tmux') {
      return await bootTmux({ projectPath, sessionId, yolo, prompt, sessionName });
    } else if (mux === 'screen') {
      return await bootScreen({ projectPath, sessionId, yolo, prompt, sessionName });
    } else {
      return NextResponse.json({
        error: 'No terminal multiplexer found',
        detail: 'Install tmux or screen. On Windows, sessions open in a new terminal window automatically.',
      }, { status: 500 });
    }
  } catch (err: unknown) {
    const detail = (err as { stderr?: string }).stderr || String(err);
    return NextResponse.json({
      error: 'Failed to create session',
      detail,
    }, { status: 500 });
  }
}

// --- Helpers ---

interface BootOpts {
  projectPath: string;
  sessionId?: string;
  yolo?: boolean;
  prompt?: string;
  sessionName: string;
}

async function detectMultiplexer(): Promise<'tmux' | 'screen' | null> {
  try {
    await exec('which', ['tmux'], { timeout: 2000 });
    return 'tmux';
  } catch {
    try {
      await exec('which', ['screen'], { timeout: 2000 });
      return 'screen';
    } catch {
      return null;
    }
  }
}

function buildClaudeArgs(opts: BootOpts): { parts: string[]; cleanupFiles: string[] } {
  const parts = ['claude'];
  const cleanupFiles: string[] = [];

  if (opts.sessionId) {
    parts.push('--resume', opts.sessionId);
  }
  if (opts.yolo) {
    parts.push('--dangerously-skip-permissions');
  }
  if (opts.yolo) {
    const sysFile = path.join(tmpdir(), `claude-sys-${opts.sessionName}.txt`);
    parts.push(`--append-system-prompt "$(cat ${sysFile})"`);
    cleanupFiles.push(sysFile);
  }
  if (opts.prompt && typeof opts.prompt === 'string') {
    const promptFile = path.join(tmpdir(), `claude-prompt-${opts.sessionName}.txt`);
    parts.push(`"$(cat ${promptFile})"`);
    cleanupFiles.push(promptFile);
  }

  return { parts, cleanupFiles };
}

async function writePromptFiles(opts: BootOpts, cleanupFiles: string[]) {
  if (opts.yolo) {
    const sysFile = path.join(tmpdir(), `claude-sys-${opts.sessionName}.txt`);
    await writeFile(sysFile, AGENT_SYSTEM_PROMPT, 'utf-8');
  }
  if (opts.prompt && typeof opts.prompt === 'string') {
    const promptFile = path.join(tmpdir(), `claude-prompt-${opts.sessionName}.txt`);
    await writeFile(promptFile, opts.prompt, 'utf-8');
  }
  if (cleanupFiles.length) {
    setTimeout(() => cleanupFiles.forEach(f => unlink(f).catch(() => {})), 15000);
  }
}

async function bootTmux(opts: BootOpts) {
  const { parts, cleanupFiles } = buildClaudeArgs(opts);
  await writePromptFiles(opts, cleanupFiles);

  await exec('tmux', [
    'new-session', '-d',
    '-s', opts.sessionName,
    '-c', opts.projectPath,
    'bash', '-l',
  ], { timeout: 5000 });

  await exec('tmux', [
    'send-keys', '-t', opts.sessionName,
    `unset CLAUDECODE && ${parts.join(' ')}`,
    'Enter',
  ], { timeout: 5000 });

  return NextResponse.json({
    success: true,
    tmuxSession: opts.sessionName,
    multiplexer: 'tmux',
    command: `tmux attach -t ${opts.sessionName}`,
  });
}

async function bootScreen(opts: BootOpts) {
  const { parts, cleanupFiles } = buildClaudeArgs(opts);
  await writePromptFiles(opts, cleanupFiles);

  const shellCmd = `cd ${JSON.stringify(opts.projectPath)} && unset CLAUDECODE && ${parts.join(' ')}`;

  await exec('screen', [
    '-dmS', opts.sessionName,
    'bash', '-lc', shellCmd,
  ], { timeout: 5000 });

  return NextResponse.json({
    success: true,
    tmuxSession: opts.sessionName,
    multiplexer: 'screen',
    command: `screen -r ${opts.sessionName}`,
  });
}

async function bootWindows(opts: BootOpts) {
  // Windows: open a new cmd window with title, cd to project, run claude
  const claudeArgs: string[] = ['claude'];
  if (opts.sessionId) claudeArgs.push('--resume', opts.sessionId);
  if (opts.yolo) claudeArgs.push('--dangerously-skip-permissions');

  // Write prompt to temp file, use powershell Get-Content for substitution
  const cleanupFiles: string[] = [];
  if (opts.yolo) {
    const sysFile = path.join(tmpdir(), `claude-sys-${opts.sessionName}.txt`);
    await writeFile(sysFile, AGENT_SYSTEM_PROMPT, 'utf-8');
    claudeArgs.push('--append-system-prompt', `"$(Get-Content '${sysFile}')"`);
    cleanupFiles.push(sysFile);
  }
  if (opts.prompt) {
    const promptFile = path.join(tmpdir(), `claude-prompt-${opts.sessionName}.txt`);
    await writeFile(promptFile, opts.prompt, 'utf-8');
    cleanupFiles.push(promptFile);
  }

  // Use cmd start to open a new window with a title
  // The prompt file is read by powershell inline
  const promptArg = opts.prompt
    ? ` "$(Get-Content '${path.join(tmpdir(), `claude-prompt-${opts.sessionName}.txt`)}')"`
    : '';
  const psCommand = `Set-Location '${opts.projectPath}'; ${claudeArgs.join(' ')}${promptArg}`;

  await exec('cmd', [
    '/c', 'start',
    `"${opts.sessionName}"`,
    'powershell', '-NoExit', '-Command', psCommand,
  ], { timeout: 5000 });

  if (cleanupFiles.length) {
    setTimeout(() => cleanupFiles.forEach(f => unlink(f).catch(() => {})), 15000);
  }

  return NextResponse.json({
    success: true,
    tmuxSession: opts.sessionName,
    multiplexer: 'windows-terminal',
    command: `Window: ${opts.sessionName}`,
  });
}
