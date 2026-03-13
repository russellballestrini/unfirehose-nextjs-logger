'use client';

import { useState, useCallback, useEffect, useMemo } from 'react';
import useSWR from 'swr';
import Link from 'next/link';

/* eslint-disable @typescript-eslint/no-explicit-any */

const fetcher = (url: string) => fetch(url).then(r => r.json());

const TABS = ['Overview', 'Harnesses', 'Bootstrap', 'Services', 'Sessions', 'Ephemeral'] as const;
type Tab = (typeof TABS)[number];

const UNFIREHOSE_BOOTSTRAP = `#!/bin/bash
set -e
which node || (curl -fsSL https://deb.nodesource.com/setup_lts.x | bash - && apt-get install -y nodejs)
which git || apt-get install -y git
# Install claude code
curl -fsSL https://claude.ai/install.sh | bash
export PATH="$HOME/.local/bin:$PATH"
grep -qxF 'export PATH="$HOME/.local/bin:$PATH"' ~/.bashrc || echo 'export PATH="$HOME/.local/bin:$PATH"' >> ~/.bashrc
echo 'export PATH="/root/.local/bin:$PATH"' > /etc/profile.d/claude.sh
if [ ! -d /opt/unfirehose ]; then
  git clone https://github.com/russellballestrini/unfirehose-nextjs-logger.git /opt/unfirehose
fi
cd /opt/unfirehose
npm install
npm run build --filter=web
cd apps/web
PORT=3000 node .next/standalone/server.js`.trim();

const HARNESSES = [
  { id: 'claude-code', name: 'Claude Code', desc: 'Anthropic CLI for Claude — agentic coding in the terminal', install: 'curl -fsSL https://claude.ai/install.sh | bash', verify: '/root/.local/bin/claude --version', tags: ['ml', 'coding'], },
  { id: 'gemini-cli', name: 'Gemini CLI', desc: 'Google CLI for Gemini — agentic coding similar to Claude Code', install: 'npm install -g @anthropic-ai/gemini-cli', verify: 'gemini --version', requiresKey: 'GOOGLE_API_KEY', tags: ['ml', 'coding'], },
  { id: 'openai-codex', name: 'OpenAI Codex CLI', desc: 'OpenAI CLI coding agent — GPT-4 powered terminal assistant', install: 'npm install -g @openai/codex', verify: 'codex --version', requiresKey: 'OPENAI_API_KEY', tags: ['ml', 'coding'], },
  { id: 'open-code', name: 'Open Code', desc: 'Open source alternative to Claude Code — multi-provider', install: 'npm install -g opencode-ai', verify: 'opencode --version', requiresKey: 'ANTHROPIC_API_KEY or OPENAI_API_KEY', tags: ['ml', 'coding'], },
  { id: 'aider', name: 'Aider', desc: 'ML pair programming in the terminal — many models', install: 'pip install aider-chat', verify: 'aider --version', requiresKey: 'ANTHROPIC_API_KEY or OPENAI_API_KEY', tags: ['ml', 'coding'], },
  { id: 'agnt', name: 'agnt', desc: 'Minimal terminal coding agent — lightweight alternative to Claude Code', install: 'npm install -g agnt', verify: 'agnt --version', requiresKey: 'ANTHROPIC_API_KEY', tags: ['ml', 'coding'], },
  { id: 'cursor', name: 'Cursor', desc: 'ML-first code editor — fork of VS Code with built-in chat and autocomplete', install: 'curl -fsSL https://www.cursor.com/download/linux -o cursor.appimage && chmod +x cursor.appimage', verify: 'ls cursor.appimage', tags: ['ml', 'coding'], },
  { id: 'continue-dev', name: 'Continue', desc: 'Open source ML code assistant — VS Code and JetBrains extension', install: 'pip install continue-sdk', verify: 'pip show continue-sdk', tags: ['ml', 'coding'], },
  { id: 'ollama', name: 'Ollama', desc: 'Run open source LLMs locally — llama, mistral, codellama', install: 'curl -fsSL https://ollama.com/install.sh | sh', verify: 'ollama --version', tags: ['ml', 'local'], },
  { id: 'llama-cpp', name: 'llama.cpp', desc: 'Bare-metal LLM inference in C/C++ — GGUF models, CPU and GPU', install: 'git clone https://github.com/ggerganov/llama.cpp && cd llama.cpp && make -j', verify: 'ls llama.cpp/llama-cli', tags: ['ml', 'local'], },
  { id: 'vllm', name: 'vLLM', desc: 'High-throughput LLM serving engine — PagedAttention, continuous batching', install: 'pip install vllm', verify: 'python -c "import vllm; print(vllm.__version__)"', tags: ['ml', 'gpu'], },
  { id: 'text-generation-webui', name: 'text-generation-webui', desc: 'Gradio web UI for LLMs — supports GGUF, GPTQ, AWQ, EXL2, llama.cpp, Transformers', install: 'git clone https://github.com/oobabooga/text-generation-webui && cd text-generation-webui && pip install -r requirements.txt', verify: 'ls text-generation-webui/server.py', tags: ['ml', 'web'], },
  { id: 'open-webui', name: 'Open WebUI', desc: 'Self-hosted ChatGPT-like interface for Ollama and OpenAI APIs', install: 'pip install open-webui', verify: 'open-webui --version', tags: ['ml', 'web'], },
  { id: 'hermes-agent', name: 'Hermes Agent', desc: 'Autonomous agent framework — tool use, memory, planning with local or cloud LLMs', install: 'pip install hermes-agent', verify: 'pip show hermes-agent', tags: ['ml', 'agent'], },
  { id: 'fetch', name: 'Fetch', desc: 'HTTP harness for ML APIs — structured logging and replay', install: 'pip install fetch-cli', verify: 'fetch --version', tags: ['ml', 'api'], },
  { id: 'uncloseai-cli', name: 'uncloseai-cli', desc: 'ReAct agent harness, microgpt, voxsplit — ML from seed on Unclose', install: 'pip install -r requirements.txt', verify: 'python -c "import uncloseai"', tags: ['ml', 'agent'], },
];

type BootStatus = { state: 'idle' } | { state: 'verifying'; output?: string } | { state: 'success'; version: string } | { state: 'error'; detail: string };

function Bar({ pct, color }: { pct: number; color: string }) {
  return (
    <div className="w-full h-2.5 bg-[var(--color-background)] rounded-full overflow-hidden">
      <div className="h-full rounded-full transition-all" style={{ width: `${Math.min(pct, 100)}%`, backgroundColor: color }} />
    </div>
  );
}

function KV({ label, value }: { label: string; value?: string | number | null }) {
  if (value == null || value === '') return null;
  return (
    <div className="flex justify-between gap-2">
      <span className="text-[var(--color-muted)]">{label}:</span>
      <span className="font-bold text-right">{value}</span>
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="bg-[var(--color-surface)] rounded border border-[var(--color-border)] p-4 space-y-3">
      <h3 className="text-sm font-bold text-[var(--color-muted)] uppercase tracking-wide">{title}</h3>
      {children}
    </div>
  );
}

export default function UnsandboxNodePage() {
  const { data: status } = useSWR('/api/unsandbox', fetcher, { refreshInterval: 30000 });
  const { data: services, mutate: mutateServices } = useSWR('/api/unsandbox?action=services', fetcher, { refreshInterval: 10000 });
  const { data: sessions, mutate: mutateSessions } = useSWR('/api/unsandbox?action=sessions', fetcher, { refreshInterval: 10000 });

  const [activeTab, setActiveTabRaw] = useState<Tab>(() => {
    if (typeof window !== 'undefined') {
      const hash = window.location.hash.slice(1);
      if (TABS.includes(hash as Tab)) return hash as Tab;
    }
    return 'Overview';
  });
  const setActiveTab = (tab: Tab) => { setActiveTabRaw(tab); window.location.hash = tab; };
  const [probe, setProbe] = useState<any>(null);
  const [probing, setProbing] = useState(false);
  const [probeError, setProbeError] = useState<string | null>(null);

  const [deploying, setDeploying] = useState(false);
  const [deployResult, setDeployResult] = useState<any>(null);
  const [deployError, setDeployError] = useState<string | null>(null);
  const [serviceLabel, setServiceLabel] = useState('');

  const [cmd, setCmd] = useState('');
  const [cmdResult, setCmdResult] = useState<any>(null);
  const [cmdRunning, setCmdRunning] = useState(false);
  const [network, setNetwork] = useState<'semitrusted' | 'zerotrust'>('semitrusted');

  const [killingSession, setKillingSession] = useState<string | null>(null);
  const [bootStatuses, setBootStatuses] = useState<Record<string, BootStatus>>({});
  const [bootFilter, setBootFilter] = useState('');
  const [sessionProcs, setSessionProcs] = useState<Record<string, any[]>>({});
  const [probingSessions, setProbingSessions] = useState(false);

  const serviceList: any[] = useMemo(() => services?.services ?? [], [services]);
  const sessionList: any[] = useMemo(() => sessions?.sessions ?? [], [sessions]);

  const { data: nicknamesData, mutate: mutateNicknames } = useSWR('/api/sessions/nickname', fetcher, { refreshInterval: 30000 });
  const nicknames: Record<string, { nickname: string; service_name: string }> = nicknamesData ?? {};
  const [editingNick, setEditingNick] = useState<{ sessionId: string; value: string } | null>(null);

  const saveNickname = async (sessionId: string, nickname: string, serviceName = '') => {
    await fetch('/api/sessions/nickname', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ session_id: sessionId, nickname, host: 'unsandbox', service_name: serviceName }),
    });
    setEditingNick(null);
    mutateNicknames();
  };

  const unfirehoseService = serviceList.find((s: any) =>
    (s.name || '').includes('unfirehose') || (s.name || '').includes('firehose')
  );

  // Auto-probe on mount
  const runProbe = useCallback(async () => {
    setProbing(true);
    setProbeError(null);
    try {
      const res = await fetch('/api/unsandbox', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'probe' }),
      });
      const data = await res.json();
      if (data.error) setProbeError(data.error);
      else if (data.probe) setProbe(data.probe);
      else setProbeError('No probe data returned');
    } catch (err) {
      setProbeError(String(err));
    } finally {
      setProbing(false);
    }
  }, []);

  useEffect(() => {
    if (status?.connected) runProbe();
  }, [status?.connected, runProbe]);

  const deployUnfirehose = useCallback(async () => {
    setDeploying(true);
    setDeployResult(null);
    setDeployError(null);
    try {
      const res = await fetch('/api/unsandbox', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'create-service', name: serviceLabel ? `unfirehose-${serviceLabel.replace(/[^a-z0-9-]/gi, '')}` : 'unfirehose', ports: '3000', bootstrap: UNFIREHOSE_BOOTSTRAP, network }),
      });
      const data = await res.json();
      if (data.error) setDeployError(data.error);
      else {
        setDeployResult(data);
        mutateServices();
        // Auto-save label as nickname so it shows up immediately
        const serviceId = data.service_id || data.id;
        const resolvedName = data.resolvedName || data.name;
        if (serviceId && serviceLabel) {
          await fetch('/api/sessions/nickname', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ session_id: serviceId, nickname: serviceLabel, host: 'unsandbox', service_name: resolvedName }),
          });
          mutateNicknames();
        }
      }
    } catch (err) {
      setDeployError(String(err));
    } finally {
      setDeploying(false);
    }
  }, [mutateServices, mutateNicknames, network, serviceLabel]);

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

  // Probe all sessions/services for running processes (claude, node, python, etc.)
  const probeSessionProcesses = useCallback(async () => {
    const allIds = [
      ...sessionList.map((s: any) => s.session_id || s.id),
      ...serviceList.map((s: any) => s.id).filter((id: string) => !sessionList.some((s: any) => (s.session_id || s.id) === id)),
    ];
    if (allIds.length === 0) return;
    setProbingSessions(true);
    const results: Record<string, any[]> = {};
    await Promise.all(allIds.map(async (id) => {
      try {
        const res = await fetch('/api/unsandbox', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            action: 'session-exec',
            sessionId: id,
            command: 'ps aux --sort=-%cpu 2>/dev/null | head -30 || echo "no ps"',
          }),
        });
        const data = await res.json();
        const stdout = data.stdout || data.output || '';
        const lines = stdout.trim().split('\n').filter((l: string) => l.trim());
        // Parse ps aux output
        const procs: any[] = [];
        for (let i = 1; i < lines.length; i++) {
          const parts = lines[i].trim().split(/\s+/);
          if (parts.length < 11) continue;
          const cmd = parts.slice(10).join(' ');
          procs.push({
            user: parts[0], pid: parts[1], cpu: parts[2], mem: parts[3],
            command: cmd.slice(0, 200),
          });
        }
        results[id] = procs;
      } catch {
        results[id] = [];
      }
    }));
    setSessionProcs(results);
    setProbingSessions(false);
  }, [sessionList, serviceList]);

  // Auto-probe when Harnesses tab is active
  useEffect(() => {
    if (activeTab === 'Harnesses' && (sessionList.length > 0 || serviceList.length > 0)) {
      probeSessionProcesses();
    }
  }, [activeTab, sessionList.length, serviceList.length, probeSessionProcesses]);

  const bootHarness = useCallback(async (harness: typeof HARNESSES[0]) => {
    setBootStatuses(prev => ({ ...prev, [harness.id]: { state: 'verifying' } }));
    try {
      // Install + verify via unsandbox execute (ephemeral container with network)
      const script = `#!/bin/bash
set -e
# Ensure basic tools
which node >/dev/null 2>&1 || which python3 >/dev/null 2>&1 || (apt-get update -qq && apt-get install -y -qq nodejs npm python3 python3-pip git curl >/dev/null 2>&1)
which npm >/dev/null 2>&1 || (apt-get update -qq && apt-get install -y -qq npm >/dev/null 2>&1)
which pip >/dev/null 2>&1 || which pip3 >/dev/null 2>&1 || true
# Install
${harness.install} 2>&1
# Verify
echo "---VERIFY---"
${harness.verify} 2>&1 || echo "VERIFY_FAILED"`;
      const res = await fetch('/api/unsandbox', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'execute', language: 'bash', code: script, network: 'semitrusted' }),
      });
      const data = await res.json();
      const stdout = data.stdout || data.output || '';
      const verifyIdx = stdout.indexOf('---VERIFY---');
      const verifyOutput = verifyIdx >= 0 ? stdout.slice(verifyIdx + 12).trim() : stdout.trim();
      if (verifyOutput.includes('VERIFY_FAILED') || data.exit_code !== 0) {
        setBootStatuses(prev => ({ ...prev, [harness.id]: { state: 'error', detail: verifyOutput || data.stderr || 'Install/verify failed' } }));
      } else {
        setBootStatuses(prev => ({ ...prev, [harness.id]: { state: 'success', version: verifyOutput.split('\n')[0] } }));
      }
    } catch (err) {
      setBootStatuses(prev => ({ ...prev, [harness.id]: { state: 'error', detail: String(err) } }));
    }
  }, []);

  if (!status) return <div className="p-6 text-[var(--color-muted)]">Loading...</div>;

  if (!status.connected) {
    return (
      <div className="p-6 space-y-4">
        <Link href="/permacomputer" className="text-sm text-[var(--color-muted)] hover:text-[var(--color-foreground)]">&larr; Permacomputer</Link>
        <h1 className="text-2xl font-bold">unsandbox.com</h1>
        <div className="text-red-400">
          Not connected. <Link href="/settings" className="text-[var(--color-accent)] hover:underline">Configure API keys</Link>.
        </div>
      </div>
    );
  }

  // Probe data
  const cpuCores = probe?.cpuCores ?? 0;
  const memTotal = probe?.memTotalGB ?? 0;
  const memUsed = probe?.memUsedGB ?? 0;
  const memAvail = probe?.memAvailableGB ?? 0;
  const memPct = memTotal > 0 ? (memUsed / memTotal) * 100 : 0;
  const load = probe?.loadAvg ?? [0, 0, 0];
  const loadPerCore = cpuCores > 0 ? load[0] / cpuCores : 0;
  const loadPct = Math.min(loadPerCore * 100, 100);

  return (
    <div className="p-6 w-full space-y-6">
      {/* Breadcrumb */}
      <div className="flex items-center gap-2 text-sm text-[var(--color-muted)]">
        <Link href="/permacomputer" className="hover:text-[var(--color-foreground)]">&larr; Permacomputer</Link>
        <span>/</span>
        <span className="text-[var(--color-foreground)] font-bold">unsandbox</span>
      </div>

      {/* Header */}
      <div className="flex items-center gap-3">
        <span className="w-3 h-3 rounded-full bg-[var(--color-accent)] animate-pulse" />
        <h1 className="text-2xl font-bold">unsandbox.com</h1>
        <span className="text-sm text-[var(--color-muted)]">cloud</span>
        <span className="text-sm font-bold text-[var(--color-accent)] bg-[var(--color-accent)]/10 px-2 py-0.5 rounded">
          tier {status.tier}
        </span>
        <span className="text-sm text-[var(--color-muted)]">
          {status.rateLimit} rpm &middot; {status.maxSessions} sessions
          {status.burst && <> &middot; burst {status.burst}</>}
        </span>
        {status.expiresAtHuman && (
          <span className="text-sm text-[var(--color-muted)] ml-auto">{status.expiresAtHuman}</span>
        )}
      </div>

      {/* Cost card */}
      <div className="bg-[var(--color-surface)] rounded border border-[var(--color-border)] px-6 py-4 flex items-center gap-8">
        <div>
          <span className="text-2xl font-bold text-[var(--color-accent)]">
            {status.tier <= 1 ? 'Free' : `Tier ${status.tier}`}
          </span>
          <span className="text-sm text-[var(--color-muted)]"> ephemeral compute</span>
        </div>
        {probe && (
          <>
            <div className="text-sm text-[var(--color-muted)]">
              {cpuCores} cores &middot; {memTotal.toFixed(1)}G RAM
            </div>
            <div className="text-sm text-[var(--color-muted)]">
              load {load[0].toFixed(2)} / {load[1].toFixed(2)} / {load[2].toFixed(2)}
            </div>
          </>
        )}
        {probing && <span className="text-xs text-[var(--color-muted)] animate-pulse">probing...</span>}
      </div>

      {/* Tabs */}
      <div className="flex gap-1 border-b border-[var(--color-border)]">
        {TABS.map(tab => (
          <button
            key={tab}
            onClick={() => setActiveTab(tab)}
            className={`px-4 py-2 text-sm font-medium transition-colors cursor-pointer -mb-px ${
              activeTab === tab
                ? 'border-b-2 border-[var(--color-accent)] text-[var(--color-accent)]'
                : 'text-[var(--color-muted)] hover:text-[var(--color-foreground)]'
            }`}
          >
            {tab}
            {tab === 'Services' && serviceList.length > 0 && (
              <span className="ml-1.5 text-xs px-1.5 py-0.5 rounded-full bg-[var(--color-surface-hover)]">{serviceList.length}</span>
            )}
            {tab === 'Sessions' && sessionList.length > 0 && (
              <span className="ml-1.5 text-xs px-1.5 py-0.5 rounded-full bg-[var(--color-surface-hover)]">{sessionList.length}</span>
            )}
          </button>
        ))}
      </div>

      {/* ===== OVERVIEW TAB ===== */}
      {activeTab === 'Overview' && (
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
          <div className="space-y-6">
            <Section title="System">
              {probe ? (
                <div className="grid grid-cols-2 gap-x-6 gap-y-2 text-sm">
                  <KV label="CPU" value={probe.cpuModel?.replace(/\(R\)|\(TM\)/g, '').replace(/CPU\s+/i, '').trim()} />
                  <KV label="Cores" value={cpuCores} />
                  <KV label="Memory" value={`${memTotal.toFixed(1)}GB`} />
                  <KV label="Uptime" value={probe.uptime} />
                  {probe.gpuModel && <KV label="GPU" value={probe.gpuModel} />}
                  {probe.gpuMemTotalMB > 0 && <KV label="GPU Memory" value={`${(probe.gpuMemTotalMB / 1024).toFixed(1)}GB`} />}
                </div>
              ) : probing ? (
                <div className="text-sm text-[var(--color-muted)] animate-pulse">Probing sandbox...</div>
              ) : probeError ? (
                <div className="space-y-2">
                  <div className="text-sm text-[var(--color-error)]">{probeError}</div>
                  <button onClick={runProbe} className="text-xs text-[var(--color-accent)] hover:underline cursor-pointer">Retry probe</button>
                </div>
              ) : null}
            </Section>

            {probe && (
              <Section title="CPU Load">
                <div className="space-y-2">
                  <div className="flex justify-between text-sm text-[var(--color-muted)]">
                    <span>Load: {load[0].toFixed(2)} / {load[1].toFixed(2)} / {load[2].toFixed(2)}</span>
                    <span>{cpuCores} cores</span>
                  </div>
                  <Bar pct={loadPct} color={loadPerCore > 2 ? 'var(--color-error)' : loadPerCore > 1 ? '#f97316' : 'var(--color-accent)'} />
                  <div className="text-xs text-[var(--color-muted)]">
                    {loadPct.toFixed(0)}% per-core utilization
                  </div>
                </div>
              </Section>
            )}

            {probe && memTotal > 0 && (
              <Section title="Memory">
                <div className="space-y-2">
                  <div className="flex justify-between text-sm text-[var(--color-muted)]">
                    <span>{memUsed.toFixed(1)}GB / {memTotal.toFixed(1)}GB ({memPct.toFixed(0)}%)</span>
                    <span>{memAvail.toFixed(1)}G available</span>
                  </div>
                  <Bar pct={memPct} color={memPct > 85 ? 'var(--color-error)' : '#60a5fa'} />
                  {probe.swapTotalGB > 0 && (
                    <div className="text-xs text-[var(--color-muted)]">
                      Swap: {probe.swapUsedGB}GB / {probe.swapTotalGB}GB
                    </div>
                  )}
                </div>
              </Section>
            )}
          </div>

          <div className="space-y-6">
            {/* Account info */}
            <Section title="Account">
              <div className="grid grid-cols-2 gap-x-6 gap-y-2 text-sm">
                <KV label="Tier" value={status.tier} />
                <KV label="Rate Limit" value={`${status.rateLimit} rpm`} />
                <KV label="Max Sessions" value={status.maxSessions} />
                <KV label="Burst" value={status.burst} />
                <KV label="Expires" value={status.expiresAtHuman} />
              </div>
            </Section>

            {/* Unfirehose service status */}
            <Section title="unfirehose Service">
              {unfirehoseService ? (
                <div className="space-y-2">
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className={`w-2.5 h-2.5 rounded-full flex-shrink-0 ${unfirehoseService.state === 'running' ? 'bg-green-400 animate-pulse' : 'bg-yellow-400'}`} />
                    <span className="font-bold">{unfirehoseService.state || 'unknown'}</span>
                    <span className="text-xs text-[var(--color-muted)] font-mono">{unfirehoseService.service_id || unfirehoseService.id}</span>
                  </div>
                  <div className="flex items-center gap-2 flex-wrap">
                    <Link href={`/tmux/${encodeURIComponent(unfirehoseService.service_id || unfirehoseService.id)}?host=unsandbox`}
                      className="px-3 py-1.5 rounded border border-violet-500 text-violet-300 text-sm font-bold hover:bg-violet-500/10 transition-colors">
                      → terminal
                    </Link>
                    {unfirehoseService.domain && (
                      <a href={`https://${unfirehoseService.domain}`} target="_blank" rel="noopener noreferrer"
                        className="px-3 py-1.5 rounded bg-[var(--color-accent)] text-[var(--color-background)] text-sm font-bold hover:opacity-90 transition-opacity">
                        Open Dashboard ↗
                      </a>
                    )}
                  </div>
                  {unfirehoseService.domain && (
                    <a href={`https://${unfirehoseService.domain}`} target="_blank" rel="noopener noreferrer"
                      className="text-xs text-[var(--color-accent)] hover:underline font-mono block">
                      https://{unfirehoseService.domain}
                    </a>
                  )}
                </div>
              ) : (
                <div className="space-y-3">
                  <p className="text-sm text-[var(--color-muted)]">
                    No unfirehose service deployed. Deploy to add unsandbox as a mesh node.
                  </p>
                  <div className="flex items-center gap-2">
                    <input
                      value={serviceLabel}
                      onChange={e => setServiceLabel(e.target.value)}
                      placeholder="label (optional, e.g. 2)"
                      className="px-2 py-1.5 text-sm rounded border border-[var(--color-border)] bg-[var(--color-background)] font-mono w-40"
                    />
                    <button onClick={deployUnfirehose} disabled={deploying}
                      className="px-4 py-2 text-sm font-bold rounded bg-[var(--color-accent)] text-[var(--color-background)] hover:opacity-90 transition-opacity disabled:opacity-50 cursor-pointer">
                      {deploying ? 'Deploying...' : 'Deploy unfirehose'}
                    </button>
                  </div>
                  {deployResult && (
                    <div className="text-xs text-green-400 font-mono">Deployed: {deployResult.resolvedName || deployResult.service_id || deployResult.name}</div>
                  )}
                  {deployError && <div className="text-xs text-red-400">{deployError}</div>}
                </div>
              )}
            </Section>

            {/* Quick stats */}
            <Section title="Quick Stats">
              <div className="grid grid-cols-2 gap-x-6 gap-y-2 text-sm">
                <div className="flex justify-between">
                  <span className="text-[var(--color-muted)]">Services</span>
                  <button onClick={() => setActiveTab('Services')} className="font-bold tabular-nums hover:text-[var(--color-accent)] transition-colors cursor-pointer">{serviceList.length}</button>
                </div>
                <div className="flex justify-between">
                  <span className="text-[var(--color-muted)]">Active Sessions</span>
                  <button onClick={() => setActiveTab('Sessions')} className="font-bold tabular-nums hover:text-[var(--color-accent)] transition-colors cursor-pointer">{sessionList.length}</button>
                </div>
                <KV label="Type" value="ephemeral" />
                <KV label="Provider" value="unsandbox.com" />
              </div>
            </Section>

            {/* Probe refresh */}
            <button onClick={runProbe} disabled={probing}
              className="text-xs text-[var(--color-accent)] hover:underline cursor-pointer disabled:opacity-50">
              {probing ? 'Probing...' : 'Re-probe system'}
            </button>
          </div>
        </div>
      )}

      {/* ===== HARNESSES TAB ===== */}
      {activeTab === 'Harnesses' && (() => {
        // Combine sessions + services, find claude/harness processes in each
        const entries: { id: string; name: string; type: string; state: string; procs: any[] }[] = [];

        for (const svc of serviceList) {
          const id = svc.id;
          const procs = sessionProcs[id] ?? [];
          const claudeProcs = procs.filter(p => /claude|anthropic|node.*claude/i.test(p.command));
          entries.push({
            id, name: svc.name || id, type: 'service',
            state: svc.state || 'unknown', procs,
          });
          // Count claudes for this service
          if (claudeProcs.length > 0) {
            // Tag them
          }
        }

        for (const sess of sessionList) {
          const id = sess.session_id || sess.id;
          // Skip if already covered by a service
          if (entries.some(e => e.id === id)) continue;
          const procs = sessionProcs[id] ?? [];
          const nick = nicknames[id];
          entries.push({
            id,
            name: nick?.nickname || id,
            subtitle: nick?.nickname ? id : (nick?.service_name || null),
            serviceName: nick?.service_name || null,
            type: 'session',
            state: sess.status || 'active', procs,
          });
        }

        const totalClaudes = Object.values(sessionProcs).flat().filter(p => /claude|anthropic/i.test(p.command)).length;

        return (
          <div className="space-y-4">
            <div className="flex items-center justify-between">
              <h2 className="text-sm font-bold text-[var(--color-muted)]">
                Running Harnesses
                {totalClaudes > 0 && <span className="ml-2 text-[var(--color-accent)]">({totalClaudes} claude{totalClaudes !== 1 ? 's' : ''})</span>}
              </h2>
              <button onClick={probeSessionProcesses} disabled={probingSessions}
                className="text-xs text-[var(--color-accent)] hover:underline cursor-pointer disabled:opacity-50">
                {probingSessions ? 'Probing...' : 'Refresh'}
              </button>
            </div>

            {entries.length === 0 && !probingSessions && (
              <div className="text-sm text-[var(--color-muted)] text-center py-8 bg-[var(--color-surface)] rounded border border-[var(--color-border)]">
                No active sessions or services on unsandbox.
              </div>
            )}

            {probingSessions && Object.keys(sessionProcs).length === 0 && (
              <div className="text-sm text-[var(--color-muted)] text-center py-8 bg-[var(--color-surface)] rounded border border-[var(--color-border)] animate-pulse">
                Probing sessions for running processes...
              </div>
            )}

            {entries.map(entry => {
              const claudeProcs = entry.procs.filter(p => /claude|anthropic/i.test(p.command));
              const nodeProcs = entry.procs.filter(p => /\bnode\b/i.test(p.command) && !/claude/i.test(p.command));
              const pythonProcs = entry.procs.filter(p => /\bpython/i.test(p.command));
              const interesting = [...claudeProcs, ...nodeProcs, ...pythonProcs];
              const isService = entry.type === 'service';

              return (
                <div key={entry.id} className="bg-[var(--color-surface)] rounded border border-[var(--color-border)] hover:border-violet-500/40 transition-colors p-4 space-y-3">
                  <div className="flex items-center justify-between">
                    <Link href={`/tmux/${encodeURIComponent(entry.id)}?host=unsandbox`} className="flex items-center gap-2 min-w-0 flex-1 group/link">
                      <span className={`w-2.5 h-2.5 rounded-full flex-shrink-0 ${entry.state === 'running' || entry.state === 'active' ? 'bg-green-400 animate-pulse' : 'bg-yellow-400'}`} />
                      <div className="min-w-0">
                        <span className="font-bold font-mono text-sm group-hover/link:text-violet-300 transition-colors">{entry.name}</span>
                        {entry.subtitle && (
                          <span className="ml-2 text-xs text-[var(--color-muted)] font-mono">{entry.subtitle}</span>
                        )}
                        {entry.serviceName && (
                          <span className="ml-2 text-xs text-violet-400/70 font-mono">⬡ {entry.serviceName}</span>
                        )}
                        <span className="ml-2 text-[10px] text-violet-400/50 group-hover/link:text-violet-400 transition-colors">→ terminal</span>
                      </div>
                      <span className="text-xs text-[var(--color-muted)] flex-shrink-0">{entry.type}</span>
                    </Link>
                    <div className="flex items-center gap-3">
                      {claudeProcs.length > 0 && (
                        <span className="text-xs font-bold text-[var(--color-accent)] bg-[var(--color-accent)]/10 px-1.5 py-0.5 rounded">
                          {claudeProcs.length} claude{claudeProcs.length !== 1 ? 's' : ''}
                        </span>
                      )}
                      {nodeProcs.length > 0 && (
                        <span className="text-xs text-green-400">{nodeProcs.length} node</span>
                      )}
                      {pythonProcs.length > 0 && (
                        <span className="text-xs text-blue-400">{pythonProcs.length} python</span>
                      )}
                      {isService && (
                        <span className="text-xs text-[var(--color-muted)]">{entry.state}</span>
                      )}
                    </div>
                  </div>

                  {interesting.length > 0 ? (
                    <div className="space-y-1">
                      {interesting.slice(0, 15).map((p, i) => {
                        const isClaude = /claude|anthropic/i.test(p.command);
                        return (
                          <div key={i} className="flex items-center gap-3 text-xs">
                            <span className={`w-1.5 h-1.5 rounded-full ${isClaude ? 'bg-[var(--color-accent)]' : 'bg-green-400'}`} />
                            <span className="text-[var(--color-muted)] w-8 text-right">PID {p.pid}</span>
                            <span className="text-[var(--color-muted)]">CPU {p.cpu}%</span>
                            <span className="text-[var(--color-muted)]">MEM {p.mem}%</span>
                            <span className="font-mono truncate max-w-[500px]">{p.command}</span>
                          </div>
                        );
                      })}
                    </div>
                  ) : entry.procs.length > 0 ? (
                    <div className="text-xs text-[var(--color-muted)]">
                      {entry.procs.length} processes running (no ML harnesses detected)
                    </div>
                  ) : (
                    <div className="text-xs text-[var(--color-muted)]">
                      {probingSessions ? 'Probing...' : 'No process data — probe may have failed'}
                    </div>
                  )}
                </div>
              );
            })}

            {entries.length > 0 && (
              <p className="text-xs text-[var(--color-muted)]">
                Shows processes running inside unsandbox sessions and services. Claude, Node.js, and Python processes are highlighted.
              </p>
            )}
          </div>
        );
      })()}

      {/* ===== BOOTSTRAP TAB ===== */}
      {activeTab === 'Bootstrap' && (
        <div>
          <div className="flex items-center justify-between mb-4">
            <div className="text-sm text-[var(--color-muted)]">
              target: <span className="font-mono text-[var(--color-foreground)]">unsandbox</span>
              <span className="ml-2 text-xs opacity-60">(each install runs in an ephemeral container with semitrusted network)</span>
            </div>
            <input
              type="text"
              placeholder="Filter..."
              value={bootFilter}
              onChange={(e) => setBootFilter(e.target.value)}
              className="text-xs bg-[var(--color-background)] border border-[var(--color-border)] rounded px-2 py-1 w-32"
            />
          </div>
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3">
            {HARNESSES
              .filter(h => !bootFilter || h.name.toLowerCase().includes(bootFilter.toLowerCase()) || h.tags.some(t => t.includes(bootFilter.toLowerCase())))
              .map(h => {
              const bStatus = bootStatuses[h.id] ?? { state: 'idle' };
              return (
                <div
                  key={h.id}
                  className={`rounded border p-3 space-y-2 ${
                    bStatus.state === 'success' ? 'border-[var(--color-accent)] bg-[var(--color-accent)]/5'
                    : bStatus.state === 'error' ? 'border-[var(--color-error)] bg-red-950/20'
                    : 'border-[var(--color-border)] bg-[var(--color-background)]'
                  }`}
                >
                  <div className="flex items-center justify-between">
                    <span className="text-sm font-bold">{h.name}</span>
                    <div className="flex gap-1">
                      {h.tags.slice(0, 2).map(t => (
                        <span key={t} className="text-xs px-1 py-0.5 rounded bg-[var(--color-surface)] text-[var(--color-muted)]">{t}</span>
                      ))}
                    </div>
                  </div>
                  <p className="text-xs text-[var(--color-muted)]">{h.desc}</p>
                  <div className="text-xs text-[var(--color-muted)] font-mono space-y-0.5">
                    <div className="truncate">install: {h.install}</div>
                    <div className="truncate">verify: {h.verify}</div>
                    {h.requiresKey && <div className="text-yellow-500/80">requires: {h.requiresKey}</div>}
                  </div>

                  <div className="flex items-center gap-2">
                    <button
                      onClick={() => bootHarness(h)}
                      disabled={bStatus.state === 'verifying'}
                      className="bg-[var(--color-accent)] text-black px-2.5 py-0.5 rounded text-xs font-bold disabled:opacity-50 cursor-pointer"
                    >
                      {bStatus.state === 'verifying' ? 'Installing...' : bStatus.state === 'success' ? 'Re-verify' : 'Verify & Install'}
                    </button>
                    {bStatus.state === 'success' && (
                      <span className="text-xs text-[var(--color-accent)] font-mono ml-auto truncate max-w-60">{bStatus.version}</span>
                    )}
                    {bStatus.state === 'error' && (
                      <span className="text-xs text-[var(--color-error)] ml-auto truncate max-w-40">{bStatus.detail}</span>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
          <p className="text-xs text-[var(--color-muted)] mt-3">
            Each install runs in an ephemeral unsandbox container. The container self-destructs after verification.
            For persistent harnesses, deploy via the Services tab.
          </p>
        </div>
      )}

      {/* ===== SERVICES TAB ===== */}
      {activeTab === 'Services' && (
        <div className="space-y-4">
          {/* Deploy action */}
          {!unfirehoseService && (
            <div className="bg-[var(--color-surface)] rounded border-2 border-[var(--color-accent)]/40 p-6 space-y-3">
              <h2 className="text-lg font-bold">Deploy unfirehose</h2>
              <p className="text-sm text-[var(--color-muted)]">
                Add unsandbox as a mesh node. Deploys the dashboard on port 3000.
              </p>
              <div className="flex items-center gap-2">
                <input
                  value={serviceLabel}
                  onChange={e => setServiceLabel(e.target.value)}
                  placeholder="label (optional, e.g. 2)"
                  className="px-2 py-1.5 text-sm rounded border border-[var(--color-border)] bg-[var(--color-background)] font-mono w-40"
                />
                <button onClick={deployUnfirehose} disabled={deploying}
                  className="px-6 py-2.5 text-sm font-bold rounded bg-[var(--color-accent)] text-[var(--color-background)] hover:opacity-90 transition-opacity disabled:opacity-50 cursor-pointer">
                  {deploying ? 'Deploying...' : 'Deploy unfirehose'}
                </button>
              </div>
              {deployResult && <div className="text-sm text-green-400 font-mono">Deployed: {deployResult.resolvedName || deployResult.service_id || deployResult.name}</div>}
              {deployError && <div className="text-sm text-red-400">{deployError}</div>}
            </div>
          )}

          {/* Service list */}
          {serviceList.length > 0 ? (
            <div className="space-y-2">
              {serviceList.map((svc: any) => {
                const id = svc.service_id || svc.id;
                const isLocked = svc.locked || svc.name === 'uncloseai';
                const nick = nicknames[id];
                const isEditing = editingNick?.sessionId === id;
                return (
                  <div key={id} className="bg-[var(--color-surface)] rounded border border-[var(--color-border)] hover:border-violet-500/50 transition-colors">
                    <div className="flex items-center justify-between">
                      <div className="flex-1 min-w-0">
                        {/* Nickname row */}
                        <div className="px-4 pt-3 pb-1" onClick={e => e.stopPropagation()}>
                          {isEditing ? (
                            <input
                              autoFocus
                              value={editingNick?.value ?? ''}
                              onChange={e => setEditingNick({ sessionId: id, value: e.target.value })}
                              onKeyDown={e => {
                                const v = editingNick?.value ?? '';
                                if (e.key === 'Enter') saveNickname(id, v, svc.name || '');
                                if (e.key === 'Escape') setEditingNick(null);
                              }}
                              onBlur={() => saveNickname(id, editingNick?.value ?? '', svc.name || '')}
                              placeholder="nickname…"
                              className="w-full text-sm px-2 py-1 rounded border border-violet-500/50 bg-[var(--color-background)] font-bold outline-none"
                            />
                          ) : (
                            <button onClick={() => setEditingNick({ sessionId: id, value: nick?.nickname ?? '' })}
                              className="w-full text-left text-sm font-bold hover:text-violet-300 transition-colors truncate">
                              {nick?.nickname || <span className="text-violet-400/40 font-normal text-xs">✎ add nickname</span>}
                            </button>
                          )}
                        </div>
                        {/* Service info — clickable to terminal */}
                        <Link href={`/tmux/${encodeURIComponent(id)}?host=unsandbox`} className="flex items-center gap-3 px-4 pb-3">
                          <span className={`w-2.5 h-2.5 rounded-full flex-shrink-0 ${svc.state === 'running' ? 'bg-green-400 animate-pulse' : svc.state === 'frozen' ? 'bg-blue-400' : 'bg-yellow-400'}`} />
                          <div className="min-w-0">
                            <div className="font-bold font-mono text-sm">{svc.name || id}</div>
                            <div className="text-xs text-[var(--color-muted)] font-mono truncate">
                              {svc.state} · {id}
                              {svc.ports && <> · port {svc.ports}</>}
                            </div>
                            <div className="text-[10px] text-violet-400/60 mt-0.5">→ open terminal</div>
                          </div>
                        </Link>
                      </div>
                      <div className="flex items-center gap-3 pr-4 flex-shrink-0">
                        {svc.domain && (
                          <a href={`https://${svc.domain}`} target="_blank" rel="noopener noreferrer"
                            className="px-3 py-1.5 rounded bg-[var(--color-accent)] text-[var(--color-background)] text-sm font-bold hover:opacity-90 transition-opacity">
                            Open ↗
                          </a>
                        )}
                        {isLocked ? (
                          <span className="text-xs text-[var(--color-muted)]">locked</span>
                        ) : (
                          <button onClick={() => destroyService(id)} className="text-xs text-red-400 hover:text-red-300 cursor-pointer">destroy</button>
                        )}
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          ) : (
            <p className="text-center text-[var(--color-muted)] py-8">No services deployed</p>
          )}
        </div>
      )}

      {/* ===== SESSIONS TAB ===== */}
      {activeTab === 'Sessions' && (
        <div className="space-y-4">
          <div className="flex items-center justify-between">
            <h2 className="text-sm font-bold text-[var(--color-muted)]">Active Sessions ({sessionList.length})</h2>
            <button onClick={() => mutateSessions()} className="text-xs text-[var(--color-accent)] hover:underline cursor-pointer">refresh</button>
          </div>

          {sessionList.length > 0 ? (
            <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
              {sessionList.map((s: any) => {
                const id = s.session_id || s.id;
                const nick = nicknames[id];
                const isEditing = editingNick?.sessionId === id;
                return (
                  <div key={id} className="bg-[var(--color-surface)] rounded border border-[var(--color-border)] hover:border-violet-500/50 transition-colors">
                    {/* Nickname row */}
                    <div className="px-4 pt-3 pb-1" onClick={e => e.stopPropagation()}>
                      {isEditing ? (
                        <input
                          autoFocus
                          value={editingNick?.value ?? ''}
                          onChange={e => setEditingNick({ sessionId: id, value: e.target.value })}
                          onKeyDown={e => {
                            const v = editingNick?.value ?? '';
                            if (e.key === 'Enter') saveNickname(id, v, nick?.service_name ?? '');
                            if (e.key === 'Escape') setEditingNick(null);
                          }}
                          onBlur={() => saveNickname(id, editingNick?.value ?? '', nick?.service_name ?? '')}
                          placeholder="nickname…"
                          className="w-full text-sm px-2 py-1 rounded border border-violet-500/50 bg-[var(--color-background)] font-bold outline-none"
                        />
                      ) : (
                        <button onClick={() => setEditingNick({ sessionId: id, value: nick?.nickname ?? '' })}
                          className="w-full text-left text-sm font-bold hover:text-violet-300 transition-colors truncate">
                          {nick?.nickname || <span className="text-violet-400/40 font-normal text-xs">✎ add nickname</span>}
                        </button>
                      )}
                      {nick?.service_name && !isEditing && (
                        <p className="text-xs text-violet-400/70 font-mono truncate mt-0.5">⬡ {nick.service_name}</p>
                      )}
                    </div>
                    <div className="px-4 pb-3 flex items-center justify-between">
                      <Link href={`/tmux/${encodeURIComponent(id)}?host=unsandbox`} className="flex-1 min-w-0">
                        <div className="flex items-center gap-2">
                          <span className="w-2 h-2 rounded-full bg-green-400 animate-pulse flex-shrink-0" />
                          <span className="font-mono text-xs text-violet-300 truncate" title={id}>{id}</span>
                        </div>
                        {s.shell && <div className="text-xs text-[var(--color-muted)] mt-0.5">shell: {s.shell}</div>}
                        {s.created_at && <div className="text-xs text-[var(--color-muted)]">{s.created_at}</div>}
                        <div className="text-[10px] text-violet-500 mt-1">→ open terminal</div>
                      </Link>
                      <button onClick={() => killSession(id)} disabled={killingSession === id}
                        className="text-xs text-red-400 hover:text-red-300 cursor-pointer disabled:opacity-50 ml-4 shrink-0">
                        {killingSession === id ? '...' : 'kill'}
                      </button>
                    </div>
                  </div>
                );
              })}
            </div>
          ) : (
            <p className="text-center text-[var(--color-muted)] py-8">No active sessions</p>
          )}
        </div>
      )}

      {/* ===== EPHEMERAL TAB ===== */}
      {activeTab === 'Ephemeral' && (
        <div className="space-y-6">
          <div className="flex items-center justify-between">
            <p className="text-sm text-[var(--color-muted)]">
              Ephemeral sandbox — container runs your command then self-destructs. Use <span className="text-[var(--color-foreground)]">semitrusted</span> for network access (git clone, npm install, push).
            </p>
            <div className="flex items-center gap-2">
              {(['semitrusted', 'zerotrust'] as const).map(mode => (
                <button key={mode} onClick={() => setNetwork(mode)}
                  className={`px-2.5 py-1 text-xs rounded cursor-pointer transition-colors ${
                    network === mode
                      ? 'bg-[var(--color-accent)] text-[var(--color-background)] font-bold'
                      : 'text-[var(--color-muted)] hover:text-[var(--color-foreground)] border border-[var(--color-border)]'
                  }`}>
                  {mode === 'semitrusted' ? 'semitrusted' : 'zero trust'}
                </button>
              ))}
            </div>
          </div>

          <div className="flex gap-2">
            <input type="text" value={cmd} onChange={e => setCmd(e.target.value)}
              placeholder="git clone https://github.com/you/repo && cd repo && npm test"
              onKeyDown={e => { if (e.key === 'Enter') executeCommand(); }}
              className="flex-1 bg-[var(--color-background)] border border-[var(--color-border)] rounded px-3 py-2 text-sm font-mono focus:outline-none focus:border-[var(--color-accent)]" />
            <button onClick={executeCommand} disabled={cmdRunning || !cmd.trim()}
              className="px-4 py-2 text-sm font-bold rounded bg-[var(--color-accent)] text-[var(--color-background)] hover:opacity-90 transition-opacity disabled:opacity-50 cursor-pointer">
              {cmdRunning ? '...' : 'Run'}
            </button>
          </div>

          {cmdResult && (
            <pre className="bg-[#0d0d0d] rounded border border-[var(--color-border)] p-3 text-xs font-mono overflow-auto max-h-96 whitespace-pre-wrap">
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

          {/* Example workflows */}
          <div className="space-y-4">
            <h3 className="text-sm font-bold text-[var(--color-muted)]">Example Workflows</h3>

            <div className="grid grid-cols-1 lg:grid-cols-2 gap-3">
              <ExampleCard
                title="Clone, test, and push"
                desc="Clone a repo, run the test suite, commit results, and push back to origin."
                command={`git clone https://github.com/you/repo /workspace && cd /workspace && npm install && npm test && git add -A && git commit -m "ci: test run from unsandbox" && git push`}
                network="semitrusted"
                onRun={(c, n) => { setCmd(c); setNetwork(n); }}
              />
              <ExampleCard
                title="Claude Code on a repo"
                desc="Clone a project and run Claude Code with a prompt. Requires ANTHROPIC_API_KEY in the container."
                command={`git clone https://github.com/you/repo /workspace && cd /workspace && claude --dangerously-skip-permissions "review this codebase and fix any defects"`}
                network="semitrusted"
                onRun={(c, n) => { setCmd(c); setNetwork(n); }}
              />
              <ExampleCard
                title="Run CI pipeline"
                desc="Execute a full CI pipeline: install deps, lint, type-check, test, build."
                command={`git clone https://github.com/you/repo /workspace && cd /workspace && npm ci && npm run lint && npm run typecheck && npm test && npm run build`}
                network="semitrusted"
                onRun={(c, n) => { setCmd(c); setNetwork(n); }}
              />
              <ExampleCard
                title="Security audit"
                desc="Clone and run npm audit + license check in a zero-trust sandbox (no outbound after clone)."
                command={`git clone https://github.com/you/repo /workspace && cd /workspace && npm ci && npm audit && npx license-checker --summary`}
                network="semitrusted"
                onRun={(c, n) => { setCmd(c); setNetwork(n); }}
              />
              <ExampleCard
                title="Python project"
                desc="Clone a Python repo, set up a venv, install deps, and run pytest."
                command={`git clone https://github.com/you/repo /workspace && cd /workspace && python3 -m venv .venv && . .venv/bin/activate && pip install -r requirements.txt && pytest`}
                network="semitrusted"
                onRun={(c, n) => { setCmd(c); setNetwork(n); }}
              />
              <ExampleCard
                title="Benchmark a commit"
                desc="Clone at a specific commit and run benchmarks in isolation."
                command={`git clone https://github.com/you/repo /workspace && cd /workspace && git checkout abc1234 && npm ci && npm run bench`}
                network="semitrusted"
                onRun={(c, n) => { setCmd(c); setNetwork(n); }}
              />
              <ExampleCard
                title="Multi-repo workspace"
                desc="Clone multiple repos and link them together for integration testing."
                command={`mkdir -p /workspace && cd /workspace && git clone https://github.com/you/lib && git clone https://github.com/you/app && cd lib && npm ci && npm link && cd ../app && npm ci && npm link your-lib && npm test`}
                network="semitrusted"
                onRun={(c, n) => { setCmd(c); setNetwork(n); }}
              />
              <ExampleCard
                title="System probe"
                desc="Inspect the sandbox environment: CPU, memory, disk, installed packages."
                command={`cat /proc/cpuinfo | head -20 && echo "---" && free -h && echo "---" && df -h && echo "---" && uname -a && echo "---" && cat /etc/os-release`}
                network="zerotrust"
                onRun={(c, n) => { setCmd(c); setNetwork(n); }}
              />
            </div>
          </div>

          {/* Tips */}
          <div className="bg-[var(--color-surface)] rounded border border-[var(--color-border)] p-4 space-y-2">
            <h3 className="text-sm font-bold text-[var(--color-muted)]">Tips</h3>
            <ul className="text-sm text-[var(--color-muted)] space-y-1 list-disc list-inside">
              <li><span className="text-[var(--color-foreground)]">semitrusted</span> mode gives network access via egress proxy &mdash; required for git clone/push, npm install, API calls</li>
              <li><span className="text-[var(--color-foreground)]">zero trust</span> mode has no network at all &mdash; good for pure compute, benchmarks, security audits on already-cloned code</li>
              <li>Each execution is ephemeral &mdash; the container is destroyed after your command finishes</li>
              <li>For persistent work, use <span className="text-[var(--color-foreground)]">Sessions</span> tab to create long-lived containers</li>
              <li>Chain commands with <span className="font-mono text-[var(--color-foreground)]">&&</span> &mdash; the whole pipeline runs in a single container</li>
              <li>Set <span className="font-mono text-[var(--color-foreground)]">ANTHROPIC_API_KEY</span> in your command to use Claude Code: <span className="font-mono text-xs">export ANTHROPIC_API_KEY=sk-ant-... && claude &quot;your prompt&quot;</span></li>
              <li>Git push requires auth &mdash; use <span className="font-mono text-xs">git clone https://TOKEN@github.com/you/repo</span> or configure SSH keys in the session</li>
            </ul>
          </div>
        </div>
      )}
    </div>
  );
}

function ExampleCard({ title, desc, command, network, onRun }: {
  title: string;
  desc: string;
  command: string;
  network: 'semitrusted' | 'zerotrust';
  onRun: (cmd: string, net: 'semitrusted' | 'zerotrust') => void;
}) {
  return (
    <div className="bg-[var(--color-surface)] rounded border border-[var(--color-border)] p-4 space-y-2 hover:border-[var(--color-accent)]/30 transition-colors">
      <div className="flex items-center justify-between">
        <h4 className="text-sm font-bold">{title}</h4>
        <span className={`text-xs px-1.5 py-0.5 rounded ${
          network === 'semitrusted' ? 'bg-[var(--color-accent)]/10 text-[var(--color-accent)]' : 'bg-yellow-400/10 text-yellow-400'
        }`}>
          {network}
        </span>
      </div>
      <p className="text-xs text-[var(--color-muted)]">{desc}</p>
      <pre className="text-xs font-mono text-[var(--color-muted)] bg-[var(--color-background)] rounded p-2 overflow-x-auto whitespace-pre-wrap break-all">{command}</pre>
      <button
        onClick={() => onRun(command, network)}
        className="text-xs text-[var(--color-accent)] hover:underline cursor-pointer"
      >
        Load into terminal
      </button>
    </div>
  );
}
