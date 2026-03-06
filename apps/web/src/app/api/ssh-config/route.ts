import { NextRequest, NextResponse } from 'next/server';
import { readFile, writeFile, readdir } from 'fs/promises';
import { homedir } from 'os';
import path from 'path';

const SSH_DIR = path.join(homedir(), '.ssh');
const SSH_CONFIG = path.join(SSH_DIR, 'config');

interface SshHost {
  name: string;
  hostname?: string;
  port?: string;
  user?: string;
  identityFile?: string;
  forwardAgent?: string;
  raw: string; // full block text for round-tripping
}

function parseSshConfig(text: string): SshHost[] {
  const hosts: SshHost[] = [];
  const blocks = text.split(/^(?=Host\s)/m);

  for (const block of blocks) {
    const trimmed = block.trim();
    if (!trimmed) continue;

    const hostMatch = trimmed.match(/^Host\s+(.+)/m);
    if (!hostMatch) continue;

    const name = hostMatch[1].trim().split(/\s+/)[0];
    if (name.includes('*')) continue; // skip wildcard blocks

    const get = (key: string) => {
      const m = trimmed.match(new RegExp(`^\\s*${key}\\s+(.+)`, 'mi'));
      return m?.[1]?.trim();
    };

    hosts.push({
      name,
      hostname: get('HostName') || get('Hostname'),
      port: get('Port'),
      user: get('User'),
      identityFile: get('IdentityFile'),
      forwardAgent: get('ForwardAgent'),
      raw: trimmed,
    });
  }

  return hosts;
}

function serializeHost(host: { name: string; hostname?: string; port?: string; user?: string; identityFile?: string; forwardAgent?: string }): string {
  const lines = [`Host ${host.name}`];
  if (host.hostname) lines.push(`    HostName ${host.hostname}`);
  if (host.port) lines.push(`    Port ${host.port}`);
  if (host.user) lines.push(`    User ${host.user}`);
  if (host.identityFile) lines.push(`    IdentityFile ${host.identityFile}`);
  if (host.forwardAgent) lines.push(`    ForwardAgent ${host.forwardAgent}`);
  return lines.join('\n');
}

// GET — list hosts + available keys
export async function GET() {
  let configText = '';
  try {
    configText = await readFile(SSH_CONFIG, 'utf-8');
  } catch {
    // no config yet
  }

  const hosts = parseSshConfig(configText);

  // List available public keys
  let keys: string[] = [];
  try {
    const files = await readdir(SSH_DIR);
    keys = files.filter(f => f.endsWith('.pub')).map(f => f.replace('.pub', ''));
  } catch {
    // no .ssh dir
  }

  return NextResponse.json({ hosts, keys });
}

// POST — add or update a host entry
export async function POST(request: NextRequest) {
  const body = await request.json();
  const { name, hostname, port, user, identityFile, forwardAgent } = body;

  if (!name || typeof name !== 'string') {
    return NextResponse.json({ error: 'Missing host name' }, { status: 400 });
  }

  // Reject wildcards and dangerous names
  if (name.includes('*') || name.includes('/') || name.includes('..')) {
    return NextResponse.json({ error: 'Invalid host name' }, { status: 400 });
  }

  let configText = '';
  try {
    configText = await readFile(SSH_CONFIG, 'utf-8');
  } catch {
    // will create
  }

  const hosts = parseSshConfig(configText);
  const existing = hosts.find(h => h.name === name);
  const newBlock = serializeHost({ name, hostname, port, user, identityFile, forwardAgent });

  let newConfig: string;
  if (existing) {
    // Replace existing block
    newConfig = configText.replace(existing.raw, newBlock);
  } else {
    // Append
    newConfig = configText.trimEnd() + '\n\n' + newBlock + '\n';
  }

  await writeFile(SSH_CONFIG, newConfig, { mode: 0o600 });

  return NextResponse.json({ ok: true, host: { name, hostname, port, user, identityFile, forwardAgent } });
}

// DELETE — remove a host entry
export async function DELETE(request: NextRequest) {
  const body = await request.json();
  const { name } = body;

  if (!name || typeof name !== 'string') {
    return NextResponse.json({ error: 'Missing host name' }, { status: 400 });
  }

  let configText = '';
  try {
    configText = await readFile(SSH_CONFIG, 'utf-8');
  } catch {
    return NextResponse.json({ error: 'No SSH config found' }, { status: 404 });
  }

  const hosts = parseSshConfig(configText);
  const existing = hosts.find(h => h.name === name);
  if (!existing) {
    return NextResponse.json({ error: 'Host not found' }, { status: 404 });
  }

  const newConfig = configText.replace(existing.raw, '').replace(/\n{3,}/g, '\n\n').trim() + '\n';
  await writeFile(SSH_CONFIG, newConfig, { mode: 0o600 });

  return NextResponse.json({ ok: true });
}
