import { NextRequest, NextResponse } from 'next/server';
import { createHmac, createHash } from 'crypto';
import { readFileSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';
import { getSetting } from '@unturf/unfirehose/db/ingest';

// Auth pattern matches official un.ts CLI: https://unsandbox.com/cli/typescript
const API_BASE = 'https://api.unsandbox.com';

function sign(secretKey: string, method: string, path: string, body: string): { timestamp: string; signature: string } {
  const timestamp = Math.floor(Date.now() / 1000).toString();
  const message = `${timestamp}:${method}:${path}:${body}`;
  const signature = createHmac('sha256', secretKey).update(message).digest('hex');
  return { timestamp, signature };
}

function authHeaders(publicKey: string, secretKey: string, method: string, path: string, body: string = ''): Record<string, string> {
  const { timestamp, signature } = sign(secretKey, method, path, body);
  return {
    'Authorization': `Bearer ${publicKey}`,
    'X-Timestamp': timestamp,
    'X-Signature': signature,
    'Content-Type': 'application/json',
  };
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
    return NextResponse.json({ connected: false, error: String(err) });
  }
}

// POST — execute code or create session
export async function POST(request: NextRequest) {
  const publicKey = getSetting('unsandbox_public_key');
  const secretKey = getSetting('unsandbox_secret_key');

  if (!publicKey || !secretKey) {
    return NextResponse.json({ error: 'No unsandbox keys configured' }, { status: 400 });
  }

  const body = await request.json();
  const { action } = body;

  if (action === 'test') {
    // Quick connectivity test — GET /keys/self
    try {
      const path = '/keys/self';
      const headers = authHeaders(publicKey, secretKey, 'GET', path);
      const res = await fetch(`${API_BASE}${path}`, { headers, signal: AbortSignal.timeout(10000) });
      if (!res.ok) {
        return NextResponse.json({ ok: false, error: `HTTP ${res.status}` });
      }
      const data = await res.json();
      return NextResponse.json({ ok: true, tier: data.tier });
    } catch (err) {
      return NextResponse.json({ ok: false, error: String(err) });
    }
  }

  if (action === 'probe') {
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
  }

  if (action === 'execute') {
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
  }

  if (action === 'session') {
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
  }

  if (action === 'boot-harness') {
    // Full bootstrap: create session + install harness + run
    const { harness, projectRepo, prompt, network } = body;
    const harnessCmd = harness || 'claude';

    // Helper: inject a local file into a container path via heredoc base64
    async function injectFile(sessionId: string, localPath: string, containerPath: string): Promise<void> {
      let buf: Buffer;
      try { buf = readFileSync(localPath); } catch { return; } // skip if not found
      const b64 = buf.toString('base64');
      const dir = containerPath.substring(0, containerPath.lastIndexOf('/'));
      // umask 077 ensures file is created 600 — never world-readable even for an instant
      const cmd = `umask 077 && mkdir -p '${dir}' && base64 -d << 'UNSB_CRED_EOF' > '${containerPath}'\n${b64}\nUNSB_CRED_EOF`;
      const execPath = `/sessions/${sessionId}/execute`;
      const execPayload = JSON.stringify({ command: cmd });
      await apiPost(publicKey!, secretKey!, execPath, execPayload, 30000);
    }

    // 1. Create session
    const sessionPath = '/sessions';
    const sessionPayload = JSON.stringify({
      image: 'ubuntu:24.04',
      network_mode: network || 'semitrusted',
    });
    const sessionHeaders = authHeaders(publicKey, secretKey, 'POST', sessionPath, sessionPayload);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let session: any;
    try {
      const res = await fetch(`${API_BASE}${sessionPath}`, {
        method: 'POST',
        headers: sessionHeaders,
        body: sessionPayload,
        signal: AbortSignal.timeout(30000),
      });
      session = await res.json();
      if (!res.ok) {
        return NextResponse.json({ error: session.error || 'Failed to create session' }, { status: 500 });
      }
    } catch (err) {
      return NextResponse.json({ error: `Session creation failed: ${err}` }, { status: 500 });
    }

    // 2. Inject Claude credentials if booting a claude harness
    if (harnessCmd === 'claude') {
      const home = homedir();
      await Promise.all([
        injectFile(session.session_id, join(home, '.claude', '.credentials.json'), '/root/.claude/.credentials.json'),
        injectFile(session.session_id, join(home, '.claude.json'), '/root/.claude.json'),
      ]);
      // Lock down permissions — credentials must not be world-readable
      const lockCmd = `chmod 700 /root/.claude && chmod 600 /root/.claude/.credentials.json /root/.claude.json 2>/dev/null || true`;
      await apiPost(publicKey, secretKey, `/sessions/${session.session_id}/execute`, JSON.stringify({ command: lockCmd }), 10000);
    }

    // 3. Bootstrap harness in session
    const setupScript = [
      '#!/bin/bash',
      // Install system deps
      'export DEBIAN_FRONTEND=noninteractive',
      'apt-get update -qq',
      ...(harnessCmd === 'claude' ? [
        // Install Node.js LTS via nodesource (puts node/npm in /usr/local/bin)
        'apt-get install -y -qq curl ca-certificates git tmux',
        'curl -fsSL https://deb.nodesource.com/setup_lts.x | bash - 2>/dev/null',
        'apt-get install -y -qq nodejs',
        // Install Claude Code globally — ends up in /usr/local/bin, always in PATH
        'npm install -g @anthropic-ai/claude-code 2>&1 | tail -5',
        // Verify install
        'claude --version || echo "WARNING: claude not found in PATH"',
        // Clone project if repo provided
        projectRepo ? `git clone '${projectRepo}' /workspace 2>&1` : 'mkdir -p /workspace',
        // Start claude in a tmux session named "claude" so it persists
        `tmux new-session -d -s claude -x 220 -y 50 'cd /workspace && IS_SANDBOX=1 claude --dangerously-skip-permissions${prompt ? ` '${prompt.replace(/'/g, "'\\''")}'` : ''}' || true`,
        'echo "Bootstrap complete — claude running in tmux session: claude"',
        'echo "Attach with: tmux attach -t claude"',
      ] : [
        'apt-get install -y -qq curl ca-certificates git tmux nodejs npm',
        `echo "Custom harness: ${harnessCmd}"`,
        projectRepo ? `git clone '${projectRepo}' /workspace 2>&1` : 'mkdir -p /workspace',
        `tmux new-session -d -s harness -x 220 -y 50 'cd /workspace && ${harnessCmd}' || true`,
      ]),
    ].join('\n');

    const execPath = `/sessions/${session.session_id}/execute`;
    const execPayload = JSON.stringify({ command: setupScript });
    const execHeaders = authHeaders(publicKey, secretKey, 'POST', execPath, execPayload);
    try {
      const res = await fetch(`${API_BASE}${execPath}`, {
        method: 'POST',
        headers: execHeaders,
        body: execPayload,
        signal: AbortSignal.timeout(300000),
      });
      const execResult = await res.json();
      return NextResponse.json({
        success: true,
        sessionId: session.session_id,
        domain: session.domain,
        harness: harnessCmd,
        execResult,
      });
    } catch (err) {
      return NextResponse.json({
        success: false,
        sessionId: session.session_id,
        error: `Harness bootstrap failed: ${err}`,
      }, { status: 500 });
    }
  }

  if (action === 'kill-session') {
    const { sessionId } = body;
    if (!sessionId) return NextResponse.json({ error: 'Missing sessionId' }, { status: 400 });
    try {
      await apiDelete(publicKey, secretKey, `/sessions/${sessionId}`);
      return NextResponse.json({ ok: true });
    } catch (err) {
      return NextResponse.json({ error: String(err) }, { status: 500 });
    }
  }

  if (action === 'create-service') {
    const { ports, bootstrap, network } = body;
    // Derive a stable per-user suffix via SHA-256 of the public key — consistent,
    // non-reversible, and safe to expose in a global namespace.
    const pkSuffix = createHash('sha256').update(publicKey).digest('hex').slice(0, 8);
    const name = body.name
      ? `${body.name}-${pkSuffix}`
      : `service-${pkSuffix}`;
    if (!name) return NextResponse.json({ error: 'Missing service name' }, { status: 400 });
    try {
      // Ports must be an array of integers (matching SDK format)
      const portsArray = (ports || '80').toString().split(',').map((p: string) => parseInt(p.trim())).filter((p: number) => !isNaN(p));
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const svcPayload: any = { name, ports: portsArray };
      if (bootstrap) svcPayload.bootstrap = bootstrap;
      if (network) svcPayload.network = network;
      const payload = JSON.stringify(svcPayload);
      const data = await apiPost(publicKey, secretKey, '/services', payload);
      return NextResponse.json({ ...data, resolvedName: name });
    } catch (err) {
      return NextResponse.json({ error: String(err) }, { status: 500 });
    }
  }

  if (action === 'destroy-service') {
    const { serviceId } = body;
    if (!serviceId) return NextResponse.json({ error: 'Missing serviceId' }, { status: 400 });
    try {
      await apiDelete(publicKey, secretKey, `/services/${serviceId}`);
      return NextResponse.json({ ok: true });
    } catch (err) {
      return NextResponse.json({ error: String(err) }, { status: 500 });
    }
  }

  if (action === 'service-logs') {
    const { serviceId } = body;
    if (!serviceId) return NextResponse.json({ error: 'Missing serviceId' }, { status: 400 });
    try {
      const data = await apiGet(publicKey, secretKey, `/services/${serviceId}/logs`, 30000);
      return NextResponse.json(data);
    } catch (err) {
      return NextResponse.json({ error: String(err) }, { status: 500 });
    }
  }

  if (action === 'session-exec') {
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
  }

  return NextResponse.json({ error: 'Unknown action' }, { status: 400 });
}
