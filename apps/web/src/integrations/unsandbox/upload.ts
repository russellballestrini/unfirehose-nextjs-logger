import { NextResponse } from 'next/server';
import { getSetting } from '@unturf/unfirehose/db/ingest';
import { authHeaders, UNSANDBOX_API_BASE } from './auth';

/**
 * A file dropped on an unsandbox terminal: `POST /api/tmux/upload` with
 * `host: "unsandbox"` lands here through `integrations/server.ts`, and the
 * file is written into the container through its execute API.
 */

const MAX_UNSANDBOX_BYTES = 50 * 1024 * 1024; // 50 MB — chunked heredoc injection
// Chunk size must be a multiple of 3 so base64 blocks are self-contained (no padding split)
const UNSANDBOX_CHUNK = 9 * 1024 * 1024; // 9 MB raw → ~12 MB base64 per request

async function unsandboxExec(
  publicKey: string,
  secretKey: string,
  sessionId: string,
  command: string,
  timeoutMs = 120000,
): Promise<void> {
  const apiPath = `/sessions/${sessionId}/execute`;
  const payload = JSON.stringify({ command });
  const res = await fetch(`${UNSANDBOX_API_BASE}${apiPath}`, {
    method: 'POST',
    headers: authHeaders(publicKey, secretKey, 'POST', apiPath, payload),
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

export async function uploadToUnsandbox(session: string, safeName: string, buf: Buffer): Promise<Response> {
  if (buf.byteLength > MAX_UNSANDBOX_BYTES) {
    return NextResponse.json({ error: 'file too large for unsandbox (max 50 MB)' }, { status: 413 });
  }
  const targetPath = await injectIntoUnsandbox(session, safeName, buf);
  return NextResponse.json({ ok: true, path: targetPath, name: safeName });
}
