import { NextRequest, NextResponse } from 'next/server';
import { execFile } from 'child_process';
import { mkdirSync, writeFileSync } from 'fs';
import { join } from 'path';
import { promisify } from 'util';
import { createHmac } from 'crypto';
import { getSetting } from '@unturf/unfirehose/db/ingest';

const execFileAsync = promisify(execFile);

const MAX_BYTES = 50 * 1024 * 1024; // 50 MB
const MAX_UNSANDBOX_BYTES = 50 * 1024 * 1024; // 50 MB — chunked heredoc injection
// Chunk size must be a multiple of 3 so base64 blocks are self-contained (no padding split)
const UNSANDBOX_CHUNK = 9 * 1024 * 1024; // 9 MB raw → ~12 MB base64 per request

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

async function unsandboxExec(
  publicKey: string,
  secretKey: string,
  sessionId: string,
  command: string,
  timeoutMs = 120000,
): Promise<void> {
  const apiPath = `/sessions/${sessionId}/execute`;
  const payload = JSON.stringify({ command });
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
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`unsandbox execute failed: ${res.status} ${text}`);
  }
}

async function injectIntoUnsandbox(sessionId: string, safeName: string, buf: Buffer): Promise<string> {
  const publicKey = getSetting('unsandbox_public_key');
  const secretKey = getSetting('unsandbox_secret_key');
  if (!publicKey || !secretKey) throw new Error('No unsandbox keys configured');

  const targetPath = `/tmp/input/${safeName}`;

  // Split into chunks (multiples of 3 bytes so base64 blocks are self-contained)
  const chunks: Buffer[] = [];
  for (let off = 0; off < buf.length; off += UNSANDBOX_CHUNK) {
    chunks.push(buf.subarray(off, off + UNSANDBOX_CHUNK));
  }

  for (let i = 0; i < chunks.length; i++) {
    const b64 = chunks[i].toString('base64');
    const redirect = i === 0 ? '>' : '>>';
    // Heredoc: b64 content goes into request body (JSON), not a shell argument —
    // no shell argument length limit. base64 -d reads from heredoc stdin.
    const cmd = i === 0
      ? `mkdir -p /tmp/input\nbase64 -d << 'UNSB_EOF' ${redirect} '${targetPath}'\n${b64}\nUNSB_EOF`
      : `base64 -d << 'UNSB_EOF' ${redirect} '${targetPath}'\n${b64}\nUNSB_EOF`;
    await unsandboxExec(publicKey, secretKey, sessionId, cmd, 120000);
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
