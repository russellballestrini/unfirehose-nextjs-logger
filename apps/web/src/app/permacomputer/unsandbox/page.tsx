'use client';

import { useState, useCallback } from 'react';
import useSWR from 'swr';
import Link from 'next/link';

/* eslint-disable @typescript-eslint/no-explicit-any */

const fetcher = (url: string) => fetch(url).then(r => r.json());

// Bootstrap script: turns an unsandbox service into a mesh node.
const UNFIREHOSE_BOOTSTRAP = `#!/bin/bash
set -e

# Install Node.js LTS
which node || (curl -fsSL https://deb.nodesource.com/setup_lts.x | bash - && apt-get install -y nodejs)

# Install git
which git || apt-get install -y git

# Clone and build unfirehose
if [ ! -d /opt/unfirehose ]; then
  git clone https://github.com/russellballestrini/unfirehose-nextjs-logger.git /opt/unfirehose
fi
cd /opt/unfirehose
npm install
npm run build --filter=web

# Start the dashboard on port 3000
cd apps/web
PORT=3000 node .next/standalone/server.js
`.trim();

export default function UnsandboxNodePage() {
  const { data: status } = useSWR('/api/unsandbox', fetcher, { refreshInterval: 30000 });
  const { data: services, mutate: mutateServices } = useSWR('/api/unsandbox?action=services', fetcher, { refreshInterval: 10000 });
  const { data: sessions, mutate: mutateSessions } = useSWR('/api/unsandbox?action=sessions', fetcher, { refreshInterval: 10000 });

  const [deploying, setDeploying] = useState(false);
  const [deployResult, setDeployResult] = useState<any>(null);
  const [deployError, setDeployError] = useState<string | null>(null);

  const [cmd, setCmd] = useState('');
  const [cmdResult, setCmdResult] = useState<any>(null);
  const [cmdRunning, setCmdRunning] = useState(false);
  const [network, setNetwork] = useState<'semitrusted' | 'zerotrust'>('semitrusted');

  const [killingSession, setKillingSession] = useState<string | null>(null);

  const serviceList: any[] = services?.services ?? [];
  const sessionList: any[] = sessions?.sessions ?? [];

  const unfirehoseService = serviceList.find((s: any) =>
    (s.name || '').includes('unfirehose') || (s.name || '').includes('firehose')
  );

  const deployUnfirehose = useCallback(async () => {
    setDeploying(true);
    setDeployResult(null);
    setDeployError(null);
    try {
      const res = await fetch('/api/unsandbox', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: 'create-service',
          name: 'unfirehose',
          ports: '3000',
          bootstrap: UNFIREHOSE_BOOTSTRAP,
          network,
        }),
      });
      const data = await res.json();
      if (data.error) setDeployError(data.error);
      else { setDeployResult(data); mutateServices(); }
    } catch (err) {
      setDeployError(String(err));
    } finally {
      setDeploying(false);
    }
  }, [mutateServices, network]);

  const executeCommand = useCallback(async () => {
    if (!cmd.trim()) return;
    setCmdRunning(true);
    setCmdResult(null);
    try {
      const res = await fetch('/api/unsandbox', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'execute', language: 'bash', code: cmd, network }),
      });
      setCmdResult(await res.json());
    } catch (err) {
      setCmdResult({ error: String(err) });
    } finally {
      setCmdRunning(false);
    }
  }, [cmd, network]);

  const killSession = useCallback(async (sessionId: string) => {
    setKillingSession(sessionId);
    try {
      await fetch('/api/unsandbox', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'kill-session', sessionId }),
      });
      mutateSessions();
    } catch { /* ignore */ }
    finally { setKillingSession(null); }
  }, [mutateSessions]);

  const destroyService = useCallback(async (serviceId: string) => {
    if (!confirm(`Destroy service ${serviceId}?`)) return;
    try {
      await fetch('/api/unsandbox', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'destroy-service', serviceId }),
      });
      mutateServices();
    } catch { /* ignore */ }
  }, [mutateServices]);

  if (!status) {
    return (
      <div className="min-h-screen bg-[var(--color-background)] text-[var(--color-foreground)] p-6">
        <div className="text-sm text-[var(--color-muted)]">Loading...</div>
      </div>
    );
  }

  if (!status.connected) {
    return (
      <div className="min-h-screen bg-[var(--color-background)] text-[var(--color-foreground)] p-6 space-y-4">
        <h1 className="text-2xl font-bold">unsandbox.com</h1>
        <div className="text-red-400">
          Not connected. <Link href="/permacomputer" className="text-[var(--color-accent)] hover:underline">Configure API keys</Link>.
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-[var(--color-background)] text-[var(--color-foreground)] p-6 space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-4">
          <Link href="/permacomputer" className="text-[var(--color-muted)] hover:text-[var(--color-foreground)] transition-colors">&larr;</Link>
          <div>
            <h1 className="text-2xl font-bold">unsandbox.com</h1>
            <p className="text-sm text-[var(--color-muted)]">
              Cloud node &middot; tier {status.tier} &middot; {status.rateLimit} rpm &middot; {status.maxSessions} sessions
            </p>
          </div>
        </div>
        <span className="text-green-400 text-sm">● connected</span>
      </div>

      {/* === Primary action: Deploy unfirehose === */}
      {!unfirehoseService ? (
        <div className="bg-[var(--color-surface)] rounded border-2 border-[var(--color-accent)]/40 p-6 space-y-4">
          <div className="space-y-2">
            <h2 className="text-lg font-bold">Add unsandbox as a mesh node</h2>
            <p className="text-sm text-[var(--color-muted)]">
              Deploy unfirehose on unsandbox.com as a persistent service.
              It joins your mesh alongside SSH hosts &mdash; bootstrap harnesses,
              monitor sessions, and track usage like any other node.
            </p>
          </div>
          <div className="flex items-center gap-3">
            <button
              onClick={deployUnfirehose}
              disabled={deploying}
              className="px-6 py-2.5 text-sm font-bold rounded bg-[var(--color-accent)] text-[var(--color-background)] hover:opacity-90 transition-opacity disabled:opacity-50 cursor-pointer"
            >
              {deploying ? 'Deploying...' : 'Deploy unfirehose'}
            </button>
            <span className="text-xs text-[var(--color-muted)]">port 3000 &middot; {network === 'zerotrust' ? 'zero trust (no network)' : 'semitrusted (egress proxy)'}</span>
          </div>
          {deployResult && (
            <div className="text-sm text-green-400 font-mono bg-[var(--color-background)] rounded p-3 border border-green-500/30">
              Deployed: {deployResult.service_id || deployResult.name}
              {deployResult.domain && (
                <> &middot; <a href={`https://${deployResult.domain}`} target="_blank" rel="noopener noreferrer" className="text-[var(--color-accent)] hover:underline">{deployResult.domain}</a></>
              )}
            </div>
          )}
          {deployError && <div className="text-sm text-red-400">{deployError}</div>}
        </div>
      ) : (
        /* === Unfirehose is deployed === */
        <div className="bg-[var(--color-surface)] rounded border border-green-500/30 p-5 space-y-3">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-3">
              <span className={`w-3 h-3 rounded-full ${unfirehoseService.state === 'running' ? 'bg-green-400 animate-pulse' : 'bg-yellow-400'}`} />
              <div>
                <div className="font-bold text-lg">unfirehose</div>
                <div className="text-xs text-[var(--color-muted)]">
                  {unfirehoseService.state || 'unknown'} &middot; {unfirehoseService.service_id || unfirehoseService.id}
                  {unfirehoseService.ports && <> &middot; port {unfirehoseService.ports}</>}
                </div>
              </div>
            </div>
            <div className="flex items-center gap-3">
              {unfirehoseService.domain && (
                <a
                  href={`https://${unfirehoseService.domain}`}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="px-4 py-2 rounded bg-[var(--color-accent)] text-[var(--color-background)] text-sm font-bold hover:opacity-90 transition-opacity"
                >
                  Open Dashboard
                </a>
              )}
              {(unfirehoseService.locked || unfirehoseService.name === 'uncloseai') ? (
                <span className="text-xs text-[var(--color-muted)] px-2 py-1">🔒 locked</span>
              ) : (
                <button
                  onClick={() => destroyService(unfirehoseService.service_id || unfirehoseService.id)}
                  className="text-xs text-red-400 hover:text-red-300 cursor-pointer px-2 py-1"
                >
                  destroy
                </button>
              )}
            </div>
          </div>
          {unfirehoseService.domain && (
            <div className="text-xs font-mono text-[var(--color-muted)]">
              https://{unfirehoseService.domain}
            </div>
          )}
          {unfirehoseService.state === 'running' && (
            <div className="border-t border-green-500/20 pt-3 mt-1 space-y-2">
              <div className="text-sm text-green-400 font-bold">Node is ready for work.</div>
              <p className="text-xs text-[var(--color-muted)]">
                This node can run agent harnesses on cloud compute. Assign tasks from the{' '}
                <Link href="/projects" className="text-[var(--color-accent)] hover:underline">Projects</Link> page
                or queue todos from{' '}
                <Link href="/todos" className="text-[var(--color-accent)] hover:underline">Todos</Link>.
              </p>
            </div>
          )}
        </div>
      )}

      {/* === Sessions === */}
      {sessionList.length > 0 && (
        <div className="bg-[var(--color-surface)] rounded border border-[var(--color-border)] p-4 space-y-3">
          <div className="flex items-center justify-between">
            <h2 className="text-sm font-bold text-[var(--color-muted)] uppercase tracking-wide">Sessions ({sessionList.length})</h2>
            <button onClick={() => mutateSessions()} className="text-xs text-[var(--color-muted)] hover:text-[var(--color-foreground)] cursor-pointer">refresh</button>
          </div>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-2">
            {sessionList.map((s: any) => {
              const id = s.session_id || s.id;
              return (
                <div key={id} className="bg-[var(--color-background)] rounded border border-[var(--color-border)] p-3 flex items-center justify-between">
                  <div>
                    <div className="flex items-center gap-2">
                      <span className="w-2 h-2 rounded-full bg-green-400 animate-pulse" />
                      <span className="font-mono text-xs font-bold">{id}</span>
                    </div>
                    {s.shell && <div className="text-xs text-[var(--color-muted)] mt-0.5">shell: {s.shell}</div>}
                  </div>
                  <button
                    onClick={() => killSession(id)}
                    disabled={killingSession === id}
                    className="text-xs text-red-400 hover:text-red-300 cursor-pointer disabled:opacity-50"
                  >
                    {killingSession === id ? '...' : 'kill'}
                  </button>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* === Other services === */}
      {serviceList.filter(s => s !== unfirehoseService).length > 0 && (
        <div className="bg-[var(--color-surface)] rounded border border-[var(--color-border)] p-4 space-y-3">
          <h2 className="text-sm font-bold text-[var(--color-muted)] uppercase tracking-wide">Other Services</h2>
          <div className="space-y-2">
            {serviceList.filter(s => s !== unfirehoseService).map((svc: any) => {
              const id = svc.service_id || svc.id;
              const isLocked = svc.locked || svc.name === 'uncloseai';
              return (
                <div key={id} className="bg-[var(--color-background)] rounded border border-[var(--color-border)] p-3 flex items-center justify-between">
                  <div className="flex items-center gap-3">
                    <span className={`w-2 h-2 rounded-full ${svc.state === 'running' ? 'bg-green-400' : svc.state === 'frozen' ? 'bg-blue-400' : 'bg-yellow-400'}`} />
                    <span className="font-mono text-sm font-bold">{svc.name || id}</span>
                    <span className="text-xs text-[var(--color-muted)]">{svc.state}</span>
                    {svc.ports && <span className="text-xs text-[var(--color-muted)]">:{svc.ports}</span>}
                    {svc.domain && (
                      <a href={`https://${svc.domain}`} target="_blank" rel="noopener noreferrer" className="text-xs text-[var(--color-accent)] hover:underline font-mono">{svc.domain}</a>
                    )}
                  </div>
                  {isLocked ? (
                    <span className="text-xs text-[var(--color-muted)]">🔒 locked</span>
                  ) : (
                    <button onClick={() => destroyService(id)} className="text-xs text-red-400 hover:text-red-300 cursor-pointer">destroy</button>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* === Terminal === */}
      <div className="bg-[var(--color-surface)] rounded border border-[var(--color-border)] p-4 space-y-3">
        <div className="flex items-center justify-between">
          <h2 className="text-sm font-bold text-[var(--color-muted)] uppercase tracking-wide">Terminal</h2>
          <div className="flex items-center gap-2">
            {(['semitrusted', 'zerotrust'] as const).map(mode => (
              <button
                key={mode}
                onClick={() => setNetwork(mode)}
                className={`px-2.5 py-1 text-xs rounded cursor-pointer transition-colors ${
                  network === mode
                    ? 'bg-[var(--color-accent)] text-[var(--color-background)] font-bold'
                    : 'text-[var(--color-muted)] hover:text-[var(--color-foreground)] border border-[var(--color-border)]'
                }`}
              >
                {mode === 'semitrusted' ? 'semitrusted' : 'zero trust'}
              </button>
            ))}
          </div>
        </div>
        <p className="text-xs text-[var(--color-muted)]">
          Ephemeral sandbox &mdash; container runs your command then self-destructs. No cleanup, no lingering sessions, no cost beyond rate limit.
          {network === 'zerotrust'
            ? <span className="text-yellow-400 ml-1">⚠ no network access</span>
            : <span className="ml-1">&middot; egress via proxy</span>}
        </p>
        <div className="flex gap-2">
          <input
            type="text"
            value={cmd}
            onChange={e => setCmd(e.target.value)}
            placeholder="uname -a"
            className="flex-1 bg-[var(--color-background)] border border-[var(--color-border)] rounded px-3 py-2 text-sm font-mono"
            onKeyDown={e => { if (e.key === 'Enter') executeCommand(); }}
          />
          <button
            onClick={executeCommand}
            disabled={cmdRunning || !cmd.trim()}
            className="px-4 py-2 text-sm font-bold rounded bg-[var(--color-accent)] text-[var(--color-background)] hover:opacity-90 transition-opacity disabled:opacity-50 cursor-pointer"
          >
            {cmdRunning ? '...' : 'Run'}
          </button>
        </div>
        {cmdResult && (
          <pre className="bg-[#0d0d0d] rounded border border-[var(--color-border)] p-3 text-xs font-mono overflow-auto max-h-48 whitespace-pre-wrap">
            {cmdResult.error ? (
              <span className="text-red-400">{cmdResult.error}</span>
            ) : (
              <>
                {cmdResult.stdout && <span className="text-[#d4d4d4]">{cmdResult.stdout}</span>}
                {cmdResult.stderr && <span className="text-yellow-400">{cmdResult.stderr}</span>}
                {cmdResult.exit_code !== undefined && cmdResult.exit_code !== 0 && (
                  <span className="text-red-400 block mt-1">exit code: {cmdResult.exit_code}</span>
                )}
              </>
            )}
          </pre>
        )}
      </div>
    </div>
  );
}
