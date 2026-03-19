import { NextRequest, NextResponse } from 'next/server';
import { createHmac } from 'crypto';
import { writeFile, mkdir, unlink } from 'fs/promises';
import path from 'path';
import { homedir } from 'os';
import { execSync } from 'child_process';
import { getSetting } from '@unturf/unfirehose/db/ingest';

/* eslint-disable @typescript-eslint/no-explicit-any */

const API_BASE = 'https://api.unsandbox.com';

function sign(secretKey: string, method: string, apiPath: string, body: string) {
  const timestamp = Math.floor(Date.now() / 1000).toString();
  const message = `${timestamp}:${method}:${apiPath}:${body}`;
  const signature = createHmac('sha256', secretKey).update(message).digest('hex');
  return { timestamp, signature };
}

function authHeaders(publicKey: string, secretKey: string, method: string, apiPath: string, body = '') {
  const { timestamp, signature } = sign(secretKey, method, apiPath, body);
  return {
    'Authorization': `Bearer ${publicKey}`,
    'X-Timestamp': timestamp,
    'X-Signature': signature,
    'Content-Type': 'application/json',
  };
}

// Package claude session data into /root/artifacts/ for retrieval
const SYNC_SCRIPT = `#!/bin/bash
set -e
mkdir -p /root/artifacts
CLAUDE_DIR="$HOME/.claude/projects"
if [ ! -d "$CLAUDE_DIR" ]; then
  echo '{"error":"no claude projects directory"}'
  exit 0
fi

# Create a tar of all session JSONL + indexes, preserving directory structure
cd "$HOME/.claude"
tar czf /root/artifacts/claude-sessions.tar.gz \
  --include='*.jsonl' \
  --include='sessions-index.json' \
  -C "$HOME/.claude" projects/ 2>/dev/null || true

# Also output a manifest so we know what we got
find projects/ -name '*.jsonl' -o -name 'sessions-index.json' 2>/dev/null | sort
echo "---"
du -sh /root/artifacts/claude-sessions.tar.gz 2>/dev/null || echo "0 bytes"
`;

/**
 * POST /api/unsandbox/sync
 *
 * Pulls claude session JSONL + todos off a running unsandbox service.
 *
 * Body: { serviceId: string }
 *
 * Flow:
 *   1. POST /services/{id}/execute — tar up ~/.claude/projects/ into /root/artifacts/
 *   2. Poll GET /jobs/{job_id} until complete (artifacts returned)
 *   3. Decode base64 tar, extract to ~/.claude/projects/unsandbox-{serviceId}/
 *   4. Normal ingest picks it up
 */
export async function POST(request: NextRequest) {
  const publicKey = getSetting('unsandbox_public_key');
  const secretKey = getSetting('unsandbox_secret_key');
  if (!publicKey || !secretKey) {
    return NextResponse.json({ error: 'No unsandbox keys configured' }, { status: 400 });
  }

  const body = await request.json();
  const { serviceId } = body;
  if (!serviceId) {
    return NextResponse.json({ error: 'Missing serviceId' }, { status: 400 });
  }

  // 1. Execute sync script on the service
  const execPath = `/services/${serviceId}/execute`;
  const execPayload = JSON.stringify({
    command: SYNC_SCRIPT,
    timeout: 60000,
  });
  const execHeaders = authHeaders(publicKey, secretKey, 'POST', execPath, execPayload);

  let jobId: string;
  try {
    const res = await fetch(`${API_BASE}${execPath}`, {
      method: 'POST',
      headers: execHeaders,
      body: execPayload,
      signal: AbortSignal.timeout(15000),
    });
    const data = await res.json();
    if (!res.ok) {
      return NextResponse.json({ error: data.error || `HTTP ${res.status}` }, { status: res.status });
    }
    jobId = data.job_id;
    if (!jobId) {
      return NextResponse.json({ error: 'No job_id returned', data }, { status: 500 });
    }
  } catch (err) {
    return NextResponse.json({ error: `Execute failed: ${err}` }, { status: 500 });
  }

  // 2. Poll for job completion (max ~60s)
  const pollPath = `/jobs/${jobId}`;
  let result: any = null;
  for (let i = 0; i < 30; i++) {
    await new Promise((r) => setTimeout(r, 2000));
    const headers = authHeaders(publicKey, secretKey, 'GET', pollPath);
    try {
      const res = await fetch(`${API_BASE}${pollPath}`, {
        headers,
        signal: AbortSignal.timeout(10000),
      });
      const data = await res.json();
      if (data.status === 'completed' || data.status === 'failed' || data.status === 'cancelled') {
        result = data;
        break;
      }
    } catch {
      // Retry on transient failure
    }
  }

  if (!result) {
    return NextResponse.json({ error: 'Job timed out waiting for completion', jobId }, { status: 504 });
  }

  if (result.exit_code !== 0) {
    return NextResponse.json({
      error: 'Sync script failed',
      exit_code: result.exit_code,
      stdout: result.stdout?.slice(0, 2000),
      stderr: result.stderr?.slice(0, 2000),
    }, { status: 500 });
  }

  // 3. Extract artifacts
  const artifacts: any[] = result.artifacts ?? [];
  const tarArtifact = artifacts.find((a: any) =>
    a.filename === 'claude-sessions.tar.gz' || (artifacts.length === 1)
  );

  if (!tarArtifact?.data) {
    return NextResponse.json({
      error: 'No artifact returned — container may have no claude session data',
      stdout: result.stdout?.slice(0, 2000),
      artifacts: artifacts.map((a: any) => ({ filename: a.filename, size: a.data?.length ?? 0 })),
    }, { status: 200 });
  }

  // 4. Write tar to temp, extract to local claude projects dir
  const tarBuffer = Buffer.from(tarArtifact.data, 'base64');
  const destDir = path.join(homedir(), '.claude', 'projects');
  const tmpTar = path.join(homedir(), '.unfirehose', `unsandbox-sync-${serviceId}.tar.gz`);

  try {
    await mkdir(path.dirname(tmpTar), { recursive: true });
    await writeFile(tmpTar, tarBuffer, { mode: 0o600 });

    // Extract — tar preserves the projects/ structure
    // Files land in ~/.claude/projects/ alongside local projects
    execSync(`tar xzf "${tmpTar}" -C "${destDir}" --strip-components=1 2>/dev/null || true`, {
      timeout: 30000,
    });

    // Cleanup temp tar — zero contents first, then remove
    await writeFile(tmpTar, '', { mode: 0o600 });
    await unlink(tmpTar).catch(() => {});

    return NextResponse.json({
      ok: true,
      serviceId,
      jobId,
      artifactSize: tarBuffer.length,
      manifest: result.stdout?.slice(0, 5000),
    });
  } catch (err) {
    return NextResponse.json({ error: `Extract failed: ${err}` }, { status: 500 });
  }
}

/**
 * GET /api/unsandbox/sync — list services available for sync
 */
export async function GET() {
  const publicKey = getSetting('unsandbox_public_key');
  const secretKey = getSetting('unsandbox_secret_key');
  if (!publicKey || !secretKey) {
    return NextResponse.json({ error: 'No unsandbox keys configured' }, { status: 400 });
  }

  try {
    const svcPath = '/services';
    const headers = authHeaders(publicKey, secretKey, 'GET', svcPath);
    const res = await fetch(`${API_BASE}${svcPath}`, { headers, signal: AbortSignal.timeout(10000) });
    const data = await res.json();
    const services = (data.services ?? data ?? []).map((svc: any) => ({
      id: svc.id,
      name: svc.name,
      status: svc.status,
      created_at: svc.created_at,
    }));
    return NextResponse.json({ services });
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 500 });
  }
}
