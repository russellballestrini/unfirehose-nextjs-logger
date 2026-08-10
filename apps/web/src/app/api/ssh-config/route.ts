import { NextRequest, NextResponse } from 'next/server';
import { readFile, writeFile, readdir, rename } from 'fs/promises';
import { createHash } from 'crypto';
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

function hashConfig(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

async function readConfig(): Promise<string> {
  try {
    return await readFile(SSH_CONFIG, 'utf-8');
  } catch {
    return '';
  }
}

// Atomic write: temp file + rename so a concurrent reader never sees a torn
// config and a crash mid-write never truncates it.
async function writeConfigAtomic(text: string): Promise<void> {
  const tmp = path.join(SSH_DIR, `.config.tmp-${process.pid}`);
  await writeFile(tmp, text, { mode: 0o600 });
  await rename(tmp, SSH_CONFIG);
}

function invalidName(name: unknown): boolean {
  return !name || typeof name !== 'string' || name.includes('*') || name.includes('/') || name.includes('..');
}

function conflict(configText: string) {
  return NextResponse.json(
    { error: 'SSH config changed on disk since it was loaded', hosts: parseSshConfig(configText), hash: hashConfig(configText) },
    { status: 409 }
  );
}

// GET — list hosts + available keys + content hash for optimistic concurrency
export async function GET() {
  const configText = await readConfig();
  const hosts = parseSshConfig(configText);

  // List available public keys
  let keys: string[] = [];
  try {
    const files = await readdir(SSH_DIR);
    keys = files.filter(f => f.endsWith('.pub')).map(f => f.replace('.pub', ''));
  } catch {
    // no .ssh dir
  }

  return NextResponse.json({ hosts, keys, hash: hashConfig(configText) });
}

// POST — add, update, or rename a host entry.
// `originalName` targets the block being edited (supports renames);
// `hash` is the config hash the client loaded — mismatch means someone else
// wrote the file since, so we 409 instead of clobbering their change.
export async function POST(request: NextRequest) {
  const body = await request.json();
  const { name, hostname, port, user, identityFile, forwardAgent, originalName, hash } = body;

  if (invalidName(name)) {
    return NextResponse.json({ error: 'Invalid host name' }, { status: 400 });
  }
  if (originalName !== undefined && invalidName(originalName)) {
    return NextResponse.json({ error: 'Invalid original host name' }, { status: 400 });
  }

  const configText = await readConfig();
  if (hash && hash !== hashConfig(configText)) {
    return conflict(configText);
  }

  const hosts = parseSshConfig(configText);
  const targetName = originalName ?? name;
  const existing = hosts.find(h => h.name === targetName);

  // Renaming onto a name that already has its own block would silently fork —
  // reject so the caller resolves it explicitly.
  if (originalName && originalName !== name && hosts.some(h => h.name === name)) {
    return NextResponse.json({ error: `Host "${name}" already exists` }, { status: 400 });
  }

  const newBlock = serializeHost({ name, hostname, port, user, identityFile, forwardAgent });

  let newConfig: string;
  if (existing) {
    // Replace existing block by position, not String.replace, so identical
    // sibling blocks can't be swapped by mistake.
    const idx = configText.indexOf(existing.raw);
    newConfig = configText.slice(0, idx) + newBlock + configText.slice(idx + existing.raw.length);
  } else {
    // Append
    newConfig = configText.trimEnd() + '\n\n' + newBlock + '\n';
  }

  await writeConfigAtomic(newConfig);

  return NextResponse.json({
    ok: true,
    host: { name, hostname, port, user, identityFile, forwardAgent },
    hash: hashConfig(newConfig),
  });
}

// DELETE — remove a host entry (same hash precondition as POST)
export async function DELETE(request: NextRequest) {
  const body = await request.json();
  const { name, hash } = body;

  if (!name || typeof name !== 'string') {
    return NextResponse.json({ error: 'Missing host name' }, { status: 400 });
  }

  const configText = await readConfig();
  if (!configText) {
    return NextResponse.json({ error: 'No SSH config found' }, { status: 404 });
  }
  if (hash && hash !== hashConfig(configText)) {
    return conflict(configText);
  }

  const hosts = parseSshConfig(configText);
  const existing = hosts.find(h => h.name === name);
  if (!existing) {
    return NextResponse.json({ error: 'Host not found' }, { status: 404 });
  }

  const idx = configText.indexOf(existing.raw);
  const removed = configText.slice(0, idx) + configText.slice(idx + existing.raw.length);
  const newConfig = removed.replace(/\n{3,}/g, '\n\n').trim() + '\n';
  await writeConfigAtomic(newConfig);

  return NextResponse.json({ ok: true, hash: hashConfig(newConfig) });
}
