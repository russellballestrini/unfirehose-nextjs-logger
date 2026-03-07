import { NextRequest, NextResponse } from 'next/server';
import { createHmac } from 'crypto';
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
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`API error: ${res.status} ${text}`);
  }
  return res.json();
}

// Helper: authenticated POST to unsandbox API
async function apiPost(publicKey: string, secretKey: string, apiPath: string, payload: string, timeout = 30000) {
  const headers = authHeaders(publicKey, secretKey, 'POST', apiPath, payload);
  const res = await fetch(`${API_BASE}${apiPath}`, { method: 'POST', headers, body: payload, signal: AbortSignal.timeout(timeout) });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
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

  // Default: key status
  try {
    const data = await apiGet(publicKey, secretKey, '/keys/self');
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

  if (action === 'execute') {
    // Run code on unsandbox
    const { language, code, network } = body;
    const path = '/execute';
    const payload = JSON.stringify({
      language: language || 'bash',
      code,
      network: network || 'semitrusted',
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
      network: network || 'semitrusted',
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

    // 1. Create session
    const sessionPath = '/sessions';
    const sessionPayload = JSON.stringify({
      image: 'ubuntu:24.04',
      network: network || 'semitrusted',
    });
    const sessionHeaders = authHeaders(publicKey, secretKey, 'POST', sessionPath, sessionPayload);
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

    // 2. Bootstrap harness in session
    const setupScript = [
      '#!/bin/bash',
      'set -e',
      // Install node if not present
      'which node || (curl -fsSL https://deb.nodesource.com/setup_lts.x | bash - && apt-get install -y nodejs)',
      // Install harness
      harnessCmd === 'claude' ? 'npm install -g @anthropic-ai/claude-code' : `echo "Custom harness: ${harnessCmd}"`,
      // Clone project if repo provided
      projectRepo ? `git clone '${projectRepo}' /workspace && cd /workspace` : 'mkdir -p /workspace && cd /workspace',
      // Run harness
      harnessCmd === 'claude'
        ? `cd /workspace && claude --dangerously-skip-permissions${prompt ? ` '${prompt.replace(/'/g, "'\\''")}'` : ''}`
        : `cd /workspace && ${harnessCmd}`,
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
    const { name, ports, bootstrap, network } = body;
    if (!name) return NextResponse.json({ error: 'Missing service name' }, { status: 400 });
    try {
      const payload = JSON.stringify({
        name,
        ports: ports || '80',
        bootstrap: bootstrap || undefined,
        network: network || 'semitrusted',
      });
      const data = await apiPost(publicKey, secretKey, '/services', payload);
      return NextResponse.json(data);
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

  return NextResponse.json({ error: 'Unknown action' }, { status: 400 });
}
