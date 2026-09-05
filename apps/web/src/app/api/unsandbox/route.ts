import { NextRequest, NextResponse } from 'next/server';
import { createHash } from 'crypto';
import { readFile, stat } from 'fs/promises';
import path from 'path';
import { homedir } from 'os';
import { getSetting } from '@unturf/unfirehose/db/ingest';
import { authHeaders } from '@/lib/unsandbox-auth';

// Auth pattern matches official un.ts CLI: https://unsandbox.com/cli/typescript
const API_BASE = 'https://api.unsandbox.com';



// Turn opaque server errors into a hint the user can act on. Both HTTP 401
// and `:invalid_signature` mean "server rejected the HMAC" — almost always
// a stale/rotated secret rather than a code defect.
function humanizeAuthError(raw: string): string {
  const s = raw.toLowerCase();
  if (s.includes('invalid_signature') || s.includes('http 401')) {
    return `${raw} — likely stale secret key. Rotate or re-paste in Settings.`;
  }
  if (s.includes('invalid_timestamp') || s.includes('timestamp')) {
    return `${raw} — server clock skew. Check system time.`;
  }
  return raw;
}

// Helper: authenticated GET to unsandbox API
async function apiGet(publicKey: string, secretKey: string, apiPath: string, timeout = 10000) {
  const headers = authHeaders(publicKey, secretKey, 'GET', apiPath);
  const res = await fetch(`${API_BASE}${apiPath}`, { headers, signal: AbortSignal.timeout(timeout) });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`API error: ${res.status} ${text}`);
  }
  return res.json();
}

// Helper: authenticated DELETE to unsandbox API
async function apiDelete(publicKey: string, secretKey: string, apiPath: string, timeout = 10000) {
  const headers = authHeaders(publicKey, secretKey, 'DELETE', apiPath);
  const res = await fetch(`${API_BASE}${apiPath}`, { method: 'DELETE', headers, signal: AbortSignal.timeout(timeout) });
  const text = await res.text();
  if (!res.ok) throw new Error(`API error: ${res.status} ${text}`);
  try { return JSON.parse(text); } catch { return { ok: true }; }
}

// Helper: authenticated POST to unsandbox API
async function apiPost(publicKey: string, secretKey: string, apiPath: string, payload: string, timeout = 30000) {
  const headers = authHeaders(publicKey, secretKey, 'POST', apiPath, payload);
  const res = await fetch(`${API_BASE}${apiPath}`, { method: 'POST', headers, body: payload, signal: AbortSignal.timeout(timeout) });
  const text = await res.text();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let data: any;
  try { data = JSON.parse(text); } catch { data = { raw: text }; }
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}: ${text}`);
  return data;
}

// GET — check key status, list sessions, list services
export async function GET(request: NextRequest) {
  const publicKey = getSetting('unsandbox_public_key');
  const secretKey = getSetting('unsandbox_secret_key');

  if (!publicKey || !secretKey) {
    return NextResponse.json({ connected: false, error: 'No unsandbox keys configured' });
  }

  const action = request.nextUrl.searchParams.get('action');

  // List active sessions
  if (action === 'sessions') {
    try {
      const data = await apiGet(publicKey, secretKey, '/sessions');
      return NextResponse.json({ sessions: data.sessions ?? data });
    } catch (err) {
      return NextResponse.json({ sessions: [], error: String(err) });
    }
  }

  // List services
  if (action === 'services') {
    try {
      const data = await apiGet(publicKey, secretKey, '/services');
      return NextResponse.json({ services: data.services ?? data });
    } catch (err) {
      return NextResponse.json({ services: [], error: String(err) });
    }
  }

  // Default: key status — use POST /keys/validate for full response
  try {
    const data = await apiPost(publicKey, secretKey, '/keys/validate', '{}');
    return NextResponse.json({
      connected: true,
      tier: data.tier,
      rateLimit: data.rate_limit ?? data.rate_per_minute,
      maxSessions: data.concurrency ?? data.max_sessions,
      expiresAt: data.expires_at,
      expiresAtHuman: data.valid_for_human ?? data.time_remaining,
      burst: data.burst,
    });
  } catch (err) {
    return NextResponse.json({ connected: false, error: humanizeAuthError(String(err)) });
  }
}

// POST — execute code or create session
/**
 * One action, given the keys and the request body.
 *
 * The keys are read once by POST and handed down, so no handler reaches for
 * settings on its own and none can forget the check that they exist.
 */
interface ActionContext {
  publicKey: string;
  secretKey: string;
  body: any;
}

type Action = (ctx: ActionContext) => Promise<NextResponse>;

const test: Action = async ({ publicKey, secretKey, body }) => {
  // Quick connectivity test — GET /keys/self
  try {
    const path = '/keys/self';
    const headers = authHeaders(publicKey, secretKey, 'GET', path);
    const res = await fetch(`${API_BASE}${path}`, { headers, signal: AbortSignal.timeout(10000) });
    if (!res.ok) {
      return NextResponse.json({ ok: false, error: humanizeAuthError(`HTTP ${res.status}`) });
    }
    const data = await res.json();
    return NextResponse.json({ ok: true, tier: data.tier });
  } catch (err) {
    return NextResponse.json({ ok: false, error: humanizeAuthError(String(err)) });
  }
};

const probe: Action = async ({ publicKey, secretKey, body }) => {
  // Run a system probe on unsandbox to get CPU, memory, GPU, etc.
  const probeScript = `#!/bin/bash
echo "---JSON---"
CORES=$(nproc 2>/dev/null || echo 1)
HOST_THREADS=$(grep -c '^processor' /proc/cpuinfo 2>/dev/null || echo "$CORES")
CPU_MODEL=$(grep -m1 'model name' /proc/cpuinfo 2>/dev/null | cut -d: -f2 | xargs || echo "unknown")
MEM_TOTAL=$(awk '/MemTotal/ {printf "%.2f", $2/1048576}' /proc/meminfo 2>/dev/null || echo 0)
MEM_AVAIL=$(awk '/MemAvailable/ {printf "%.2f", $2/1048576}' /proc/meminfo 2>/dev/null || echo 0)
MEM_USED=$(echo "$MEM_TOTAL $MEM_AVAIL" | awk '{printf "%.2f", $1-$2}')
SWAP_TOTAL=$(awk '/SwapTotal/ {printf "%.2f", $2/1048576}' /proc/meminfo 2>/dev/null || echo 0)
SWAP_FREE=$(awk '/SwapFree/ {printf "%.2f", $2/1048576}' /proc/meminfo 2>/dev/null || echo 0)
SWAP_USED=$(echo "$SWAP_TOTAL $SWAP_FREE" | awk '{printf "%.2f", $1-$2}')
# /proc/loadavg in LXC shows hypervisor load — normalize to guest vCPU share
RAW_LOAD=$(awk '{print $1, $2, $3}' /proc/loadavg 2>/dev/null || echo "0 0 0")
LOAD1=$(echo "$RAW_LOAD $CORES $HOST_THREADS" | awk '{h=$5>0?$5:1; printf "%.2f", $1*($4/h)}')
LOAD5=$(echo "$RAW_LOAD $CORES $HOST_THREADS" | awk '{h=$5>0?$5:1; printf "%.2f", $2*($4/h)}')
LOAD15=$(echo "$RAW_LOAD $CORES $HOST_THREADS" | awk '{h=$5>0?$5:1; printf "%.2f", $3*($4/h)}')
UPTIME=$(uptime -p 2>/dev/null | sed 's/^up //' || echo "unknown")
GPU_MODEL=""
GPU_MEM_MB=0
GPU_POWER_W=0
if command -v nvidia-smi &>/dev/null; then
GPU_MODEL=$(nvidia-smi --query-gpu=name --format=csv,noheader 2>/dev/null | head -1 || echo "")
GPU_MEM_MB=$(nvidia-smi --query-gpu=memory.total --format=csv,noheader,nounits 2>/dev/null | head -1 || echo 0)
GPU_POWER_W=$(nvidia-smi --query-gpu=power.draw --format=csv,noheader,nounits 2>/dev/null | head -1 || echo 0)
fi
cat <<ENDJSON
{
"cpuCores": $CORES,
"hostThreads": $HOST_THREADS,
"cpuModel": "$CPU_MODEL",
"memTotalGB": $MEM_TOTAL,
"memUsedGB": $MEM_USED,
"memAvailableGB": $MEM_AVAIL,
"swapTotalGB": $SWAP_TOTAL,
"swapUsedGB": $SWAP_USED,
"loadAvg": [$LOAD1, $LOAD5, $LOAD15],
"uptime": "$UPTIME",
"gpuModel": "$GPU_MODEL",
"gpuMemTotalMB": $GPU_MEM_MB,
"gpuPowerWatts": $GPU_POWER_W
}
ENDJSON`;
  const path = '/execute';
  const payload = JSON.stringify({
    language: 'bash',
    code: probeScript,
    network_mode: 'zerotrust',
  });
  try {
    const data = await apiPost(publicKey, secretKey, path, payload, 30000);
    // Parse the JSON from stdout
    const stdout: string = data.stdout || data.output || '';
    const jsonMatch = stdout.match(/---JSON---\s*([\s\S]*)/);
    if (jsonMatch) {
      try {
        const probe = JSON.parse(jsonMatch[1].trim());
        return NextResponse.json({ probe, raw: data });
      } catch {
        return NextResponse.json({ error: 'Failed to parse probe output', raw: stdout });
      }
    }
    return NextResponse.json({ error: 'No probe data in output', raw: stdout });
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 500 });
  }
};

const execute: Action = async ({ publicKey, secretKey, body }) => {
  // Run code on unsandbox
  const { language, code, network } = body;
  const path = '/execute';
  const payload = JSON.stringify({
    language: language || 'bash',
    code,
    network_mode: network || 'semitrusted',
  });
  const headers = authHeaders(publicKey, secretKey, 'POST', path, payload);
  try {
    const res = await fetch(`${API_BASE}${path}`, {
      method: 'POST',
      headers,
      body: payload,
      signal: AbortSignal.timeout(120000),
    });
    const data = await res.json();
    return NextResponse.json(data);
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 500 });
  }
};

const session: Action = async ({ publicKey, secretKey, body }) => {
  // Create an interactive session for agent harness
  const { image, network } = body;
  const path = '/sessions';
  const payload = JSON.stringify({
    image: image || 'ubuntu:24.04',
    network_mode: network || 'semitrusted',
  });
  const headers = authHeaders(publicKey, secretKey, 'POST', path, payload);
  try {
    const res = await fetch(`${API_BASE}${path}`, {
      method: 'POST',
      headers,
      body: payload,
      signal: AbortSignal.timeout(30000),
    });
    const data = await res.json();
    if (!res.ok) {
      return NextResponse.json({ error: data.error || `HTTP ${res.status}` }, { status: res.status });
    }
    return NextResponse.json(data);
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 500 });
  }
};

const killSession: Action = async ({ publicKey, secretKey, body }) => {
  const { sessionId } = body;
  if (!sessionId) return NextResponse.json({ error: 'Missing sessionId' }, { status: 400 });
  try {
    await apiDelete(publicKey, secretKey, `/sessions/${sessionId}`);
    return NextResponse.json({ ok: true });
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 500 });
  }
};

const createService: Action = async ({ publicKey, secretKey, body }) => {
  const { ports, bootstrap, network } = body;
  // Derive a stable per-user suffix via SHA-256 of the public key — consistent,
  // non-reversible, and safe to expose in a global namespace.
  const pkSuffix = createHash('sha256').update(publicKey).digest('hex').slice(0, 8);
  // Always a name: an unnamed service still needs one, because this
  // namespace is shared with every other key. The guard that used to
  // follow could not fire.
  const name = body.name
    ? `${body.name}-${pkSuffix}`
    : `service-${pkSuffix}`;
  try {
    // Inject Claude auth credentials into bootstrap script if present
    let finalBootstrap = bootstrap;
    if (finalBootstrap) {
      const credLines = await buildCredentialLines();
      if (credLines) {
        // Insert after shebang + set -e, before the rest
        const lines = finalBootstrap.split('\n');
        const insertIdx = lines.findIndex((l: string) => l.startsWith('set -e'));
        if (insertIdx >= 0) {
          lines.splice(insertIdx + 1, 0, credLines);
        } else {
          lines.splice(1, 0, credLines);
        }
        finalBootstrap = lines.join('\n');
      }
    }

    // Ports must be an array of integers (matching SDK format)
    const portsArray = (ports || '80').toString().split(',').map((p: string) => parseInt(p.trim())).filter((p: number) => !isNaN(p));
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const svcPayload: any = { name, ports: portsArray };
    if (finalBootstrap) svcPayload.bootstrap = finalBootstrap;
    if (network) svcPayload.network = network;
    const payload = JSON.stringify(svcPayload);
    const data = await apiPost(publicKey, secretKey, '/services', payload);
    return NextResponse.json({ ...data, resolvedName: name });
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 500 });
  }
};

const destroyService: Action = async ({ publicKey, secretKey, body }) => {
  const { serviceId } = body;
  if (!serviceId) return NextResponse.json({ error: 'Missing serviceId' }, { status: 400 });
  try {
    await apiDelete(publicKey, secretKey, `/services/${serviceId}`);
    return NextResponse.json({ ok: true });
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 500 });
  }
};

const serviceInfo: Action = async ({ publicKey, secretKey, body }) => {
  const { serviceId } = body;
  if (!serviceId) return NextResponse.json({ error: 'Missing serviceId' }, { status: 400 });
  try {
    const data = await apiGet(publicKey, secretKey, `/services/${serviceId}`, 15000);
    return NextResponse.json(data);
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 500 });
  }
};

const serviceLogs: Action = async ({ publicKey, secretKey, body }) => {
  const { serviceId } = body;
  if (!serviceId) return NextResponse.json({ error: 'Missing serviceId' }, { status: 400 });
  try {
    const data = await apiGet(publicKey, secretKey, `/services/${serviceId}/logs`, 30000);
    return NextResponse.json(data);
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 500 });
  }
};

const serviceWake: Action = async ({ publicKey, secretKey, body }) => {
  const { serviceId } = body;
  if (!serviceId) return NextResponse.json({ error: 'Missing serviceId' }, { status: 400 });
  try {
    const data = await apiPost(publicKey, secretKey, `/services/${serviceId}/wake`, '{}', 30000);
    return NextResponse.json(data);
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 500 });
  }
};

const serviceRedeploy: Action = async ({ publicKey, secretKey, body }) => {
  const { serviceId } = body;
  if (!serviceId) return NextResponse.json({ error: 'Missing serviceId' }, { status: 400 });
  try {
    const data = await apiPost(publicKey, secretKey, `/services/${serviceId}/redeploy`, '{}', 60000);
    return NextResponse.json(data);
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 500 });
  }
};

const sessionExec: Action = async ({ publicKey, secretKey, body }) => {
  // Execute a command inside an existing session
  const { sessionId, command } = body;
  if (!sessionId || !command) return NextResponse.json({ error: 'Missing sessionId or command' }, { status: 400 });
  try {
    const execPath = `/sessions/${sessionId}/execute`;
    const execPayload = JSON.stringify({ command });
    const data = await apiPost(publicKey, secretKey, execPath, execPayload, 30000);
    return NextResponse.json(data);
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 500 });
  }
};

/**
 * Every action this proxy forwards, by name.
 *
 * These were twelve `if (action === ...)` blocks in one 268-line
 * function, which is how a dispatcher reaches 54 branches: the shape of
 * the dispatch and the work of every action shared a scope, so reading
 * any one of them meant scrolling past the other eleven.
 */
const ACTIONS: Record<string, Action> = {
  'test': test,
  'probe': probe,
  'execute': execute,
  'session': session,
  'kill-session': killSession,
  'create-service': createService,
  'destroy-service': destroyService,
  'service-info': serviceInfo,
  'service-logs': serviceLogs,
  'service-wake': serviceWake,
  'service-redeploy': serviceRedeploy,
  'session-exec': sessionExec,
};

export async function POST(request: NextRequest) {
  const publicKey = getSetting('unsandbox_public_key');
  const secretKey = getSetting('unsandbox_secret_key');

  if (!publicKey || !secretKey) {
    return NextResponse.json({ error: 'No unsandbox keys configured' }, { status: 400 });
  }

  const body = await request.json();
  const handler = ACTIONS[body.action];
  if (!handler) {
    return NextResponse.json({ error: 'Unknown action' }, { status: 400 });
  }

  return handler({ publicKey, secretKey, body });
}

// Build shell lines that inject Claude auth credentials into a container
async function buildCredentialLines(): Promise<string | null> {
  const credFile = path.join(homedir(), '.claude', '.credentials.json');
  const settingsFile = path.join(homedir(), '.claude', 'settings.json');
  const settingsLocalFile = path.join(homedir(), '.claude', 'settings.local.json');

  try {
    await stat(credFile);
  } catch {
    return null; // no local credentials
  }

  const lines: string[] = [
    '# Sync Claude auth credentials',
    'umask 077 && mkdir -p ~/.claude',
  ];

  const credData = await readFile(credFile);
  lines.push(`echo '${credData.toString('base64')}' | base64 -d > ~/.claude/.credentials.json`);
  lines.push('chmod 600 ~/.claude/.credentials.json');

  for (const f of [settingsFile, settingsLocalFile]) {
    try {
      const data = await readFile(f);
      lines.push(`echo '${data.toString('base64')}' | base64 -d > ~/.claude/${path.basename(f)}`);
    } catch { /* skip missing */ }
  }

  lines.push('chmod 700 ~/.claude');
  return lines.join('\n');
}
