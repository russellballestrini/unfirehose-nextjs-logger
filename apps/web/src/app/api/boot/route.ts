import { NextRequest, NextResponse } from 'next/server';
import { execFile } from 'child_process';
import { stat } from 'fs/promises';
import { writeFile, unlink } from 'fs/promises';
import path from 'path';
import { tmpdir, platform, homedir } from 'os';
import { createHmac } from 'crypto';
import { getSetting } from '@unturf/unfirehose/db/ingest';
import { getDb } from '@unturf/unfirehose/db/schema';
import { discoverNodes } from '@unturf/unfirehose/mesh';

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
  const { projectPath: rawProjectPath, sessionId, yolo, prompt, parentSessionUuid, host: requestedHost, todoIds, projectName, harness, preferMultiplexer, bootstrap, sudoPassword, repoUrl } = body;

  // Resolve projectPath — support ~ expansion and bootstrap mode
  const homePath = homedir();
  let projectPath = rawProjectPath;
  if (typeof projectPath === 'string' && projectPath.startsWith('~/')) {
    projectPath = path.join(homePath, projectPath.slice(2));
  }

  // Validate projectPath
  if (!projectPath || typeof projectPath !== 'string') {
    return NextResponse.json({ error: 'Missing projectPath' }, { status: 400 });
  }

  // Validate sessionId if provided
  if (sessionId && !UUID_RE.test(sessionId)) {
    return NextResponse.json({ error: 'Invalid session ID format' }, { status: 400 });
  }

  const host = resolveBootHost(requestedHost);
  const isUnsandbox = host === 'unsandbox';
  const isRemote = host !== 'localhost' && !isUnsandbox;

  // Unsandbox boot — route through unsandbox API
  if (isUnsandbox) {
    return bootUnsandbox(body, projectPath, repoUrl);
  }

  // Validate path exists (local only — remote paths are trusted)
  // In bootstrap mode, create the directory if it doesn't exist
  if (!isRemote) {
    try {
      const s = await stat(projectPath);
      if (!s.isDirectory()) throw new Error('Not a directory');
    } catch {
      if (bootstrap) {
        try {
          const { mkdir } = await import('fs/promises');
          await mkdir(projectPath, { recursive: true });
        } catch (mkdirErr) {
          return NextResponse.json({ error: `Failed to create directory: ${projectPath}`, detail: String(mkdirErr) }, { status: 500 });
        }
      } else {
        return NextResponse.json({ error: `Invalid project path: ${projectPath}` }, { status: 400 });
      }
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

  const opts: BootOpts = { projectPath, sessionId, yolo, prompt, sessionName, windowName, parentSessionUuid, harness: harness || 'claude' };

  try {
    let response: NextResponse;

    if (isRemote) {
      response = await bootRemote(host, opts, sudoPassword);
    } else if (IS_WINDOWS) {
      response = await bootWindows(opts);
    } else {
      // Default to tmux — only use screen if explicitly requested
      const mux = preferMultiplexer === 'screen' ? 'screen' : 'tmux' as const;
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
  harness: string;       // 'claude' or custom command string
}

// eslint-disable-next-line @typescript-eslint/no-unused-vars
async function _detectMultiplexer(): Promise<'tmux' | 'screen' | null> {
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
  if (opts.harness !== 'claude') return opts.harness;

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
  const cleanupFiles: string[] = [];

  if (opts.harness !== 'claude') {
    return { parts: [opts.harness], cleanupFiles };
  }

  const parts = ['claude'];

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

// Get the primary git fetch remote URL for a local project path
async function getLocalGitRemote(projectPath: string): Promise<string | null> {
  try {
    const { stdout } = await exec('git', ['-C', projectPath, 'remote', '-v'], { timeout: 5000 });
    // Prefer origin fetch, fallback to any fetch remote
    const lines = stdout.trim().split('\n').filter(Boolean);
    const originFetch = lines.find(l => l.startsWith('origin\t') && l.includes('(fetch)'));
    const anyFetch = lines.find(l => l.includes('(fetch)'));
    const line = originFetch || anyFetch;
    if (!line) return null;
    const match = line.match(/\t(\S+)\s+\(fetch\)/);
    return match?.[1] ?? null;
  } catch {
    return null;
  }
}

// Get the default branch (main or master) for a local repo
async function getLocalDefaultBranch(projectPath: string): Promise<string> {
  try {
    const { stdout } = await exec('git', ['-C', projectPath, 'rev-parse', '--abbrev-ref', 'HEAD'], { timeout: 5000 });
    return stdout.trim() || 'main';
  } catch {
    return 'main';
  }
}

// Ensure the project repo exists on the remote host, clone if needed
async function ensureRemoteRepo(sshBase: string[], projectPath: string) {
  const sshCmd = sshBase[0];
  const sshArgs = sshBase.slice(1);

  // Check if project dir exists on remote
  try {
    await exec(sshCmd, [...sshArgs, `test -d '${projectPath}'`], { timeout: 10000 });
    return; // exists, nothing to do
  } catch {
    // doesn't exist — need to clone
  }

  // Get git remote URL from local project
  const remoteUrl = await getLocalGitRemote(projectPath);
  if (!remoteUrl) {
    // No git remote — just create the directory so the harness can start
    await exec(sshCmd, [...sshArgs, `mkdir -p '${projectPath}'`], { timeout: 10000 });
    return;
  }

  const defaultBranch = await getLocalDefaultBranch(projectPath);
  const parentDir = path.dirname(projectPath);

  // Clone the repo on remote (SSH agent forwarding passes keys)
  const cloneCmd = [
    `mkdir -p '${parentDir}'`,
    `cd '${parentDir}'`,
    `git clone '${remoteUrl}' '${path.basename(projectPath)}'`,
    `cd '${path.basename(projectPath)}'`,
    `git checkout '${defaultBranch}' 2>/dev/null || true`,
  ].join(' && ');

  await exec(sshCmd, [...sshArgs, cloneCmd], { timeout: 120000 });
}

// Run a command on remote with optional sudo password piped via stdin
function execRemoteSudo(sshBase: string[], cmd: string, sudoPassword: string, timeout = 120000): Promise<{ stdout: string; stderr: string }> {
  const sshCmd = sshBase[0];
  const sshArgs = sshBase.slice(1);
  // Replace bare "sudo " with "sudo -S " so it reads password from stdin
  const sudoCmd = cmd.replace(/\bsudo\b/g, 'sudo -S');
  return new Promise((resolve, reject) => {
    const child = execFile(sshCmd, [...sshArgs, sudoCmd], { timeout }, (err, stdout, stderr) => {
      if (err) reject(Object.assign(err, { stderr }));
      else resolve({ stdout, stderr });
    });
    // Pipe password to stdin for sudo -S
    child.stdin?.write(sudoPassword + '\n');
    child.stdin?.end();
  });
}

// Bootstrap missing tools on remote host via SSH
async function ensureRemoteTools(sshBase: string[], host: string, sudoPassword?: string): Promise<{ bootstrapped: string[] }> {
  const sshCmd = sshBase[0];
  const sshArgs = sshBase.slice(1);
  const bootstrapped: string[] = [];

  // Helper: run with sudo password if provided, otherwise plain exec
  const sudoExec = (cmd: string, timeout = 120000) =>
    sudoPassword
      ? execRemoteSudo(sshBase, cmd, sudoPassword, timeout)
      : exec(sshCmd, [...sshArgs, cmd], { timeout });

  // Check and install tmux
  try {
    await exec(sshCmd, [...sshArgs, 'which tmux'], { timeout: 10000 });
  } catch {
    // Try apt first (Debian/Ubuntu), fall back to yum/dnf
    const installCmd = [
      'sudo apt-get update -qq && sudo apt-get install -y -qq tmux',
      '|| sudo yum install -y tmux 2>/dev/null',
      '|| sudo dnf install -y tmux 2>/dev/null',
    ].join(' ');
    await sudoExec(installCmd);
    bootstrapped.push('tmux');
  }

  // Helper to source nvm before running commands (bashrc guards against non-interactive)
  const nvmPrefix = 'export NVM_DIR="$HOME/.nvm" && [ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh"; ';

  // Check and install node/npm if missing (needed for claude)
  try {
    await exec(sshCmd, [...sshArgs, `${nvmPrefix}which node`], { timeout: 10000 });
  } catch {
    // Install node via nvm
    const installCmd = [
      'export NVM_DIR="$HOME/.nvm"',
      '&& ([ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh" || true)',
      '&& (command -v nvm >/dev/null || curl -fsSL https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.3/install.sh | bash)',
      '&& export NVM_DIR="$HOME/.nvm"',
      '&& . "$NVM_DIR/nvm.sh"',
      '&& nvm install --lts',
      '&& nvm alias default lts/*',
    ].join(' ');
    await exec(sshCmd, [...sshArgs, installCmd], { timeout: 180000 });
    bootstrapped.push('node');
  }

  // Check and install claude CLI
  try {
    await exec(sshCmd, [...sshArgs, `${nvmPrefix}which claude`], { timeout: 15000 });
  } catch {
    await exec(sshCmd, [...sshArgs, 'sudo snap install claude-code --classic'], { timeout: 180000 });
    bootstrapped.push('claude');
  }

  // Verify claude is now available
  try {
    await exec(sshCmd, [...sshArgs, `${nvmPrefix}which claude`], { timeout: 15000 });
  } catch {
    throw new Error(`Failed to bootstrap claude on ${host}. Check that npm install succeeded and claude is in PATH.`);
  }

  // Make RAPL energy counters readable for power monitoring (needs sudo)
  if (sudoPassword) {
    try {
      await sudoExec('sudo chmod +r /sys/class/powercap/intel-rapl/intel-rapl:*/energy_uj 2>/dev/null; true', 10000);
      bootstrapped.push('rapl');
    } catch { /* non-fatal */ }
  }

  return { bootstrapped };
}

// Sync Claude credentials to remote host via scp
async function syncClaudeCredentials(host: string): Promise<boolean> {
  const credFile = path.join(homedir(), '.claude', '.credentials.json');
  const settingsFile = path.join(homedir(), '.claude', 'settings.json');
  const settingsLocalFile = path.join(homedir(), '.claude', 'settings.local.json');
  const claudeJson = path.join(homedir(), '.claude.json');

  try {
    await stat(credFile);
  } catch {
    return false; // no local credentials to sync
  }

  const sshOpts = ['-o', 'ConnectTimeout=10', '-o', 'StrictHostKeyChecking=no'];

  // Ensure ~/.claude exists on remote
  await exec('ssh', [...sshOpts, host, 'mkdir -p ~/.claude'], { timeout: 10000 });

  // scp credentials
  await exec('scp', [...sshOpts, credFile, `${host}:~/.claude/.credentials.json`], { timeout: 15000 });

  // Sync ~/.claude.json (onboarding state, oauth account) — non-fatal
  try {
    await stat(claudeJson);
    await exec('scp', [...sshOpts, claudeJson, `${host}:~/.claude.json`], { timeout: 10000 });
  } catch { /* non-fatal */ }

  // Also sync settings if they exist (non-fatal)
  for (const f of [settingsFile, settingsLocalFile]) {
    try {
      await stat(f);
      await exec('scp', [...sshOpts, f, `${host}:~/.claude/${path.basename(f)}`], { timeout: 10000 });
    } catch { /* non-fatal */ }
  }

  return true;
}

async function bootRemote(host: string, opts: BootOpts, sudoPassword?: string) {
  // -A enables agent forwarding so git on remote can use local SSH keys
  const sshBase = ['ssh', '-A', '-o', 'ConnectTimeout=10', '-o', 'StrictHostKeyChecking=no', host];

  // Bootstrap: install tmux, node, and claude if missing
  const { bootstrapped } = await ensureRemoteTools(sshBase, host, sudoPassword);

  // Sync Claude credentials to remote
  await syncClaudeCredentials(host);

  // Ensure project repo exists on remote — clone if missing
  await ensureRemoteRepo(sshBase, opts.projectPath);

  // Build the claude command for remote execution
  const claudeCmd = buildClaudeCmd(opts);
  const envVars = [
    'export NVM_DIR="$HOME/.nvm"',
    '[ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh"',
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
    bootstrapped: bootstrapped.length ? bootstrapped : undefined,
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

// ---- Unsandbox boot ----

const UNSANDBOX_API_BASE = 'https://api.unsandbox.com';

function unsandboxSign(secretKey: string, method: string, apiPath: string, body: string): { timestamp: string; signature: string } {
  const timestamp = Math.floor(Date.now() / 1000).toString();
  const message = `${timestamp}:${method}:${apiPath}:${body}`;
  const signature = createHmac('sha256', secretKey).update(message).digest('hex');
  return { timestamp, signature };
}

function unsandboxHeaders(publicKey: string, secretKey: string, method: string, apiPath: string, body: string = ''): Record<string, string> {
  const { timestamp, signature } = unsandboxSign(secretKey, method, apiPath, body);
  return {
    'Authorization': `Bearer ${publicKey}`,
    'X-Timestamp': timestamp,
    'X-Signature': signature,
    'Content-Type': 'application/json',
  };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function bootUnsandbox(body: any, projectPath: string, passedRepoUrl?: string) {
  const publicKey = getSetting('unsandbox_public_key');
  const secretKey = getSetting('unsandbox_secret_key');
  if (!publicKey || !secretKey) {
    return NextResponse.json({ error: 'No unsandbox API keys configured', detail: 'Add keys in Permacomputer settings.' }, { status: 400 });
  }

  const { prompt, yolo, harness: harnessName, projectName } = body;

  // Get the git remote URL — prefer passed URL, fall back to local project
  let repoUrl: string | null = passedRepoUrl || null;
  if (!repoUrl) {
    try {
      repoUrl = await getLocalGitRemote(projectPath);
    } catch { /* no git remote */ }
  }

  // 1. Create a session on unsandbox
  const sessionPath = '/sessions';
  const sessionPayload = JSON.stringify({
    image: 'ubuntu:24.04',
    network_mode: 'semitrusted',
  });
  const sessionHeaders = unsandboxHeaders(publicKey, secretKey, 'POST', sessionPath, sessionPayload);

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let session: any;
  try {
    const res = await fetch(`${UNSANDBOX_API_BASE}${sessionPath}`, {
      method: 'POST', headers: sessionHeaders, body: sessionPayload,
      signal: AbortSignal.timeout(30000),
    });
    session = await res.json();
    if (!res.ok) {
      return NextResponse.json({ error: session.error || 'Failed to create unsandbox session' }, { status: 500 });
    }
  } catch (err) {
    return NextResponse.json({ error: `Unsandbox session creation failed: ${err}` }, { status: 500 });
  }

  const sessionId = session.session_id || session.id;

  // 2. Bootstrap the session: install tools, clone repo, run harness
  const repoName = path.basename(projectPath);
  const workDir = `/workspace/${repoName}`;

  const setupParts = [
    '#!/bin/bash',
    'set -e',
    // Golden image has batteries included — no apt-get needed
  ];

  // Clone repo if we have a URL
  if (repoUrl) {
    setupParts.push(`git clone '${repoUrl}' '${workDir}' 2>&1 || (mkdir -p '${workDir}')`);
  } else {
    setupParts.push(`mkdir -p '${workDir}'`);
  }

  setupParts.push(`cd '${workDir}'`);

  // Install harness
  const resolvedHarness = harnessName || 'claude';
  if (resolvedHarness === 'claude') {
    // claude-code is pre-installed in the golden image
  }

  // Build the harness command
  let harnessCmd = resolvedHarness === 'claude' ? 'claude' : resolvedHarness;
  if (resolvedHarness === 'claude') {
    if (yolo) harnessCmd += ' --dangerously-skip-permissions';
    if (yolo) {
      const escaped = AGENT_SYSTEM_PROMPT.replace(/'/g, "'\\''");
      harnessCmd += ` --append-system-prompt '${escaped}'`;
    }
    if (prompt) {
      const escaped = prompt.replace(/'/g, "'\\''");
      harnessCmd += ` '${escaped}'`;
    }
  }

  setupParts.push(harnessCmd);

  const setupScript = setupParts.join('\n');
  const execPath = `/sessions/${sessionId}/execute`;
  const execPayload = JSON.stringify({ command: setupScript });
  const execHeaders = unsandboxHeaders(publicKey, secretKey, 'POST', execPath, execPayload);

  try {
    // Fire and forget — the session runs in background, we don't wait for claude to finish
    fetch(`${UNSANDBOX_API_BASE}${execPath}`, {
      method: 'POST', headers: execHeaders, body: execPayload,
      signal: AbortSignal.timeout(300000),
    }).catch(() => {});

    // Register deployment
    if (projectName) {
      try {
        const db = getDb();
        const proj = db.prepare('SELECT id FROM projects WHERE name = ?').get(projectName) as { id: number } | undefined;
        if (proj) {
          db.prepare(`
            INSERT INTO agent_deployments (tmux_session, tmux_window, project_id, todo_ids, status, started_at)
            VALUES (?, ?, ?, ?, 'running', datetime('now'))
          `).run(`unsandbox-${sessionId}`, 'main', proj.id, JSON.stringify(body.todoIds ?? []));
        }
      } catch { /* non-fatal */ }
    }

    return NextResponse.json({
      success: true,
      tmuxSession: `unsandbox-${sessionId}`,
      tmuxWindow: 'main',
      multiplexer: 'unsandbox',
      host: 'unsandbox',
      sessionId,
      command: `unsandbox session ${sessionId}`,
    });
  } catch (err) {
    return NextResponse.json({ error: `Unsandbox harness boot failed: ${err}` }, { status: 500 });
  }
}
