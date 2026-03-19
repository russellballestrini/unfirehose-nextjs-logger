import { NextRequest, NextResponse } from 'next/server';
import { createHmac } from 'crypto';
import { writeFile, mkdir, unlink, readdir, stat } from 'fs/promises';
import path from 'path';
import { homedir } from 'os';
import { execSync } from 'child_process';
import { getSetting, setSetting } from '@unturf/unfirehose/db/ingest';

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

/**
 * Build a delta-aware sync script.
 * Uses a marker file on the container to track last sync time.
 * Only tars files modified since the marker, then touches the marker.
 * First sync (no marker) sends everything.
 */
function buildSyncScript() {
  return `#!/bin/bash
set -e
mkdir -p /root/artifacts
CLAUDE_DIR="$HOME/.claude/projects"
MARKER="$HOME/.claude/.last_sync"

if [ ! -d "$CLAUDE_DIR" ]; then
  echo '{"files":0,"bytes":0,"delta":false}'
  exit 0
fi

cd "$HOME/.claude"

if [ -f "$MARKER" ]; then
  # Delta: only files modified since last sync
  NEWER="-newer $MARKER"
  DELTA=true
else
  NEWER=""
  DELTA=false
fi

# Find JSONL + index files (delta or full)
FILELIST=$(find projects/ \\( -name '*.jsonl' -o -name 'sessions-index.json' \\) $NEWER 2>/dev/null || true)

if [ -z "$FILELIST" ]; then
  echo "{\\\"files\\\":0,\\\"bytes\\\":0,\\\"delta\\\":$DELTA}"
  # Still touch marker so next run is delta
  touch "$MARKER"
  exit 0
fi

# Create tar from the file list
echo "$FILELIST" | tar czf /root/artifacts/claude-sessions.tar.gz -T - 2>/dev/null || true

# Update marker for next delta
touch "$MARKER"

FILE_COUNT=$(echo "$FILELIST" | wc -l)
TAR_SIZE=$(stat -c%s /root/artifacts/claude-sessions.tar.gz 2>/dev/null || echo 0)
echo "{\\\"files\\\":$FILE_COUNT,\\\"bytes\\\":$TAR_SIZE,\\\"delta\\\":$DELTA}"

# List files for manifest
echo "---"
echo "$FILELIST"
`;
}

/**
 * Execute a command on a service and poll for result with artifacts.
 */
async function execOnService(
  publicKey: string,
  secretKey: string,
  serviceId: string,
  command: string,
  timeoutMs = 60000,
): Promise<{ ok: boolean; result?: any; error?: string }> {
  const execPath = `/services/${serviceId}/execute`;
  const execPayload = JSON.stringify({ command, timeout: timeoutMs });
  const headers = authHeaders(publicKey, secretKey, 'POST', execPath, execPayload);

  let jobId: string;
  try {
    const res = await fetch(`${API_BASE}${execPath}`, {
      method: 'POST', headers, body: execPayload,
      signal: AbortSignal.timeout(15000),
    });
    const data = await res.json();
    if (!res.ok) return { ok: false, error: data.error || `HTTP ${res.status}` };
    jobId = data.job_id;
    if (!jobId) return { ok: false, error: 'No job_id returned' };
  } catch (err) {
    return { ok: false, error: `Execute failed: ${err}` };
  }

  // Poll for completion (max ~60s)
  const pollPath = `/jobs/${jobId}`;
  for (let i = 0; i < 30; i++) {
    await new Promise((r) => setTimeout(r, 2000));
    const h = authHeaders(publicKey, secretKey, 'GET', pollPath);
    try {
      const res = await fetch(`${API_BASE}${pollPath}`, { headers: h, signal: AbortSignal.timeout(10000) });
      const data = await res.json();
      if (data.status === 'completed' || data.status === 'failed' || data.status === 'cancelled') {
        return { ok: true, result: data };
      }
    } catch { /* retry */ }
  }

  return { ok: false, error: `Job ${jobId} timed out` };
}

/**
 * Extract a tar artifact into the local claude projects directory.
 */
async function extractArtifact(serviceId: string, tarB64: string): Promise<{ files: number; bytes: number }> {
  const tarBuffer = Buffer.from(tarB64, 'base64');
  const destDir = path.join(homedir(), '.claude', 'projects');
  const tmpTar = path.join(homedir(), '.unfirehose', `unsandbox-sync-${serviceId}.tar.gz`);

  await mkdir(path.dirname(tmpTar), { recursive: true });
  await mkdir(destDir, { recursive: true });
  await writeFile(tmpTar, tarBuffer, { mode: 0o600 });

  // Extract — tar preserves the projects/ structure
  execSync(`tar xzf "${tmpTar}" -C "${destDir}" --strip-components=1 2>/dev/null || true`, {
    timeout: 30000,
  });

  // Cleanup — zero then remove
  await writeFile(tmpTar, '', { mode: 0o600 });
  await unlink(tmpTar).catch(() => {});

  return { files: 0, bytes: tarBuffer.length };
}

/**
 * POST /api/unsandbox/sync
 *
 * Body: { serviceId: string } — sync one service
 * Body: { all: true }         — sync all running services
 *
 * Delta-aware: container tracks last sync via marker file.
 * Only modified files since last sync are transferred.
 */
export async function POST(request: NextRequest) {
  const publicKey = getSetting('unsandbox_public_key');
  const secretKey = getSetting('unsandbox_secret_key');
  if (!publicKey || !secretKey) {
    return NextResponse.json({ error: 'No unsandbox keys configured' }, { status: 400 });
  }

  const body = await request.json();

  // Determine which services to sync
  let serviceIds: string[] = [];

  if (body.serviceId) {
    serviceIds = [body.serviceId];
  } else if (body.all) {
    // Fetch all running services
    try {
      const svcPath = '/services';
      const h = authHeaders(publicKey, secretKey, 'GET', svcPath);
      const res = await fetch(`${API_BASE}${svcPath}`, { headers: h, signal: AbortSignal.timeout(10000) });
      const data = await res.json();
      serviceIds = (data.services ?? data ?? [])
        .filter((svc: any) => svc.status === 'running')
        .map((svc: any) => svc.id);
    } catch (err) {
      return NextResponse.json({ error: `Failed to list services: ${err}` }, { status: 500 });
    }
  }

  if (!serviceIds.length) {
    return NextResponse.json({ error: 'No serviceId provided and no running services found' }, { status: 400 });
  }

  const results: any[] = [];
  const syncScript = buildSyncScript();

  for (const svcId of serviceIds) {
    const t0 = Date.now();
    const { ok, result, error } = await execOnService(publicKey, secretKey, svcId, syncScript);

    if (!ok || !result) {
      results.push({ serviceId: svcId, ok: false, error: error ?? 'No result' });
      continue;
    }

    if (result.exit_code !== 0) {
      results.push({
        serviceId: svcId, ok: false,
        error: 'Script failed',
        stderr: result.stderr?.slice(0, 1000),
      });
      continue;
    }

    // Parse the JSON summary from stdout (first line)
    let summary: any = {};
    try {
      const firstLine = (result.stdout ?? '').split('\n')[0];
      summary = JSON.parse(firstLine);
    } catch { /* not parseable */ }

    // Extract artifact if present
    const artifacts: any[] = result.artifacts ?? [];
    const tarArtifact = artifacts.find((a: any) =>
      a.filename === 'claude-sessions.tar.gz' || artifacts.length === 1
    );

    if (tarArtifact?.data) {
      try {
        const extracted = await extractArtifact(svcId, tarArtifact.data);
        const now = new Date().toISOString();
        setSetting(`unsandbox_last_sync_${svcId}`, now);
        results.push({
          serviceId: svcId, ok: true,
          delta: summary.delta ?? false,
          filesOnContainer: summary.files ?? 0,
          artifactBytes: extracted.bytes,
          elapsed: Date.now() - t0,
          syncedAt: now,
        });
      } catch (err) {
        results.push({ serviceId: svcId, ok: false, error: `Extract failed: ${err}` });
      }
    } else {
      // No artifact — either no files or no changes since last sync
      const now = new Date().toISOString();
      setSetting(`unsandbox_last_sync_${svcId}`, now);
      results.push({
        serviceId: svcId, ok: true,
        delta: summary.delta ?? false,
        filesOnContainer: summary.files ?? 0,
        artifactBytes: 0,
        elapsed: Date.now() - t0,
        syncedAt: now,
        note: 'No new data since last sync',
      });
    }
  }

  return NextResponse.json({ results });
}

/**
 * GET /api/unsandbox/sync — list services with sync status
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
      lastSync: getSetting(`unsandbox_last_sync_${svc.id}`) ?? null,
    }));
    return NextResponse.json({ services });
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 500 });
  }
}
