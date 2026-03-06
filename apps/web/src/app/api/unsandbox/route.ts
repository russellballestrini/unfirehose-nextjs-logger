import { NextRequest, NextResponse } from 'next/server';
import { createHmac } from 'crypto';
import { getSetting } from '@unfirehose/core/db/ingest';

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

// GET — check key status
export async function GET() {
  const publicKey = getSetting('unsandbox_public_key');
  const secretKey = getSetting('unsandbox_secret_key');

  if (!publicKey || !secretKey) {
    return NextResponse.json({ connected: false, error: 'No unsandbox keys configured' });
  }

  try {
    const path = '/keys/self';
    const headers = authHeaders(publicKey, secretKey, 'GET', path);
    const res = await fetch(`${API_BASE}${path}`, { headers, signal: AbortSignal.timeout(10000) });

    if (!res.ok) {
      const text = await res.text();
      return NextResponse.json({ connected: false, error: `API error: ${res.status} ${text}` });
    }

    const data = await res.json();
    return NextResponse.json({
      connected: true,
      tier: data.tier,
      rateLimit: data.rate_limit,
      maxSessions: data.max_sessions,
      expiresAt: data.expires_at,
      network: data.network_mode,
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

  return NextResponse.json({ error: 'Unknown action' }, { status: 400 });
}
