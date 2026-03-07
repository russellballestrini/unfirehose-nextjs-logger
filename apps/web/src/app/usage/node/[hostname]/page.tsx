'use client';

import { useParams } from 'next/navigation';
import useSWR from 'swr';
import Link from 'next/link';
import { useState, useEffect, useCallback, useRef } from 'react';

const fetcher = (url: string) => fetch(url).then(r => r.json());

const DEFAULT_KWH_RATE = 0.31;

/* eslint-disable @typescript-eslint/no-explicit-any */

// Convert basic ANSI escape codes to styled spans
function ansiToHtml(text: string): string {
  const colorMap: Record<string, string> = {
    '30': '#1e1e1e', '31': '#ef4444', '32': '#22c55e', '33': '#eab308',
    '34': '#60a5fa', '35': '#c084fc', '36': '#22d3ee', '37': '#d4d4d4',
    '90': '#737373', '91': '#f87171', '92': '#4ade80', '93': '#facc15',
    '94': '#93c5fd', '95': '#d8b4fe', '96': '#67e8f9', '97': '#ffffff',
  };
  const bgMap: Record<string, string> = {
    '40': '#1e1e1e', '41': '#991b1b', '42': '#166534', '43': '#854d0e',
    '44': '#1e3a5f', '45': '#581c87', '46': '#164e63', '47': '#404040',
  };
  let result = '';
  let fg = '', bg = '';
  let bold = false, dim = false;
  // eslint-disable-next-line no-control-regex
  const parts = text.split(/(\x1b\[[0-9;]*m)/);
  for (const part of parts) {
    // eslint-disable-next-line no-control-regex
    const match = part.match(/^\x1b\[([0-9;]*)m$/);
    if (match) {
      const codes = match[1].split(';').filter(Boolean);
      for (const code of codes) {
        if (code === '0') { fg = ''; bg = ''; bold = false; dim = false; }
        else if (code === '1') bold = true;
        else if (code === '2') dim = true;
        else if (code === '22') { bold = false; dim = false; }
        else if (colorMap[code]) fg = colorMap[code];
        else if (bgMap[code]) bg = bgMap[code];
        else if (code === '39') fg = '';
        else if (code === '49') bg = '';
      }
    } else if (part) {
      const escaped = part.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
      const styles: string[] = [];
      if (fg) styles.push(`color:${fg}`);
      if (bg) styles.push(`background:${bg}`);
      if (bold) styles.push('font-weight:bold');
      if (dim) styles.push('opacity:0.6');
      result += styles.length > 0 ? `<span style="${styles.join(';')}">${escaped}</span>` : escaped;
    }
  }
  return result;
}

const HARNESSES = [
  {
    id: 'claude-code', name: 'Claude Code',
    desc: 'Anthropic CLI for Claude — agentic coding in the terminal',
    install: 'npm install -g @anthropic-ai/claude-code',
    verify: 'claude --version',
    tags: ['ml', 'coding', 'cli'],
  },
  {
    id: 'open-code', name: 'Open Code',
    desc: 'Open source alternative to Claude Code — multi-provider',
    install: 'npm install -g opencode-ai',
    verify: 'opencode --version',
    requiresKey: 'ANTHROPIC_API_KEY or OPENAI_API_KEY', tags: ['ml', 'coding', 'cli'],
  },
  {
    id: 'aider', name: 'Aider',
    desc: 'ML pair programming in the terminal — many models',
    install: 'pip install aider-chat',
    verify: 'aider --version',
    requiresKey: 'ANTHROPIC_API_KEY or OPENAI_API_KEY', tags: ['ml', 'coding', 'python'],
  },
  {
    id: 'ollama', name: 'Ollama',
    desc: 'Run open source LLMs locally — llama, mistral, codellama',
    install: 'curl -fsSL https://ollama.com/install.sh | sh',
    verify: 'ollama --version',
    tags: ['ml', 'local', 'inference'],
  },
  {
    id: 'open-webui', name: 'Open WebUI',
    desc: 'Self-hosted ChatGPT-like interface for Ollama and OpenAI APIs',
    install: 'pip install open-webui',
    verify: 'open-webui --version',
    tags: ['ml', 'web', 'self-hosted'],
  },
  {
    id: 'uncloseai-cli', name: 'uncloseai-cli',
    desc: 'ReAct agent harness, microgpt, voxsplit — ML from seed on Unclose',
    install: 'pip install -r requirements.txt',
    verify: 'python -c "import uncloseai"',
    tags: ['ml', 'agent', 'python'],
  },
];

type BootStatus = { state: 'idle' } | { state: 'booting'; expectedSession?: string } | { state: 'success'; detail: any } | { state: 'error'; detail: string };

const TABS = ['Overview', 'Harnesses', 'Processes', 'Bootstrap', 'Settings'] as const;
type Tab = (typeof TABS)[number];

export default function NodeDetailPage() {
  const { hostname } = useParams<{ hostname: string }>();
  const host = decodeURIComponent(hostname);
  const [activeTab, setActiveTabRaw] = useState<Tab>(() => {
    if (typeof window !== 'undefined') {
      const hash = window.location.hash.slice(1);
      if (TABS.includes(hash as Tab)) return hash as Tab;
    }
    return 'Overview';
  });
  const setActiveTab = (tab: Tab) => {
    setActiveTabRaw(tab);
    window.location.hash = tab;
  };

  const { data: mesh } = useSWR('/api/mesh', fetcher, { refreshInterval: 10000 });
  const { data: probe, isLoading: probeLoading } = useSWR(
    `/api/mesh/node?host=${encodeURIComponent(host)}`,
    fetcher,
    { refreshInterval: 30000 },
  );
  const { data: settings } = useSWR('/api/settings', fetcher, { revalidateOnFocus: false });
  const { data: sshConfig, mutate: mutateSsh } = useSWR('/api/ssh-config', fetcher, { revalidateOnFocus: false });
  const { data: tmuxData } = useSWR(
    activeTab === 'Harnesses' ? '/api/tmux/stream' : null,
    fetcher,
    { refreshInterval: 5000 },
  );

  // Per-node tunables
  const [kwhRate, setKwhRate] = useState(DEFAULT_KWH_RATE);
  const [ispCost, setIspCost] = useState(0);
  const [diskOverride, setDiskOverride] = useState<number | undefined>();
  const [wattsOverride, setWattsOverride] = useState<number | undefined>();

  useEffect(() => {
    if (!settings) return;
    const r = settings[`electricity_rate_${host}`];
    const i = settings[`isp_cost_${host}`];
    const d = settings[`disk_override_${host}`];
    const w = settings[`watts_override_${host}`];
    if (r) setKwhRate(parseFloat(r) || DEFAULT_KWH_RATE);
    if (i) setIspCost(parseFloat(i) || 0);
    if (d) setDiskOverride(parseInt(d) || undefined);
    if (w) setWattsOverride(parseFloat(w) || undefined);
  }, [settings, host]);

  // Determine the SSH host to use for booting (localhost if this is the local machine)
  const isLocal = mesh?.localHostname === host || host === 'localhost';
  const bootHost = isLocal ? 'localhost' : host;

  // Bootstrap harness state
  const [bootStatuses, setBootStatuses] = useState<Record<string, BootStatus>>({});
  const [bootFilter, setBootFilter] = useState('');
  // Harness preview state
  const [previewSession, setPreviewSession] = useState<string | null>(null);
  const [previewContent, setPreviewContent] = useState('');
  const previewRef = useRef<HTMLPreElement>(null);

  // SSE connection for inline tmux preview (local or remote via SSH)
  useEffect(() => {
    if (!previewSession) return;
    let alive = true;
    let es: EventSource;
    const hostParam = !isLocal ? `&host=${encodeURIComponent(host)}` : '';
    const connect = () => {
      es = new EventSource(`/api/tmux/stream?session=${encodeURIComponent(previewSession)}${hostParam}`);
      es.onmessage = (e) => {
        try {
          setPreviewContent(JSON.parse(e.data));
          if (previewRef.current) {
            previewRef.current.scrollTop = previewRef.current.scrollHeight;
          }
        } catch { /* skip */ }
      };
      es.onerror = () => {
        es.close();
        if (alive) setTimeout(connect, 2000);
      };
    };
    connect();
    return () => { alive = false; es?.close(); };
  }, [previewSession, isLocal, host]);

  const [sshEditing, setSshEditing] = useState(false);
  const [sshForm, setSshForm] = useState<{ name: string; hostname?: string; port?: string; user?: string; identityFile?: string; forwardAgent?: string }>({ name: host });
  const [sshSaving, setSshSaving] = useState(false);

  // Hydrate SSH form from config
  useEffect(() => {
    if (!sshConfig?.hosts) return;
    const found = sshConfig.hosts.find((h: any) => h.name === host || h.hostname === host);
    if (found) setSshForm(found);
  }, [sshConfig, host]);

  const saveSshHost = async () => {
    setSshSaving(true);
    try {
      await fetch('/api/ssh-config', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(sshForm),
      });
      await mutateSsh();
      setSshEditing(false);
    } catch { /* ignore */ }
    setSshSaving(false);
  };

  const bootHarness = useCallback(async (harness: typeof HARNESSES[0]) => {
    const repoName = harness.repo.split('/').pop()?.replace('.git', '') ?? harness.id;
    setBootStatuses(prev => ({ ...prev, [harness.id]: { state: 'booting', expectedSession: repoName } }));
    // Immediately switch to Harnesses tab so user sees the booting indicator
    setActiveTab('Harnesses');
    try {
      const projectPath = `~/git/${repoName}`;
      const runCmd = harness.run;

      let harnessCmd: string;
      if (harness.install.startsWith('git clone')) {
        harnessCmd = `bash -lc "if [ ! -d ~/git/${repoName} ]; then mkdir -p ~/git && cd ~/git && git clone '${harness.repo}'; fi && cd ~/git/${repoName} && ${runCmd}"`;
      } else {
        harnessCmd = `bash -lc "${harness.install} && mkdir -p ~/git/${repoName} && cd ~/git/${repoName} && ${runCmd}"`;
      }

      const res = await fetch('/api/boot', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ projectPath, harness: harnessCmd, host: bootHost, projectName: repoName, bootstrap: true }),
      });
      const data = await res.json();
      if (data.success) {
        setBootStatuses(prev => ({ ...prev, [harness.id]: { state: 'success', detail: data } }));
        // Switch to Harnesses tab and start previewing the tmux session
        if (data.tmuxSession) {
          setActiveTab('Harnesses');
          setPreviewSession(data.tmuxSession);
        }
      } else {
        setBootStatuses(prev => ({ ...prev, [harness.id]: { state: 'error', detail: data.error || 'Unknown error' } }));
      }
    } catch (err) {
      setBootStatuses(prev => ({ ...prev, [harness.id]: { state: 'error', detail: String(err) } }));
    }
  }, [bootHost]);

  useEffect(() => {
    if (!settings) return;
    if (settings[`electricity_rate_${host}`]) setKwhRate(parseFloat(settings[`electricity_rate_${host}`]) || DEFAULT_KWH_RATE);
    if (settings[`isp_cost_${host}`]) setIspCost(parseFloat(settings[`isp_cost_${host}`]) || 0);
    if (settings[`disk_override_${host}`]) setDiskOverride(parseInt(settings[`disk_override_${host}`]) || 0);
    if (settings[`watts_override_${host}`]) setWattsOverride(parseFloat(settings[`watts_override_${host}`]) || 0);
  }, [settings, host]);

  const saveSetting = (key: string, value: string) => {
    fetch('/api/settings', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'set', key, value }),
    });
  };

  // Find this node in mesh data
  const node = mesh?.nodes?.find((n: any) => n.hostname === host);

  // Power calculation
  let systemWatts = wattsOverride || node?.powerWatts || 0;
  if (!wattsOverride && diskOverride !== undefined && node) {
    const extraDisks = Math.max(0, diskOverride - (node.spinningDisks ?? 0));
    systemWatts += extraDisks * 8;
  }
  const gpuWatts = node?.gpuPowerWatts ?? 0;
  const totalWatts = systemWatts + gpuWatts;
  const kwhPerMonth = (totalWatts * 24 * 30) / 1000;
  const elecPerMonth = kwhPerMonth * kwhRate;
  const totalPerMonth = elecPerMonth + ispCost;

  const sys = probe?.system;
  const mem = probe?.memory;
  const loadPerCore = sys?.cpuCores > 0 && probe?.loadAvg ? probe.loadAvg[0] / sys.cpuCores : 0;
  const memPct = mem ? ((mem.totalGB - mem.availableGB) / mem.totalGB) * 100 : 0;

  return (
    <div className="p-6 w-full">
      {/* Breadcrumb */}
      <div className="flex items-center gap-2 text-sm text-[var(--color-muted)] mb-4">
        <Link href="/usage" className="hover:text-[var(--color-foreground)]">Usage</Link>
        <span>/</span>
        <span className="text-[var(--color-foreground)]">{host}</span>
      </div>

      {/* Header */}
      <div className="flex items-center gap-3 mb-6">
        <span className={`w-3 h-3 rounded-full ${node?.reachable ? 'bg-[var(--color-accent)] animate-pulse' : 'bg-[var(--color-error)]'}`} />
        <h1 className="text-2xl font-bold">{host}</h1>
        {node && (
          <span className="text-sm text-[var(--color-muted)]">
            up {node.uptime} &middot; {node.claudeProcesses} claudes
          </span>
        )}
      </div>

      {/* Cost hero */}
      {node && (
        <div className="bg-[var(--color-surface)] rounded border border-[var(--color-border)] p-4 mb-6">
          <div className="flex items-baseline gap-6 flex-wrap">
            <div>
              <span className="text-3xl font-bold text-[var(--color-accent)]">${totalPerMonth.toFixed(0)}</span>
              <span className="text-sm text-[var(--color-muted)]">/mo total</span>
            </div>
            <div className="text-sm text-[var(--color-muted)]">
              {systemWatts.toFixed(0)}W sys
              {gpuWatts > 0 && <> + {gpuWatts.toFixed(0)}W gpu</>}
              {' = '}{totalWatts.toFixed(0)}W
              {' '}
              <span className={`text-[10px] ${wattsOverride ? 'text-yellow-400' : 'text-[var(--color-accent)]'}`}>
                [{wattsOverride ? 'override' : node.powerSource ?? 'n/a'}
                {!wattsOverride && node.cpuTdpWatts && ` ${node.cpuTdpWatts}W`}]
              </span>
              {gpuWatts > 0 && <span className="text-[10px] text-green-400"> [gpu nvidia-smi]</span>}
            </div>
            <div className="text-sm text-[var(--color-muted)]">
              {kwhPerMonth.toFixed(1)} kWh/mo &middot; ${elecPerMonth.toFixed(0)} elec &middot; ${ispCost.toFixed(0)} isp
            </div>
          </div>
        </div>
      )}

      {/* Tabs */}
      <div className="flex gap-1 mb-6 border-b border-[var(--color-border)]">
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
          </button>
        ))}
      </div>

      {/* ===== OVERVIEW TAB ===== */}
      {activeTab === 'Overview' && (
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
          <div className="space-y-6">
            <Section title="System">
              {sys ? (
                <div className="grid grid-cols-2 gap-x-6 gap-y-2 text-sm">
                  <KV label="CPU" value={sys.cpuModel?.replace(/\(R\)|\(TM\)/g, '').replace(/CPU\s+/i, '').trim()} />
                  <KV label="Cores" value={`${sys.cpuCores}${sys.cpuMhz ? ` @ ${Math.round(sys.cpuMhz)}MHz` : ''}`} />
                  <KV label="Architecture" value={sys.arch} />
                  <KV label="Kernel" value={sys.kernel} />
                  <KV label="OS" value={sys.os} />
                  <KV label="Cache" value={sys.cpuCache} />
                  {node?.cpuModel && <KV label="TDP" value={node.cpuTdpWatts ? `${node.cpuTdpWatts}W` : 'unknown'} />}
                </div>
              ) : probeLoading ? (
                <div className="text-sm text-[var(--color-muted)] animate-pulse">Probing...</div>
              ) : (
                <div className="text-sm text-[var(--color-error)]">{probe?.error ?? 'Probe failed'}</div>
              )}
            </Section>

            {probe?.loadAvg && (
              <Section title="CPU Load">
                <div className="space-y-2">
                  <div className="flex justify-between text-sm text-[var(--color-muted)]">
                    <span>Load: {probe.loadAvg[0].toFixed(2)} / {probe.loadAvg[1].toFixed(2)} / {probe.loadAvg[2].toFixed(2)}</span>
                    <span>{probe.runnable}</span>
                  </div>
                  <Bar pct={Math.min(loadPerCore * 100, 100)} color={loadPerCore > 2 ? 'var(--color-error)' : '#f97316'} />
                  <div className="text-xs text-[var(--color-muted)]">
                    {(loadPerCore * 100).toFixed(0)}% per-core utilization
                  </div>
                </div>
              </Section>
            )}

            {mem && (
              <Section title="Memory">
                <div className="space-y-2">
                  <div className="flex justify-between text-sm text-[var(--color-muted)]">
                    <span>{mem.usedGB.toFixed(1)}GB / {mem.totalGB.toFixed(1)}GB ({memPct.toFixed(0)}%)</span>
                    <span>{mem.availableGB.toFixed(1)}G available</span>
                  </div>
                  <Bar pct={memPct} color={memPct > 85 ? 'var(--color-error)' : '#60a5fa'} />
                  <div className="flex gap-4 text-xs text-[var(--color-muted)] flex-wrap">
                    <span>buffers: {mem.buffersGB}G</span>
                    <span>cached: {mem.cachedGB}G</span>
                    <span>shmem: {mem.shmemGB}G</span>
                    {mem.dirtyMB > 0 && <span className="text-[var(--color-error)]">dirty: {mem.dirtyMB}MB</span>}
                  </div>
                  {mem.swapTotalGB > 0 && (
                    <div className="text-xs text-[var(--color-muted)]">
                      Swap: {mem.swapUsedGB}GB / {mem.swapTotalGB}GB
                      {mem.swapUsedGB > 0.1 && (
                        <span className="text-[var(--color-error)]"> ({((mem.swapUsedGB / mem.swapTotalGB) * 100).toFixed(0)}%)</span>
                      )}
                    </div>
                  )}
                </div>
              </Section>
            )}

            {probe?.temperatures?.length > 0 && (
              <Section title="Thermal Zones">
                <div className="flex flex-wrap gap-3">
                  {probe.temperatures.map((t: any) => (
                    <div key={t.zone} className="text-sm">
                      <span className="text-[var(--color-muted)]">{t.zone}</span>{' '}
                      <span className={t.tempC > 80 ? 'text-[var(--color-error)] font-bold' : t.tempC > 60 ? 'text-[#f97316]' : 'text-[var(--color-foreground)]'}>
                        {t.tempC}°C
                      </span>
                    </div>
                  ))}
                </div>
              </Section>
            )}
          </div>

          <div className="space-y-6">
            {probe?.disk?.length > 0 && (
              <Section title="Disk">
                <div className="space-y-2">
                  {probe.disk.filter((d: any) => !d.device.startsWith('tmpfs')).map((d: any) => (
                    <div key={d.mount} className="space-y-1">
                      <div className="flex justify-between text-xs text-[var(--color-muted)]">
                        <span className="font-mono">{d.device}</span>
                        <span>{d.mount} &middot; {d.used}/{d.size} ({d.usePct}%)</span>
                      </div>
                      <Bar pct={d.usePct} color={d.usePct > 90 ? 'var(--color-error)' : d.usePct > 75 ? '#f97316' : '#22c55e'} />
                    </div>
                  ))}
                </div>
              </Section>
            )}

            {probe?.gpu?.hasGpu && (
              <Section title="GPU">
                {probe.gpu.nvidia?.map((g: any, i: number) => (
                  <div key={i} className="text-sm space-y-1 mb-2">
                    <div className="font-bold">{g.name}</div>
                    <div className="flex gap-4 text-[var(--color-muted)]">
                      <span>{g.memUsed}/{g.memTotal} mem</span>
                      <span>{g.utilization}% util</span>
                      <span>{g.temp}°C</span>
                      <span>{g.power}W</span>
                    </div>
                  </div>
                ))}
              </Section>
            )}

            {probe?.network?.interfaces?.length > 0 && (
              <Section title="Network">
                <div className="space-y-1">
                  {probe.network.interfaces
                    .filter((i: any) => i.state === 'UP' && !i.name.startsWith('lo') && !i.name.startsWith('veth'))
                    .map((iface: any) => (
                    <div key={iface.name} className="flex items-center gap-3 text-sm">
                      <span className="w-2 h-2 rounded-full bg-green-500" />
                      <span className="font-mono">{iface.name}</span>
                      <span className="text-[var(--color-muted)] text-xs">{iface.addrs}</span>
                    </div>
                  ))}
                </div>
              </Section>
            )}

            {probe?.containers?.length > 0 && (
              <Section title={`Containers (${probe.containers.length})`}>
                <div className="space-y-2">
                  {probe.containers.map((c: any) => (
                    <div key={c.id} className="text-sm">
                      <div className="flex items-center gap-2">
                        <span className="font-bold">{c.name}</span>
                        <span className="text-xs text-[var(--color-muted)]">{c.status}</span>
                      </div>
                      <div className="text-xs text-[var(--color-muted)]">{c.image}</div>
                      {c.ports && <div className="text-xs text-[var(--color-muted)] font-mono">{c.ports}</div>}
                    </div>
                  ))}
                </div>
              </Section>
            )}
          </div>
        </div>
      )}

      {/* ===== HARNESSES TAB ===== */}
      {activeTab === 'Harnesses' && (() => {
        // Combine tmux sessions from probe (remote) and local tmux API
        const probeSessions: any[] = probe?.sessions?.tmux ?? [];
        const localSessions: string[] = isLocal ? (tmuxData?.sessions ?? []) : [];
        const sessions: any[] = isLocal
          ? localSessions.map(s => ({ name: s }))
          : probeSessions;

        // Booting entries that aren't yet in the sessions list
        const bootingEntries = Object.entries(bootStatuses)
          .filter(([, s]) => s.state === 'booting' && (s as any).expectedSession)
          .map(([id, s]) => ({ name: (s as any).expectedSession, booting: true, harnessId: id }))
          .filter(b => !sessions.some(s => s.name === b.name));

        const allEntries = [...bootingEntries, ...sessions];

        return (
          <div className="space-y-4">
            {allEntries.length === 0 && (
              <div className="text-sm text-[var(--color-muted)] text-center py-8 bg-[var(--color-surface)] rounded border border-[var(--color-border)]">
                No tmux sessions running on {host}. Boot a harness from the Bootstrap tab.
              </div>
            )}

            <div className="grid grid-cols-1 gap-3">
              {allEntries.map(s => {
                const isBooting = s.booting;
                const isActive = previewSession === s.name;
                const canPreview = !isBooting;

                return (
                  <div
                    key={s.name}
                    onClick={() => canPreview && setPreviewSession(isActive ? null : s.name)}
                    className={`bg-[var(--color-surface)] rounded border p-4 transition-colors ${
                      isBooting ? 'border-yellow-500/50 bg-yellow-500/5' :
                      isActive ? 'border-[var(--color-accent)]' :
                      'border-[var(--color-border)] hover:border-[var(--color-accent)]/50'
                    } ${canPreview ? 'cursor-pointer' : ''}`}
                  >
                    <div className="flex items-center justify-between">
                      <div className="flex items-center gap-2">
                        {isBooting ? (
                          <span className="w-2 h-2 rounded-full bg-yellow-400 animate-pulse" />
                        ) : (
                          <span className="w-2 h-2 rounded-full bg-green-400 animate-pulse" />
                        )}
                        <span className="font-bold font-mono text-sm">{s.name}</span>
                        {isBooting && (
                          <span className="text-xs text-yellow-400 animate-pulse">bootstrapping...</span>
                        )}
                        {s.windows && (
                          <span className="text-xs text-[var(--color-muted)]">({s.windows} windows)</span>
                        )}
                      </div>
                      <div className="flex items-center gap-2" onClick={(e) => e.stopPropagation()}>
                        {isLocal && !isBooting && (
                          <Link
                            href={`/tmux/${encodeURIComponent(s.name)}`}
                            className="text-xs px-2 py-1 rounded bg-[var(--color-accent)] text-[var(--color-background)] font-bold hover:opacity-90 transition-opacity"
                          >
                            Full View
                          </Link>
                        )}
                        {!isLocal && !isBooting && (
                          <>
                            <Link
                              href={`/tmux/${encodeURIComponent(s.name)}?host=${encodeURIComponent(host)}`}
                              className="text-xs px-2 py-1 rounded bg-[var(--color-accent)] text-[var(--color-background)] font-bold hover:opacity-90 transition-opacity"
                            >
                              Watch
                            </Link>
                            <span className="text-xs text-[var(--color-muted)] font-mono">
                              ssh {host} -t tmux attach -t {s.name}
                            </span>
                          </>
                        )}
                      </div>
                    </div>

                    {/* Inline preview — shown when card is clicked */}
                    {isActive && (
                      <pre
                        ref={previewRef}
                        onClick={(e) => e.stopPropagation()}
                        className="mt-3 bg-[#0d0d0d] rounded border border-[var(--color-border)] p-3 overflow-auto max-h-[60vh] font-mono text-xs leading-relaxed text-[#d4d4d4] whitespace-pre"
                        dangerouslySetInnerHTML={{ __html: previewContent ? ansiToHtml(previewContent) : 'Connecting...' }}
                      />
                    )}
                  </div>
                );
              })}
            </div>

            {allEntries.length > 0 && !allEntries.some(s => s.booting) && (
              <p className="text-xs text-[var(--color-muted)]">
                Click a session to preview live output. {isLocal ? 'Full View' : 'Watch'} opens the terminal viewer.
              </p>
            )}
          </div>
        );
      })()}

      {/* ===== PROCESSES TAB ===== */}
      {activeTab === 'Processes' && (
        <div className="space-y-6">
          {(probe?.sessions?.tmux?.length > 0 || probe?.sessions?.screen?.length > 0) && (
            <Section title="Sessions">
              {probe.sessions.tmux?.map((s: any) => (
                <div key={s.name} className="text-sm">
                  <span className="font-mono">tmux: {s.name}</span>
                  <span className="text-xs text-[var(--color-muted)]"> ({s.windows} windows)</span>
                </div>
              ))}
              {probe.sessions.screen?.map((s: any) => (
                <div key={s.name} className="text-sm">
                  <span className="font-mono">screen: {s.name}</span>
                </div>
              ))}
            </Section>
          )}

          {probe?.processes?.length > 0 ? (
            <Section title={`Top Processes (${probe.claudeProcesses ?? 0} claudes)`}>
              <div className="overflow-x-auto">
                <table className="w-full text-xs">
                  <thead>
                    <tr className="text-[var(--color-muted)] text-left">
                      <th className="pb-1 pr-3">USER</th>
                      <th className="pb-1 pr-3 text-right">CPU%</th>
                      <th className="pb-1 pr-3 text-right">MEM%</th>
                      <th className="pb-1 pr-3 text-right">RSS</th>
                      <th className="pb-1">COMMAND</th>
                    </tr>
                  </thead>
                  <tbody>
                    {probe.processes.slice(0, 40).map((p: any, i: number) => (
                      <tr key={i} className="border-t border-[var(--color-border)]">
                        <td className="py-0.5 pr-3 text-[var(--color-muted)]">{p.user}</td>
                        <td className={`py-0.5 pr-3 text-right ${parseFloat(p.cpu) > 50 ? 'text-[var(--color-error)]' : ''}`}>{p.cpu}</td>
                        <td className="py-0.5 pr-3 text-right">{p.mem}</td>
                        <td className="py-0.5 pr-3 text-right text-[var(--color-muted)]">{p.rss}</td>
                        <td className="py-0.5 font-mono truncate max-w-[500px]">{p.command}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </Section>
          ) : (
            <div className="text-sm text-[var(--color-muted)]">No process data available.</div>
          )}
        </div>
      )}

      {/* ===== BOOTSTRAP TAB ===== */}
      {activeTab === 'Bootstrap' && (
        <div>
          <div className="flex items-center justify-between mb-4">
            <span className="text-sm text-[var(--color-muted)]">target: <span className="font-mono text-[var(--color-foreground)]">{bootHost}</span></span>
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
              const status = bootStatuses[h.id] ?? { state: 'idle' };
              return (
                <div
                  key={h.id}
                  className={`rounded border p-3 space-y-2 ${
                    status.state === 'success' ? 'border-[var(--color-accent)] bg-[var(--color-accent)]/5'
                    : status.state === 'error' ? 'border-[var(--color-error)] bg-red-950/20'
                    : 'border-[var(--color-border)] bg-[var(--color-background)]'
                  }`}
                >
                  <div className="flex items-center justify-between">
                    <span className="text-sm font-bold">{h.name}</span>
                    <div className="flex gap-1">
                      {h.tags.slice(0, 2).map(t => (
                        <span key={t} className="text-[10px] px-1 py-0.5 rounded bg-[var(--color-surface)] text-[var(--color-muted)]">{t}</span>
                      ))}
                    </div>
                  </div>
                  <p className="text-xs text-[var(--color-muted)]">{h.desc}</p>
                  <div className="text-[10px] text-[var(--color-muted)] font-mono space-y-0.5">
                    <div className="truncate">$ {h.install}</div>
                    <div className="truncate">$ {h.run}</div>
                    {h.requiresKey && <div className="text-yellow-500/80">requires: {h.requiresKey}</div>}
                  </div>

                  <div className="flex items-center gap-2">
                    <button
                      onClick={() => bootHarness(h)}
                      disabled={status.state === 'booting'}
                      className="bg-[var(--color-accent)] text-black px-2.5 py-0.5 rounded text-xs font-bold disabled:opacity-50 cursor-pointer"
                    >
                      {status.state === 'booting' ? 'Booting...' : status.state === 'success' ? 'Boot Again' : 'Boot'}
                    </button>
                    <a href={h.repo} target="_blank" rel="noopener noreferrer"
                      className="text-xs text-[var(--color-muted)] hover:text-[var(--color-foreground)]">
                      repo
                    </a>
                    {status.state === 'success' && (
                      <span className="text-xs text-[var(--color-accent)] font-mono ml-auto truncate max-w-40">{status.detail.command}</span>
                    )}
                    {status.state === 'error' && (
                      <span className="text-xs text-[var(--color-error)] ml-auto truncate max-w-40">{status.detail}</span>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
          <p className="text-xs text-[var(--color-muted)] mt-3">
            Bootstraps into ~/git/ on {bootHost}. Uses tmux for session management.
            {!isLocal && ' Requires SSH key access.'}
          </p>
        </div>
      )}

      {/* ===== SETTINGS TAB ===== */}
      {activeTab === 'Settings' && (
        <div className="max-w-lg">
          <Section title="Cost Tunables">
            <div className="space-y-3">
              <TunableRow label="Electricity rate" unit="$/kWh" step={0.01}
                value={kwhRate}
                onChange={(v) => { setKwhRate(v); saveSetting(`electricity_rate_${host}`, String(v)); }}
              />
              <TunableRow label="ISP cost" unit="$/mo" step={1}
                value={ispCost}
                onChange={(v) => { setIspCost(v); saveSetting(`isp_cost_${host}`, String(v)); }}
              />
              <TunableRow label="Spinning disks" unit="HDDs" step={1}
                value={diskOverride ?? ''}
                placeholder={String(node?.spinningDisks ?? 0)}
                onChange={(v) => { setDiskOverride(v || undefined); saveSetting(`disk_override_${host}`, String(v)); }}
              />
              <TunableRow label="Watts override" unit="W" step={1}
                value={wattsOverride ?? ''}
                placeholder="auto"
                onChange={(v) => { setWattsOverride(v || undefined); saveSetting(`watts_override_${host}`, String(v)); }}
              />
              <div className="text-xs text-[var(--color-muted)] pt-1">
                Auto-detected: {node?.spinningDisks ?? '?'} HDDs, {node?.ssdCount ?? '?'} SSDs via lsblk
                {node?.cpuTdpWatts && <> &middot; {node.cpuTdpWatts}W CPU TDP</>}
              </div>
            </div>
          </Section>

          <Section title="SSH Configuration">
            {!sshEditing ? (
              <div className="space-y-2">
                <div className="grid grid-cols-2 gap-x-6 gap-y-1 text-sm">
                  <KV label="Host" value={sshForm.name} />
                  <KV label="Hostname" value={sshForm.hostname || host} />
                  <KV label="Port" value={sshForm.port || '22'} />
                  <KV label="User" value={sshForm.user || '(default)'} />
                  <KV label="Identity File" value={sshForm.identityFile || '(default)'} />
                  <KV label="Forward Agent" value={sshForm.forwardAgent || 'no'} />
                </div>
                <button
                  onClick={() => setSshEditing(true)}
                  className="text-xs text-[var(--color-accent)] hover:underline cursor-pointer mt-2"
                >
                  Edit SSH Config
                </button>
              </div>
            ) : (
              <div className="space-y-3">
                <SshField label="Host (alias)" value={sshForm.name}
                  onChange={(v) => setSshForm(f => ({ ...f, name: v }))} />
                <SshField label="Hostname" value={sshForm.hostname ?? ''} placeholder={host}
                  onChange={(v) => setSshForm(f => ({ ...f, hostname: v || undefined }))} />
                <SshField label="Port" value={sshForm.port ?? ''} placeholder="22"
                  onChange={(v) => setSshForm(f => ({ ...f, port: v || undefined }))} />
                <SshField label="User" value={sshForm.user ?? ''} placeholder="(default)"
                  onChange={(v) => setSshForm(f => ({ ...f, user: v || undefined }))} />
                <SshField label="Identity File" value={sshForm.identityFile ?? ''} placeholder="~/.ssh/id_rsa"
                  onChange={(v) => setSshForm(f => ({ ...f, identityFile: v || undefined }))} />
                <div className="flex items-center gap-2">
                  <span className="text-sm text-[var(--color-muted)] w-32">Forward Agent</span>
                  <label className="flex items-center gap-2 text-sm cursor-pointer">
                    <input
                      type="checkbox"
                      checked={sshForm.forwardAgent === 'yes'}
                      onChange={(e) => setSshForm(f => ({ ...f, forwardAgent: e.target.checked ? 'yes' : undefined }))}
                      className="accent-[var(--color-accent)]"
                    />
                    <span className="text-[var(--color-muted)]">yes</span>
                  </label>
                </div>
                <div className="flex gap-2 pt-1">
                  <button
                    onClick={saveSshHost}
                    disabled={sshSaving || !sshForm.name.trim()}
                    className="px-4 py-1.5 text-sm font-bold bg-[var(--color-accent)] text-[var(--color-background)] rounded hover:opacity-90 disabled:opacity-40 cursor-pointer"
                  >
                    {sshSaving ? 'Saving...' : 'Save'}
                  </button>
                  <button
                    onClick={() => setSshEditing(false)}
                    className="px-4 py-1.5 text-sm text-[var(--color-muted)] hover:text-[var(--color-foreground)] cursor-pointer"
                  >
                    Cancel
                  </button>
                </div>
              </div>
            )}
          </Section>
        </div>
      )}
    </div>
  );
}

function Section({ title, children }: { title: string | React.ReactNode; children: React.ReactNode }) {
  return (
    <div className="bg-[var(--color-surface)] rounded border border-[var(--color-border)] p-4">
      <h3 className="text-sm font-bold text-[var(--color-muted)] mb-3">{title}</h3>
      {children}
    </div>
  );
}

function Bar({ pct, color }: { pct: number; color: string }) {
  return (
    <div className="h-2 rounded bg-[var(--color-background)] overflow-hidden">
      <div className="h-full rounded" style={{ width: `${Math.min(pct, 100)}%`, background: color }} />
    </div>
  );
}

function KV({ label, value }: { label: string; value?: string | number | null }) {
  return (
    <div>
      <span className="text-[var(--color-muted)]">{label}: </span>
      <span>{value ?? 'n/a'}</span>
    </div>
  );
}

function SshField({ label, value, placeholder, onChange }: {
  label: string;
  value: string;
  placeholder?: string;
  onChange: (v: string) => void;
}) {
  return (
    <div className="flex items-center gap-2">
      <span className="text-sm text-[var(--color-muted)] w-32 shrink-0">{label}</span>
      <input
        type="text"
        value={value}
        placeholder={placeholder}
        onChange={(e) => onChange(e.target.value)}
        className="flex-1 text-sm bg-[var(--color-background)] border border-[var(--color-border)] rounded px-2 py-1 font-mono"
      />
    </div>
  );
}

function TunableRow({ label, unit, step, value, placeholder, onChange }: {
  label: string;
  unit: string;
  step: number;
  value: number | string;
  placeholder?: string;
  onChange: (v: number) => void;
}) {
  return (
    <div className="flex items-center justify-between gap-4">
      <span className="text-sm text-[var(--color-muted)]">{label}</span>
      <div className="flex items-center gap-1">
        <input
          type="number"
          step={step}
          min={0}
          value={value}
          placeholder={placeholder}
          onChange={(e) => onChange(parseFloat(e.target.value) || 0)}
          className="w-20 text-sm bg-[var(--color-background)] border border-[var(--color-border)] rounded px-2 py-1 font-mono text-right"
        />
        <span className="text-xs text-[var(--color-muted)] w-12">{unit}</span>
      </div>
    </div>
  );
}
