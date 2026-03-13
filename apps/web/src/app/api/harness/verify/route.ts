import { NextRequest, NextResponse } from 'next/server';
import { execFile } from 'child_process';
import { stat } from 'fs/promises';
import path from 'path';
import { homedir } from 'os';

function exec(cmd: string, args: string[], opts: { timeout: number }): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, opts, (err, stdout, stderr) => {
      if (err) reject(Object.assign(err, { stderr }));
      else resolve({ stdout, stderr });
    });
  });
}

async function syncClaudeCredentials(host: string): Promise<boolean> {
  const credFile = path.join(homedir(), '.claude', '.credentials.json');
  const settingsFile = path.join(homedir(), '.claude', 'settings.json');
  const settingsLocalFile = path.join(homedir(), '.claude', 'settings.local.json');
  const claudeJson = path.join(homedir(), '.claude.json');

  try {
    await stat(credFile);
  } catch {
    return false;
  }

  const sshOpts = ['-o', 'ConnectTimeout=10', '-o', 'StrictHostKeyChecking=no'];
  await exec('ssh', [...sshOpts, host, 'umask 077 && mkdir -p ~/.claude'], { timeout: 10000 });
  await exec('scp', [...sshOpts, '-p', credFile, `${host}:~/.claude/.credentials.json`], { timeout: 15000 });

  try {
    await stat(claudeJson);
    await exec('scp', [...sshOpts, claudeJson, `${host}:~/.claude.json`], { timeout: 10000 });
  } catch { /* non-fatal */ }

  for (const f of [settingsFile, settingsLocalFile]) {
    try {
      await stat(f);
      await exec('scp', [...sshOpts, '-p', f, `${host}:~/.claude/${path.basename(f)}`], { timeout: 10000 });
    } catch { /* non-fatal */ }
  }

  // Lock down permissions
  await exec('ssh', [...sshOpts, host,
    'chmod 700 ~/.claude && chmod 600 ~/.claude/.credentials.json ~/.claude/settings.json ~/.claude/settings.local.json ~/.claude.json 2>/dev/null || true',
  ], { timeout: 10000 });

  return true;
}

// POST /api/harness/verify — install + verify a harness on a node
export async function POST(request: NextRequest) {
  const body = await request.json();
  const { host, install, verify, id } = body;

  if (!verify || typeof verify !== 'string') {
    return NextResponse.json({ error: 'verify command required' }, { status: 400 });
  }

  const isRemote = host && host !== 'localhost';
  const nvmPrefix = 'export NVM_DIR="$HOME/.nvm" && [ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh"; ';
  const steps: { step: string; ok: boolean; output?: string }[] = [];

  try {
    // Step 1: Install (if provided)
    if (install) {
      try {
        if (isRemote) {
          const sshOpts = ['-o', 'ConnectTimeout=10', '-o', 'StrictHostKeyChecking=no'];
          const { stdout, stderr } = await exec('ssh', [...sshOpts, host, `bash -lc '${nvmPrefix}${install.replace(/'/g, "'\\''")}'`], { timeout: 180000 });
          steps.push({ step: 'install', ok: true, output: (stdout + stderr).trim().slice(-500) });
        } else {
          const { stdout, stderr } = await exec('bash', ['-lc', `${nvmPrefix}${install}`], { timeout: 180000 });
          steps.push({ step: 'install', ok: true, output: (stdout + stderr).trim().slice(-500) });
        }
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      } catch (err: any) {
        steps.push({ step: 'install', ok: false, output: (err.stderr || String(err)).slice(-500) });
        // Don't fail — install might error if already installed, try verify anyway
      }
    }

    // Step 2: Sync credentials (claude-code only)
    if (id === 'claude-code' && isRemote) {
      try {
        const synced = await syncClaudeCredentials(host);
        steps.push({ step: 'credentials', ok: synced, output: synced ? 'synced' : 'no local credentials found' });
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      } catch (err: any) {
        steps.push({ step: 'credentials', ok: false, output: String(err).slice(-500) });
      }
    }

    // Step 3: Verify
    let version = '';
    try {
      if (isRemote) {
        const sshOpts = ['-o', 'ConnectTimeout=10', '-o', 'StrictHostKeyChecking=no'];
        const { stdout } = await exec('ssh', [...sshOpts, host, `bash -lc '${nvmPrefix}${verify.replace(/'/g, "'\\''")}'`], { timeout: 30000 });
        version = stdout.trim();
        steps.push({ step: 'verify', ok: true, output: version });
      } else {
        const { stdout } = await exec('bash', ['-lc', `${nvmPrefix}${verify}`], { timeout: 30000 });
        version = stdout.trim();
        steps.push({ step: 'verify', ok: true, output: version });
      }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } catch (err: any) {
      steps.push({ step: 'verify', ok: false, output: (err.stderr || String(err)).slice(-500) });
      return NextResponse.json({ success: false, steps, error: 'Verification failed — harness not found or not working' });
    }

    return NextResponse.json({ success: true, version, steps });
  } catch (err) {
    return NextResponse.json({ success: false, error: String(err), steps }, { status: 500 });
  }
}
