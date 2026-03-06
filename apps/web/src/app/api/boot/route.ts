import { NextRequest, NextResponse } from 'next/server';
import { execFile } from 'child_process';
import { stat } from 'fs/promises';
import { writeFile, unlink } from 'fs/promises';
import path from 'path';
import { tmpdir, platform } from 'os';
import { getSetting } from '@unfirehose/core/db/ingest';
import { getDb } from '@unfirehose/core/db/schema';
import { discoverNodes } from '@unfirehose/core/mesh';

const UUID_RE = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const IS_WINDOWS = platform() === 'win32';

const AGENT_SYSTEM_PROMPT = `You are a deployed agent. Follow these rules:
- Work through your assigned task. Read the codebase before making changes.
- Mark todos done: curl -X PATCH localhost:3000/api/todos -H 'Content-Type: application/json' -d '{"id": TODO_ID, "status": "completed"}'
- Commit and push your work after completing each task or logical group.
- Check docs/tickets/ for related ticket files. Update ticket status when work is complete.
- Update relevant docs when your changes affect them.
- Never force push. If something is unclear or risky, skip it.
- When all work is complete, output the exact text UNEOF as your final message. This signals the orchestrator to retire this session.`;

function exec(cmd: string, args: string[], opts: { timeout: number }): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, opts, (err, stdout, stderr) => {
      if (err) reject(Object.assign(err, { stderr }));
      else resolve({ stdout, stderr });
    });
  });
}

// Resolve which host to boot on based on settings + strategy
function resolveBootHost(requestedHost?: string): string {
  // Explicit request overrides everything
  if (requestedHost) return requestedHost;

  const strategy = getSetting('boot_strategy') ?? 'default';
  const defaultHost = getSetting('boot_default_host') ?? 'localhost';

  if (strategy === 'default') {
    return defaultHost;
  }

  if (strategy === 'least-loaded') {
    // For now, just use the default — least-loaded needs async mesh query
    // which will be wired up when the settings UI supports it
    return defaultHost;
  }

  return defaultHost;
}

export async function POST(request: NextRequest) {
  const body = await request.json();
  const { projectPath, sessionId, yolo, prompt, parentSessionUuid, host: requestedHost, todoIds, projectName } = body;

  // Validate projectPath
  if (!projectPath || typeof projectPath !== 'string') {
    return NextResponse.json({ error: 'Missing projectPath' }, { status: 400 });
  }

  // Validate sessionId if provided
  if (sessionId && !UUID_RE.test(sessionId)) {
    return NextResponse.json({ error: 'Invalid session ID format' }, { status: 400 });
  }

  const host = resolveBootHost(requestedHost);
  const isRemote = host !== 'localhost';

  // Validate path exists (local only — remote paths are trusted)
  if (!isRemote) {
    try {
      const s = await stat(projectPath);
      if (!s.isDirectory()) throw new Error('Not a directory');
    } catch {
      return NextResponse.json({ error: `Invalid project path: ${projectPath}` }, { status: 400 });
    }
  }

  // Validate remote host is a known mesh node
  if (isRemote) {
    const knownNodes = discoverNodes();
    if (!knownNodes.includes(host)) {
      return NextResponse.json({
        error: `Unknown host: ${host}`,
        detail: `Known nodes: ${knownNodes.join(', ')}. Add this host to ~/.ssh/config.`,
      }, { status: 400 });
    }
  }

  // tmux session = one per project, windows = one per claude instance
  const repoName = path.basename(projectPath).replace(/[^a-zA-Z0-9_-]/g, '-') || 'claude';
  const sessionName = repoName;
  const now = new Date();
  const ts = [
    String(now.getHours()).padStart(2, '0'),
    String(now.getMinutes()).padStart(2, '0'),
    String(now.getSeconds()).padStart(2, '0'),
  ].join('');
  const windowName = prompt
    ? prompt.slice(0, 40).replace(/[^a-zA-Z0-9 _-]/g, '').trim().replace(/\s+/g, '-') || ts
    : ts;

  const opts: BootOpts = { projectPath, sessionId, yolo, prompt, sessionName, windowName, parentSessionUuid };

  try {
    let response: NextResponse;

    if (isRemote) {
      response = await bootRemote(host, opts);
    } else if (IS_WINDOWS) {
      response = await bootWindows(opts);
    } else {
      // Try tmux first, fall back to screen
      const mux = await detectMultiplexer();
      if (mux === 'tmux') {
        response = await bootTmux(opts);
      } else if (mux === 'screen') {
        response = await bootScreen(opts);
      } else {
        return NextResponse.json({
          error: 'No terminal multiplexer found',
          detail: 'Install tmux or screen. On Windows, sessions open in a new terminal window automatically.',
        }, { status: 500 });
      }
    }

    // Register every deployment so UNEOF cull can find it
    if (projectName) {
      try {
        const db = getDb();
        const proj = db.prepare('SELECT id FROM projects WHERE name = ?').get(projectName) as { id: number } | undefined;
        if (proj) {
          db.prepare(`
            INSERT INTO agent_deployments (tmux_session, tmux_window, project_id, todo_ids, status, started_at)
            VALUES (?, ?, ?, ?, 'running', datetime('now'))
          `).run(sessionName, windowName, proj.id, JSON.stringify(todoIds ?? []));
        }
      } catch { /* non-fatal */ }
    }

    return response;
  } catch (err: unknown) {
    const detail = (err as { stderr?: string }).stderr || String(err);
    return NextResponse.json({
      error: 'Failed to create session',
      detail,
      host,
    }, { status: 500 });
  }
}

// --- Helpers ---

interface BootOpts {
  projectPath: string;
  sessionId?: string;
  yolo?: boolean;
  prompt?: string;
  sessionName: string;   // tmux session (per-project)
  windowName: string;    // tmux window (per-claude instance)
  parentSessionUuid?: string;
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

function buildClaudeCmd(opts: BootOpts): string {
  const parts = ['claude'];

  if (opts.sessionId) {
    parts.push('--resume', opts.sessionId);
  }
  if (opts.yolo) {
    parts.push('--dangerously-skip-permissions');
  }

  return parts.join(' ');
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

  const target = `${opts.sessionName}:${opts.windowName}`;

  // Create session if it doesn't exist, otherwise add a new window
  let sessionExists = false;
  try {
    await exec('tmux', ['has-session', '-t', opts.sessionName], { timeout: 3000 });
    sessionExists = true;
  } catch { /* session doesn't exist yet */ }

  if (sessionExists) {
    await exec('tmux', [
      'new-window', '-t', opts.sessionName,
      '-n', opts.windowName,
      '-c', opts.projectPath,
      'bash', '-l',
    ], { timeout: 5000 });
  } else {
    await exec('tmux', [
      'new-session', '-d',
      '-s', opts.sessionName,
      '-n', opts.windowName,
      '-c', opts.projectPath,
      'bash', '-l',
    ], { timeout: 5000 });
  }

  // Wait for bash to initialize
  await new Promise(resolve => setTimeout(resolve, 1500));

  const envVars = [
    'unset CLAUDECODE',
    `export UNFIREHOSE_TMUX_SESSION=${opts.sessionName}`,
    `export UNFIREHOSE_TMUX_WINDOW=${opts.windowName}`,
  ];
  if (opts.parentSessionUuid) {
    envVars.push(`export UNFIREHOSE_PARENT_SESSION=${opts.parentSessionUuid}`);
  }
  await exec('tmux', [
    'send-keys', '-t', target,
    `${envVars.join(' && ')} && ${parts.join(' ')}`,
    'Enter',
  ], { timeout: 5000 });

  return NextResponse.json({
    success: true,
    tmuxSession: opts.sessionName,
    tmuxWindow: opts.windowName,
    multiplexer: 'tmux',
    host: 'localhost',
    command: `tmux attach -t ${opts.sessionName}`,
  });
}

async function bootScreen(opts: BootOpts) {
  const { parts, cleanupFiles } = buildClaudeArgs(opts);
  await writePromptFiles(opts, cleanupFiles);

  const envPrefix = opts.parentSessionUuid
    ? `export UNFIREHOSE_PARENT_SESSION=${opts.parentSessionUuid} && `
    : '';
  const shellCmd = `cd ${JSON.stringify(opts.projectPath)} && unset CLAUDECODE && ${envPrefix}${parts.join(' ')}`;

  await exec('screen', [
    '-dmS', opts.sessionName,
    'bash', '-lc', shellCmd,
  ], { timeout: 5000 });

  return NextResponse.json({
    success: true,
    tmuxSession: opts.sessionName,
    multiplexer: 'screen',
    host: 'localhost',
    command: `screen -r ${opts.sessionName}`,
  });
}

async function bootRemote(host: string, opts: BootOpts) {
  const sshBase = ['ssh', '-o', 'ConnectTimeout=10', '-o', 'StrictHostKeyChecking=no', host];

  // Pre-flight: check claude is available on remote
  try {
    await exec(sshBase[0], [...sshBase.slice(1), 'which claude'], { timeout: 15000 });
  } catch {
    return NextResponse.json({
      error: `Claude not found on ${host}`,
      detail: 'Claude CLI must be installed and in PATH on the remote host.',
      host,
    }, { status: 500 });
  }

  // Pre-flight: check tmux is available
  try {
    await exec(sshBase[0], [...sshBase.slice(1), 'which tmux'], { timeout: 10000 });
  } catch {
    return NextResponse.json({
      error: `tmux not found on ${host}`,
      detail: 'Install tmux on the remote host.',
      host,
    }, { status: 500 });
  }

  // Build the claude command for remote execution
  const claudeCmd = buildClaudeCmd(opts);
  const envVars = [
    'unset CLAUDECODE',
    `export UNFIREHOSE_TMUX_SESSION=${opts.sessionName}`,
    `export UNFIREHOSE_TMUX_WINDOW=${opts.windowName}`,
  ];
  if (opts.parentSessionUuid) {
    envVars.push(`export UNFIREHOSE_PARENT_SESSION=${opts.parentSessionUuid}`);
  }

  // Build system prompt append if yolo
  let sysPromptArg = '';
  if (opts.yolo) {
    // Escape single quotes in the system prompt for remote shell
    const escaped = AGENT_SYSTEM_PROMPT.replace(/'/g, "'\\''");
    sysPromptArg = ` --append-system-prompt '${escaped}'`;
  }

  // Build prompt arg
  let promptArg = '';
  if (opts.prompt && typeof opts.prompt === 'string') {
    const escaped = opts.prompt.replace(/'/g, "'\\''");
    promptArg = ` '${escaped}'`;
  }

  const fullCmd = `${envVars.join(' && ')} && ${claudeCmd}${sysPromptArg}${promptArg}`;
  const target = `${opts.sessionName}:${opts.windowName}`;

  // Create session if it doesn't exist, otherwise add a new window
  const hasSession = `tmux has-session -t '${opts.sessionName}' 2>/dev/null`;
  const newWindow = `tmux new-window -t '${opts.sessionName}' -n '${opts.windowName}' -c '${opts.projectPath}' bash -l`;
  const newSession = `tmux new-session -d -s '${opts.sessionName}' -n '${opts.windowName}' -c '${opts.projectPath}' bash -l`;
  const createCmd = `${hasSession} && ${newWindow} || ${newSession}`;
  await exec(sshBase[0], [...sshBase.slice(1), createCmd], { timeout: 15000 });

  // Wait for bash to initialize in the remote tmux session
  await new Promise(resolve => setTimeout(resolve, 2000));

  // Send the claude command to the specific window
  const tmuxSend = `tmux send-keys -t '${target.replace(/'/g, "'\\''")}' '${fullCmd.replace(/'/g, "'\\''")}' Enter`;
  await exec(sshBase[0], [...sshBase.slice(1), tmuxSend], { timeout: 15000 });

  return NextResponse.json({
    success: true,
    tmuxSession: opts.sessionName,
    tmuxWindow: opts.windowName,
    multiplexer: 'tmux',
    host,
    command: `ssh ${host} tmux attach -t ${opts.sessionName}`,
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
    host: 'localhost',
    command: `Window: ${opts.sessionName}`,
  });
}
