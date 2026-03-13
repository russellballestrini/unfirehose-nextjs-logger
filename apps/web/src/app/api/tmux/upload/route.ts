import { NextRequest, NextResponse } from 'next/server';
import { execFile } from 'child_process';
import { mkdirSync, writeFileSync } from 'fs';
import { join } from 'path';
import { promisify } from 'util';

const execFileAsync = promisify(execFile);

const DROP_DIR = '/tmp/unfirehose-drop';
const MAX_BYTES = 50 * 1024 * 1024; // 50 MB

function sanitizeName(name: string): string {
  return name.replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 128) || 'file';
}

function validateHost(host: string): void {
  if (!/^[a-zA-Z0-9._-]+$/.test(host)) throw new Error('Invalid hostname');
}

export async function POST(request: NextRequest) {
  try {
    const formData = await request.formData();
    const file = formData.get('file') as File | null;
    const session = formData.get('session') as string | null;
    const host = (formData.get('host') as string | null) || undefined;

    if (!file) return NextResponse.json({ error: 'file required' }, { status: 400 });
    if (!session || !/^[a-zA-Z0-9_-]+$/.test(session)) {
      return NextResponse.json({ error: 'valid session required' }, { status: 400 });
    }
    if (host && host !== 'localhost') validateHost(host);

    const bytes = await file.arrayBuffer();
    if (bytes.byteLength > MAX_BYTES) {
      return NextResponse.json({ error: 'file too large (max 50 MB)' }, { status: 413 });
    }

    // Save locally
    mkdirSync(DROP_DIR, { recursive: true });
    const safeName = sanitizeName(file.name);
    const localPath = join(DROP_DIR, safeName);
    writeFileSync(localPath, Buffer.from(bytes));

    let targetPath = localPath;

    // SCP to remote if needed
    if (host && host !== 'localhost') {
      const remoteDir = '/tmp/input';
      await execFileAsync('ssh', [
        '-o', 'StrictHostKeyChecking=no', '-o', 'ConnectTimeout=10',
        host, `mkdir -p ${remoteDir}`,
      ]);
      const remotePath = `${remoteDir}/${safeName}`;
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
