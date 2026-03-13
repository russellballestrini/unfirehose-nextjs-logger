import { NextRequest, NextResponse } from 'next/server';
import { execFile } from 'child_process';
import { mkdirSync, writeFileSync } from 'fs';
import { join } from 'path';
import { promisify } from 'util';
import { createHmac } from 'crypto';
import { getSetting } from '@unturf/unfirehose/db/ingest';

const execFileAsync = promisify(execFile);

const MAX_BYTES = 50 * 1024 * 1024; // 50 MB
// Unsandbox: cap at 4 MB — base64 encoding ~33% overhead, shell arg limit
const MAX_UNSANDBOX_BYTES = 4 * 1024 * 1024;

function sanitizeName(name: string): string {
  return name.replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 128) || 'file';
}

function validateHost(host: string): void {
  if (!/^[a-zA-Z0-9._-]+$/.test(host)) throw new Error('Invalid hostname');
}

function signUnsandbox(secretKey: string, method: string, path: string, body = '') {
  const timestamp = Math.floor(Date.now() / 1000).toString();
  const sig = createHmac('sha256', secretKey).update(`${timestamp}:${method}:${path}:${body}`).digest('hex');
  return { timestamp, sig };
}

async function injectIntoUnsandbox(sessionId: string, safeName: string, buf: Buffer): Promise<string> {
  const publicKey = getSetting('unsandbox_public_key');
  const secretKey = getSetting('unsandbox_secret_key');
  if (!publicKey || !secretKey) throw new Error('No unsandbox keys configured');

  const targetPath = `/tmp/input/${safeName}`;
  const b64 = buf.toString('base64');

  // Inject via session execute: mkdir + base64 decode directly in the container
  const script = `mkdir -p /tmp/input\nprintf '%s' '${b64}' | base64 -d > '${targetPath}'`;
  const apiPath = `/sessions/${sessionId}/execute`;
  const payload = JSON.stringify({ command: script });
  const { timestamp, sig } = signUnsandbox(secretKey, 'POST', apiPath, payload);

  const res = await fetch(`https://api.unsandbox.com${apiPath}`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${publicKey}`,
      'X-Timestamp': timestamp,
      'X-Signature': sig,
      'Content-Type': 'application/json',
    },
    body: payload,
    signal: AbortSignal.timeout(60000),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`unsandbox inject failed: ${res.status} ${text}`);
  }

  return targetPath;
}

export async function POST(request: NextRequest) {
  try {
    const formData = await request.formData();
    const file = formData.get('file') as File | null;
    const session = formData.get('session') as string | null;
    const host = (formData.get('host') as string | null) || undefined;

    if (!file) return NextResponse.json({ error: 'file required' }, { status: 400 });
    // session may be a tmux name (alphanumeric) or unsandbox session_id (UUID-like with hyphens)
    if (!session || !/^[a-zA-Z0-9_-]+$/.test(session)) {
      return NextResponse.json({ error: 'valid session required' }, { status: 400 });
    }
    if (host && host !== 'localhost' && host !== 'unsandbox') validateHost(host);

    const bytes = await file.arrayBuffer();
    const buf = Buffer.from(bytes);

    const safeName = sanitizeName(file.name);

    // ── Unsandbox: inject file into container via execute API ──────────────
    if (host === 'unsandbox') {
      if (buf.byteLength > MAX_UNSANDBOX_BYTES) {
        return NextResponse.json({ error: 'file too large for unsandbox (max 4 MB)' }, { status: 413 });
      }
      const targetPath = await injectIntoUnsandbox(session, safeName, buf);
      return NextResponse.json({ ok: true, path: targetPath, name: safeName });
    }

    // ── tmux (local / SSH) ─────────────────────────────────────────────────
    if (buf.byteLength > MAX_BYTES) {
      return NextResponse.json({ error: 'file too large (max 50 MB)' }, { status: 413 });
    }

    const isRemote = host && host !== 'localhost';
    const inputDir = '/tmp/input';
    mkdirSync(inputDir, { recursive: true });
    const localPath = join(inputDir, safeName);
    writeFileSync(localPath, buf);

    let targetPath = localPath;

    if (isRemote) {
      await execFileAsync('ssh', [
        '-o', 'StrictHostKeyChecking=no', '-o', 'ConnectTimeout=10',
        host!, `mkdir -p ${inputDir}`,
      ]);
      const remotePath = `${inputDir}/${safeName}`;
      await execFileAsync('scp', [
        '-o', 'StrictHostKeyChecking=no',
        localPath, `${host}:${remotePath}`,
      ]);
      targetPath = remotePath;
    }

    return NextResponse.json({ ok: true, path: targetPath, name: safeName });
  } catch (err: unknown) {
    return NextResponse.json({ error: String(err) }, { status: 500 });
  }
}
