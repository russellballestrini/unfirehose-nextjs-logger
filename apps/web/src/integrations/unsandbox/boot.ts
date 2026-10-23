import { NextResponse } from 'next/server';
import { readFile } from 'fs/promises';
import path from 'path';
import { homedir } from 'os';
import { getSetting } from '@unturf/unfirehose/db/ingest';
import { getDb } from '@unturf/unfirehose/db/schema';
import { authHeaders, UNSANDBOX_API_BASE } from './auth';
import type { BootContext } from '../server';

/**
 * Booting a harness in an unsandbox container: `POST /api/boot` with
 * `host: "unsandbox"` lands here through `integrations/server.ts`.
 *
 * What the boot route shares with us arrives as `ctx` rather than as an
 * import, so this directory depends on nothing in `app/` and can be deleted
 * whole.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function bootUnsandbox(body: any, projectPath: string, passedRepoUrl: string | undefined, ctx: BootContext) {
  const publicKey = getSetting('unsandbox_public_key');
  const secretKey = getSetting('unsandbox_secret_key');
  if (!publicKey || !secretKey) {
    return NextResponse.json({ error: 'No unsandbox API keys configured', detail: 'Add keys in Permacomputer settings.' }, { status: 400 });
  }

  const { prompt, yolo, harness: harnessName, projectName } = body;

  // Get the git remote URL — prefer passed URL, fall back to local project
  let repoUrl: string | null = passedRepoUrl || null;
  if (!repoUrl) {
    try {
      repoUrl = await ctx.localGitRemote(projectPath);
    } catch { /* no git remote */ }
  }

  // 1. Create a session on unsandbox
  const sessionPath = '/sessions';
  const sessionPayload = JSON.stringify({
    image: 'ubuntu:24.04',
    network_mode: 'semitrusted',
  });
  const sessionHeaders = authHeaders(publicKey, secretKey, 'POST', sessionPath, sessionPayload);

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let session: any;
  try {
    const res = await fetch(`${UNSANDBOX_API_BASE}${sessionPath}`, {
      method: 'POST', headers: sessionHeaders, body: sessionPayload,
      signal: AbortSignal.timeout(30000),
    });
    session = await res.json();
    if (!res.ok) {
      return NextResponse.json({ error: session.error || 'Failed to create unsandbox session' }, { status: 500 });
    }
  } catch (err) {
    return NextResponse.json({ error: `Unsandbox session creation failed: ${err}` }, { status: 500 });
  }

  const sessionId = session.session_id || session.id;

  // 2. Bootstrap the session: install tools, clone repo, run harness
  const repoName = path.basename(projectPath);
  const workDir = `/workspace/${repoName}`;
  const resolvedHarness = harnessName || 'claude';

  const setupParts = [
    '#!/bin/bash',
    'set -e',
    // Golden image has batteries included — no apt-get needed
  ];

  // Sync Claude auth credentials into the container
  // Read local credential files, base64 encode, decode inside container
  const credFile = path.join(homedir(), '.claude', '.credentials.json');
  const settingsFile = path.join(homedir(), '.claude', 'settings.json');
  const settingsLocalFile = path.join(homedir(), '.claude', 'settings.local.json');

  try {
    const credData = await readFile(credFile);
    const credB64 = credData.toString('base64');
    setupParts.push(
      'umask 077 && mkdir -p ~/.claude',
      `echo '${credB64}' | base64 -d > ~/.claude/.credentials.json`,
      'chmod 600 ~/.claude/.credentials.json',
    );

    // Settings files — non-fatal
    for (const f of [settingsFile, settingsLocalFile]) {
      try {
        const data = await readFile(f);
        const b64 = data.toString('base64');
        const basename = path.basename(f);
        setupParts.push(`echo '${b64}' | base64 -d > ~/.claude/${basename}`);
      } catch { /* file doesn't exist, skip */ }
    }

    setupParts.push('chmod 700 ~/.claude');
  } catch {
    // No local credentials — claude will need to auth interactively
  }

  // Clone repo if we have a URL
  if (repoUrl) {
    setupParts.push(`git clone '${repoUrl}' '${workDir}' 2>&1 || (mkdir -p '${workDir}')`);
  } else {
    setupParts.push(`mkdir -p '${workDir}'`);
  }

  setupParts.push(`cd '${workDir}'`);

  // Golden image provides claude — just ensure PATH includes ~/.local/bin
  setupParts.push(
    'export PATH="$HOME/.local/bin:$PATH"',
    'grep -q ".local/bin" ~/.bashrc 2>/dev/null || echo \'export PATH="$HOME/.local/bin:$PATH"\' >> ~/.bashrc',
  );

  // Session sync: death trap + periodic background sync to /root/artifacts/
  // Files in /root/artifacts/ are downloadable via unsandbox artifact API
  setupParts.push(
    '# --- session artifact sync ---',
    'sync_sessions() {',
    '  mkdir -p /root/artifacts',
    '  cd "$HOME/.claude" 2>/dev/null || return 0',
    '  MARKER="$HOME/.claude/.last_sync"',
    '  if [ -f "$MARKER" ]; then NEWER="-newer $MARKER"; else NEWER=""; fi',
    '  FILES=$(find projects/ \\( -name "*.jsonl" -o -name "sessions-index.json" \\) $NEWER 2>/dev/null || true)',
    '  if [ -n "$FILES" ]; then',
    '    echo "$FILES" | tar czf /root/artifacts/claude-sessions.tar.gz -T - 2>/dev/null || true',
    '  fi',
    '  touch "$MARKER"',
    '}',
    '# Death trap — sync before container dies',
    'trap "sync_sessions; exit" SIGTERM SIGINT SIGHUP',
    '# Background periodic sync every 3 minutes',
    '(while true; do sleep 180; sync_sessions; done) &',
  );

  // Build the harness command
  let harnessCmd = resolvedHarness === 'claude' ? 'claude' : resolvedHarness;
  if (resolvedHarness === 'claude') {
    if (yolo) harnessCmd += ' --dangerously-skip-permissions';
    if (yolo) {
      const escaped = ctx.agentSystemPrompt.replace(/'/g, "'\\''");
      harnessCmd += ` --append-system-prompt '${escaped}'`;
    }
    if (prompt) {
      const escaped = prompt.replace(/'/g, "'\\''");
      harnessCmd += ` '${escaped}'`;
    }
  }

  setupParts.push(harnessCmd);

  const setupScript = setupParts.join('\n');
  const execPath = `/sessions/${sessionId}/execute`;
  const execPayload = JSON.stringify({ command: setupScript });
  const execHeaders = authHeaders(publicKey, secretKey, 'POST', execPath, execPayload);

  try {
    // Fire and forget — the session runs in background, we don't wait for claude to finish
    fetch(`${UNSANDBOX_API_BASE}${execPath}`, {
      method: 'POST', headers: execHeaders, body: execPayload,
      signal: AbortSignal.timeout(300000),
    }).catch(() => {});

    // Register deployment
    if (projectName) {
      try {
        const db = getDb();
        const proj = db.prepare('SELECT id FROM projects WHERE name = ?').get(projectName) as { id: number } | undefined;
        if (proj) {
          db.prepare(`
            INSERT INTO agent_deployments (tmux_session, tmux_window, project_id, todo_ids, status, started_at)
            VALUES (?, ?, ?, ?, 'running', datetime('now'))
          `).run(`unsandbox-${sessionId}`, 'main', proj.id, JSON.stringify(body.todoIds ?? []));
        }
      } catch { /* non-fatal */ }
    }

    return NextResponse.json({
      success: true,
      tmuxSession: `unsandbox-${sessionId}`,
      tmuxWindow: 'main',
      multiplexer: 'unsandbox',
      host: 'unsandbox',
      sessionId,
      command: `unsandbox session ${sessionId}`,
    });
  } catch (err) {
    return NextResponse.json({ error: `Unsandbox harness boot failed: ${err}` }, { status: 500 });
  }
}
