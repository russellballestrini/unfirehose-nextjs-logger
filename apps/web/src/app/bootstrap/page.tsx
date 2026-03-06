'use client';

import { useState, useCallback } from 'react';
import useSWR from 'swr';
import { PageContext } from '@unfirehose/ui/PageContext';

/* eslint-disable @typescript-eslint/no-explicit-any */

const fetcher = (url: string) => fetch(url).then((r) => r.json());

// Open source harnesses and tools that can run models
const HARNESSES = [
  {
    id: 'claude-code',
    name: 'Claude Code',
    desc: 'Anthropic CLI for Claude — agentic coding in the terminal. Supports API key or OAuth2 (Max plan)',
    repo: 'https://github.com/anthropics/claude-code',
    install: 'npm install -g @anthropic-ai/claude-code',
    run: 'claude',
    tags: ['ml', 'coding', 'cli'],
    authModes: ['oauth2', 'api-key'] as const,
  },
  {
    id: 'open-code',
    name: 'Open Code',
    desc: 'Open source alternative to Claude Code — multi-provider support',
    repo: 'https://github.com/nicepkg/opencode',
    install: 'npm install -g opencode-ai',
    run: 'opencode',
    requiresKey: 'ANTHROPIC_API_KEY or OPENAI_API_KEY',
    tags: ['ml', 'coding', 'cli', 'multi-provider'],
  },
  {
    id: 'aider',
    name: 'Aider',
    desc: 'ML pair programming in the terminal — works with many models',
    repo: 'https://github.com/paul-gauthier/aider',
    install: 'pip install aider-chat',
    run: 'aider',
    requiresKey: 'ANTHROPIC_API_KEY or OPENAI_API_KEY',
    tags: ['ml', 'coding', 'python', 'multi-provider'],
  },
  {
    id: 'ollama',
    name: 'Ollama',
    desc: 'Run open source LLMs locally — llama, mistral, codellama, etc.',
    repo: 'https://github.com/ollama/ollama',
    install: 'curl -fsSL https://ollama.com/install.sh | sh',
    run: 'ollama serve',
    tags: ['ml', 'local', 'inference', 'self-hosted'],
  },
  {
    id: 'open-webui',
    name: 'Open WebUI',
    desc: 'Self-hosted ChatGPT-like interface for Ollama and OpenAI-compatible APIs',
    repo: 'https://github.com/open-webui/open-webui',
    install: 'pip install open-webui',
    run: 'open-webui serve',
    tags: ['ml', 'web', 'self-hosted', 'ui'],
  },
  {
    id: 'uri2png',
    name: 'uri2png',
    desc: 'Screenshot service — render any URL to PNG via headless browser',
    repo: 'https://github.com/nicholasgasior/uri2png',
    install: 'git clone && docker compose up -d',
    run: 'docker compose up -d',
    tags: ['service', 'screenshot', 'docker'],
  },
  {
    id: 'uncloseai-cli',
    name: 'uncloseai-cli',
    desc: 'ReAct agent harness, microgpt, voxsplit — ML from seed on Unclose (Llama 3.1 8B)',
    repo: 'ssh://git@git.unturf.com:2222/engineering/unturf/uncloseai-cli.git',
    install: 'pip install -r requirements.txt',
    run: 'python uncloseai-cli.py',
    tags: ['ml', 'agent', 'python', 'self-hosted'],
  },
  {
    id: 'llama-cpp',
    name: 'llama.cpp',
    desc: 'LLM inference in C/C++ — run GGUF models on CPU or GPU',
    repo: 'https://github.com/ggerganov/llama.cpp',
    install: 'git clone && make -j',
    run: './llama-server -m model.gguf',
    tags: ['ml', 'local', 'inference', 'c++'],
  },
  {
    id: 'vllm',
    name: 'vLLM',
    desc: 'High-throughput LLM serving engine — PagedAttention, continuous batching',
    repo: 'https://github.com/vllm-project/vllm',
    install: 'pip install vllm',
    run: 'vllm serve',
    requiresKey: 'GPU recommended',
    tags: ['ml', 'serving', 'gpu', 'python'],
  },
  {
    id: 'text-generation-webui',
    name: 'text-generation-webui',
    desc: 'Gradio web UI for running large language models — oobabooga',
    repo: 'https://github.com/oobabooga/text-generation-webui',
    install: 'git clone && ./start_linux.sh',
    run: './start_linux.sh',
    tags: ['ml', 'web', 'ui', 'self-hosted'],
  },
];

type BootStatus = { state: 'idle' } | { state: 'booting' } | { state: 'success'; detail: any } | { state: 'error'; detail: string };

export default function BootstrapPage() {
  const { data: sshConfig } = useSWR('/api/ssh-config', fetcher, { revalidateOnFocus: false });
  const { data: mesh } = useSWR('/api/mesh', fetcher, { refreshInterval: 30000 });
  const [filter, setFilter] = useState('');
  const [selectedHost, setSelectedHost] = useState('localhost');
  const [statuses, setStatuses] = useState<Record<string, BootStatus>>({});
  const [authModes, setAuthModes] = useState<Record<string, string>>({});

  // Build host list: localhost + SSH config hosts + mesh nodes
  const hosts: { name: string; status?: string }[] = [{ name: 'localhost', status: 'local' }];
  const seen = new Set(['localhost']);
  if (sshConfig?.hosts) {
    for (const h of sshConfig.hosts) {
      if (!seen.has(h.name)) {
        const meshNode = mesh?.nodes?.find((n: any) => n.hostname === h.name);
        hosts.push({ name: h.name, status: meshNode?.reachable ? 'up' : undefined });
        seen.add(h.name);
      }
    }
  }
  if (mesh?.nodes) {
    for (const n of mesh.nodes) {
      if (!seen.has(n.hostname)) {
        hosts.push({ name: n.hostname, status: n.reachable ? 'up' : 'down' });
        seen.add(n.hostname);
      }
    }
  }

  const bootHarness = useCallback(async (harness: typeof HARNESSES[0]) => {
    setStatuses(prev => ({ ...prev, [harness.id]: { state: 'booting' } }));
    try {
      const repoName = harness.repo.split('/').pop()?.replace('.git', '') ?? harness.id;
      const projectPath = `~/git/${repoName}`;
      const authMode = authModes[harness.id] ?? (harness.authModes?.[0] || '');

      // Build the run command with auth mode flags
      let runCmd = harness.run;
      if (harness.id === 'claude-code' && authMode === 'oauth2') {
        runCmd = 'claude --use-oauth';
      }

      // Build the harness command — clone if needed, install, run
      let harnessCmd: string;
      if (harness.install.startsWith('git clone')) {
        harnessCmd = `bash -lc "if [ ! -d ~/git/${repoName} ]; then mkdir -p ~/git && cd ~/git && git clone '${harness.repo}'; fi && cd ~/git/${repoName} && ${runCmd}"`;
      } else {
        harnessCmd = `bash -lc "${harness.install} && mkdir -p ~/git/${repoName} && cd ~/git/${repoName} && ${runCmd}"`;
      }

      const res = await fetch('/api/boot', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          projectPath,
          harness: harnessCmd,
          host: selectedHost,
          projectName: repoName,
          bootstrap: true,
        }),
      });
      const data = await res.json();
      if (data.success) {
        setStatuses(prev => ({ ...prev, [harness.id]: { state: 'success', detail: data } }));
      } else {
        setStatuses(prev => ({ ...prev, [harness.id]: { state: 'error', detail: data.error || 'Unknown error' } }));
      }
    } catch (err) {
      setStatuses(prev => ({ ...prev, [harness.id]: { state: 'error', detail: String(err) } }));
    }
  }, [selectedHost, authModes]);

  const filtered = filter
    ? HARNESSES.filter(h =>
        h.name.toLowerCase().includes(filter.toLowerCase()) ||
        h.desc.toLowerCase().includes(filter.toLowerCase()) ||
        h.tags.some(t => t.includes(filter.toLowerCase()))
      )
    : HARNESSES;

  return (
    <div className="space-y-6">
      <PageContext
        pageType="bootstrap"
        summary={`Bootstrap page. ${HARNESSES.length} harnesses available. Target: ${selectedHost}. ${hosts.length} hosts discovered.`}
        metrics={{ harnesses: HARNESSES.length, hosts: hosts.length, target: selectedHost }}
      />

      {/* Header */}
      <div className="grid grid-cols-[1fr_auto] items-center">
        <h2 className="text-lg font-bold">Bootstrap</h2>
        <div className="flex items-center gap-3">
          <select
            value={selectedHost}
            onChange={(e) => setSelectedHost(e.target.value)}
            className="bg-[var(--color-background)] border border-[var(--color-border)] rounded px-3 py-1.5 text-base"
          >
            {hosts.map(h => (
              <option key={h.name} value={h.name}>
                {h.name}{h.status ? ` (${h.status})` : ''}
              </option>
            ))}
          </select>
          <input
            type="text"
            placeholder="Filter harnesses..."
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            className="bg-[var(--color-background)] border border-[var(--color-border)] rounded px-3 py-1.5 text-base w-48"
          />
        </div>
      </div>

      {/* Harness grid */}
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
        {filtered.map(h => {
          const status = statuses[h.id] ?? { state: 'idle' };
          return (
            <div
              key={h.id}
              className={`rounded border p-4 space-y-2 ${
                status.state === 'success'
                  ? 'border-[var(--color-accent)] bg-[var(--color-accent)]/5'
                  : status.state === 'error'
                    ? 'border-[var(--color-error)] bg-red-950/20'
                    : 'border-[var(--color-border)] bg-[var(--color-surface)]'
              }`}
            >
              <div className="flex items-center justify-between">
                <h3 className="text-base font-bold">{h.name}</h3>
                <div className="flex gap-1">
                  {h.tags.slice(0, 3).map(t => (
                    <span key={t} className="text-[10px] px-1.5 py-0.5 rounded bg-[var(--color-background)] text-[var(--color-muted)]">
                      {t}
                    </span>
                  ))}
                </div>
              </div>

              <p className="text-sm text-[var(--color-muted)]">{h.desc}</p>

              <div className="text-xs text-[var(--color-muted)] font-mono space-y-0.5">
                <div className="truncate">install: {h.install}</div>
                <div className="truncate">run: {h.run}</div>
                {h.requiresKey && (
                  <div className="text-yellow-500/80">requires: {h.requiresKey}</div>
                )}
              </div>

              {h.authModes && h.authModes.length > 1 && (
                <div className="flex items-center gap-2">
                  <span className="text-xs text-[var(--color-muted)]">auth:</span>
                  {h.authModes.map(mode => (
                    <button
                      key={mode}
                      onClick={() => setAuthModes(prev => ({ ...prev, [h.id]: mode }))}
                      className={`text-xs px-2 py-0.5 rounded cursor-pointer transition-colors ${
                        (authModes[h.id] ?? h.authModes[0]) === mode
                          ? 'bg-[var(--color-accent)] text-black font-bold'
                          : 'bg-[var(--color-background)] text-[var(--color-muted)] hover:text-[var(--color-foreground)]'
                      }`}
                    >
                      {mode === 'oauth2' ? 'OAuth2 (Max)' : 'API Key'}
                    </button>
                  ))}
                </div>
              )}

              <div className="flex items-center gap-2 pt-1">
                <button
                  onClick={() => bootHarness(h)}
                  disabled={status.state === 'booting'}
                  className="bg-[var(--color-accent)] text-black px-3 py-1 rounded text-sm font-bold disabled:opacity-50 cursor-pointer"
                >
                  {status.state === 'booting' ? 'Booting...' : status.state === 'success' ? 'Boot Again' : 'Boot'}
                </button>
                <a
                  href={h.repo}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-sm text-[var(--color-muted)] hover:text-[var(--color-foreground)] transition-colors"
                >
                  repo
                </a>
                {status.state === 'success' && (
                  <span className="text-sm text-[var(--color-accent)] font-mono ml-auto truncate max-w-48">
                    {status.detail.command}
                  </span>
                )}
                {status.state === 'error' && (
                  <span className="text-sm text-[var(--color-error)] ml-auto truncate max-w-48">
                    {status.detail}
                  </span>
                )}
              </div>
            </div>
          );
        })}
      </div>

      {/* Quick info */}
      <div className="text-sm text-[var(--color-muted)] space-y-1">
        <p>Bootstraps into ~/git/ on the target host. Uses tmux for session management.</p>
        <p>Remote hosts require SSH key access configured in ~/.ssh/config.</p>
      </div>
    </div>
  );
}
