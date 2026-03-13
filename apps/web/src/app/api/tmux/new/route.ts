import { NextRequest, NextResponse } from 'next/server';
import { execFile } from 'child_process';
import { promisify } from 'util';

const execFileAsync = promisify(execFile);

function validateSession(name: string): void {
  if (!/^[a-zA-Z0-9_-]{1,64}$/.test(name)) throw new Error('Invalid session name');
}
function validateHost(host: string): void {
  if (!/^[a-zA-Z0-9._-]+$/.test(host)) throw new Error('Invalid hostname');
}

export async function POST(request: NextRequest) {
  try {
    const { name, host, command } = await request.json();

    if (!name) return NextResponse.json({ error: 'name required' }, { status: 400 });
    validateSession(name);

    const isRemote = host && host !== 'localhost';
    if (isRemote) validateHost(host);

    // Default shell — prefer zsh, fall back to bash
    const cmd = (command && typeof command === 'string' && command.trim())
      ? command.trim()
      : 'zsh || bash';

    const tmuxArgs = ['new-session', '-d', '-s', name, '-x', '220', '-y', '50', cmd];

    if (isRemote) {
      await execFileAsync('ssh', [
        '-o', 'StrictHostKeyChecking=no', '-o', 'ConnectTimeout=10',
        host,
        `tmux new-session -d -s ${name} -x 220 -y 50 '${cmd.replace(/'/g, "'\\''")}'`,
      ], { timeout: 15000 });
    } else {
      await execFileAsync('tmux', tmuxArgs, { timeout: 5000 });
    }

    return NextResponse.json({ ok: true, name, host: host || 'localhost' });
  } catch (err: unknown) {
    const msg = String(err);
    // tmux exits 1 if session name already exists
    if (msg.includes('duplicate session')) {
      return NextResponse.json({ error: 'session name already exists' }, { status: 409 });
    }
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
