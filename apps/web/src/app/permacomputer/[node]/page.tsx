'use client';

import { useParams } from 'next/navigation';
import useSWR from 'swr';
import Link from 'next/link';
import React, { useState, useEffect, useCallback, useDeferredValue, useMemo, useRef } from 'react';
import { TimeRangeSelect, useTimeRange, getTimeRangeMinutes, TIME_RANGE_OPTIONS } from '@unturf/unfirehose-ui/TimeRangeSelect';
import { UPlotTimeChart, type UPlotSeries } from './UPlotTimeChart';
// uplot CSS is bundled by UPlotTimeChart's import
import {
  AreaChart,
  Area,
  LineChart,
  Line,
  XAxis,
  YAxis,
  Tooltip,
  Legend,
  ResponsiveContainer,
} from 'recharts';

const fetcher = (url: string) => fetch(url).then(r => r.json());

const DEFAULT_KWH_RATE = 0.31;

// SQLite emits timestamps as "YYYY-MM-DD HH:MM[:SS]" in UTC with no tz marker.
// Parse as UTC and let the browser format in the user's local timezone.
function utcToLocalDate(utcStr: string): Date {
  const iso = utcStr.replace(' ', 'T') + (utcStr.length <= 16 ? ':00Z' : 'Z');
  return new Date(iso);
}
function fmtLocalHHMM(utcStr: string): string {
  return utcToLocalDate(utcStr).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false });
}
function fmtLocalDateTime(utcStr: string): string {
  return utcToLocalDate(utcStr).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false });
}

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
  const parts = text.split(/(\x1b\[[0-9;]*m)/);
  for (const part of parts) {
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
  // --- Coding agents ---
  {
    id: 'claude-code', name: 'Claude Code',
    desc: 'Anthropic CLI for Claude — agentic coding in the terminal',
    install: 'curl -fsSL https://claude.ai/install.sh | bash',
    verify: 'export PATH="$HOME/.local/bin:$PATH"; claude --version',
    tags: ['ml', 'coding', 'cli'],
  },
  {
    id: 'gemini-cli', name: 'Gemini CLI',
    desc: 'Google CLI for Gemini — agentic coding similar to Claude Code',
    install: 'npm install -g @anthropic-ai/gemini-cli',
    verify: 'gemini --version',
    requiresKey: 'GOOGLE_API_KEY', tags: ['ml', 'coding', 'cli'],
  },
  {
    id: 'openai-codex', name: 'OpenAI Codex CLI',
    desc: 'OpenAI CLI coding agent — GPT-4 powered terminal assistant',
    install: 'npm install -g @openai/codex',
    verify: 'codex --version',
    requiresKey: 'OPENAI_API_KEY', tags: ['ml', 'coding', 'cli'],
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
    id: 'agnt', name: 'agnt',
    desc: 'Minimal terminal coding agent — lightweight alternative to Claude Code',
    install: 'npm install -g agnt',
    verify: 'agnt --version',
    requiresKey: 'ANTHROPIC_API_KEY', tags: ['ml', 'coding', 'cli'],
  },
  {
    id: 'cursor', name: 'Cursor',
    desc: 'ML-first code editor — fork of VS Code with built-in chat and autocomplete',
    install: 'curl -fsSL https://www.cursor.com/download/linux -o cursor.appimage && chmod +x cursor.appimage',
    verify: 'ls cursor.appimage',
    tags: ['ml', 'coding', 'editor'],
  },
  {
    id: 'continue-dev', name: 'Continue',
    desc: 'Open source ML code assistant — VS Code and JetBrains extension',
    install: 'pip install continue-sdk',
    verify: 'pip show continue-sdk',
    tags: ['ml', 'coding', 'extension'],
  },
  // --- Inference engines ---
  {
    id: 'ollama', name: 'Ollama',
    desc: 'Run open source LLMs locally — llama, mistral, codellama',
    install: 'curl -fsSL https://ollama.com/install.sh | sh',
    verify: 'ollama --version',
    tags: ['ml', 'local', 'inference'],
  },
  {
    id: 'llama-cpp', name: 'llama.cpp',
    desc: 'Bare-metal LLM inference in C/C++ — GGUF models, CPU and GPU',
    install: 'git clone https://github.com/ggerganov/llama.cpp && cd llama.cpp && make -j',
    verify: 'ls llama.cpp/llama-cli',
    tags: ['ml', 'local', 'inference'],
  },
  {
    id: 'vllm', name: 'vLLM',
    desc: 'High-throughput LLM serving engine — PagedAttention, continuous batching',
    install: 'pip install vllm',
    verify: 'python -c "import vllm; print(vllm.__version__)"',
    tags: ['ml', 'gpu', 'inference'],
  },
  {
    id: 'text-generation-webui', name: 'text-generation-webui',
    desc: 'Gradio web UI for LLMs — supports GGUF, GPTQ, AWQ, EXL2, llama.cpp, Transformers',
    install: 'git clone https://github.com/oobabooga/text-generation-webui && cd text-generation-webui && pip install -r requirements.txt',
    verify: 'ls text-generation-webui/server.py',
    tags: ['ml', 'web', 'inference'],
  },
  // --- Web UIs ---
  {
    id: 'open-webui', name: 'Open WebUI',
    desc: 'Self-hosted ChatGPT-like interface for Ollama and OpenAI APIs',
    install: 'pip install open-webui',
    verify: 'open-webui --version',
    tags: ['ml', 'web', 'self-hosted'],
  },
  // --- Agent frameworks ---
  {
    id: 'hermes-agent', name: 'Hermes Agent',
    desc: 'Autonomous agent framework — tool use, memory, planning with local or cloud LLMs',
    install: 'pip install hermes-agent',
    verify: 'pip show hermes-agent',
    tags: ['ml', 'agent', 'python'],
  },
  {
    id: 'fetch', name: 'Fetch',
    desc: 'HTTP harness for ML APIs — structured logging and replay',
    install: 'pip install fetch-cli',
    verify: 'fetch --version',
    tags: ['ml', 'api', 'cli'],
  },
  {
    id: 'uncloseai-cli', name: 'uncloseai-cli',
    desc: 'ReAct agent harness, microgpt, voxsplit — ML from seed on Unclose',
    install: 'pip install -r requirements.txt',
    verify: 'python -c "import uncloseai"',
    tags: ['ml', 'agent', 'python'],
  },
];

type BootStatus = { state: 'idle' } | { state: 'verifying' } | { state: 'success'; version: string; steps: any[] } | { state: 'error'; detail: string; steps?: any[] };

const TABS = ['Overview', 'Harnesses', 'Processes', 'Bootstrap', 'Settings'] as const;
type Tab = (typeof TABS)[number];

export default function NodeDetailPage() {
  const { node: nodeParam } = useParams<{ node: string }>();
  const host = decodeURIComponent(nodeParam);
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

  const [range, setRange] = useTimeRange('node_chart_range', '24h');
  const chartHours = (() => {
    const mins = getTimeRangeMinutes(range);
    return mins === 0 ? 720 : Math.max(1, Math.ceil(mins / 60));
  })();

  // Live-chart cadence — when a chart is on screen we want smooth lines.
  // Worker keeps a 15s headless baseline; this page bumps to 6s while the tab
  // is active so the user-visible chart gets near-real-time samples.
  // focusThrottleInterval matches refreshInterval so refocus events don't
  // double-fire above the normal polling cadence.
  const LIVE_MS = 6000;
  const { data: mesh } = useSWR('/api/mesh', fetcher, {
    refreshInterval: LIVE_MS,
    focusThrottleInterval: LIVE_MS,
  });
  const { data: meshHistory } = useSWR(
    `/api/mesh/history?hours=${chartHours}`,
    fetcher,
    {
      refreshInterval: LIVE_MS,
      focusThrottleInterval: LIVE_MS,
      keepPreviousData: true,
    },
  );

  // Persist mesh snapshots so this page's own charts populate without needing
  // /usage or /permacomputer open in another tab. We don't call mutate() after
  // POSTing — history SWR already polls on the LIVE_MS cadence, and the extra
  // refetch was causing visible re-render churn / scroll-up.
  const lastSnapshotRef = useRef<string>('');
  useEffect(() => {
    const nodes = mesh?.nodes;
    if (!nodes?.length) return;
    const key = nodes.map((n: any) => `${n.hostname}:${n.loadAvg?.[0]}`).join(',');
    if (key === lastSnapshotRef.current) return;
    lastSnapshotRef.current = key;
    fetch('/api/mesh/history', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ nodes }),
    }).catch(() => {});
  }, [mesh]);
  const { data: probe, isLoading: probeLoading } = useSWR(
    `/api/mesh/node?host=${encodeURIComponent(host)}`,
    fetcher,
    { refreshInterval: LIVE_MS, focusThrottleInterval: LIVE_MS },
  );
  const { data: settings } = useSWR('/api/settings', fetcher, { revalidateOnFocus: false });
  const { data: sshConfig, mutate: mutateSsh } = useSWR('/api/ssh-config', fetcher, { revalidateOnFocus: false });


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

  const { data: tmuxData } = useSWR(
    activeTab === 'Harnesses'
      ? `/api/tmux/stream${!isLocal ? `?host=${encodeURIComponent(host)}` : ''}`
      : null,
    fetcher,
    { refreshInterval: 5000 },
  );

  // Chart engine — uPlot (canvas, default) or recharts (SVG, fallback).
  // Persisted in localStorage so toggling sticks across reloads.
  const [chartEngine, setChartEngine] = useState<'uplot' | 'recharts'>(() => {
    if (typeof window === 'undefined') return 'uplot';
    return (localStorage.getItem('node_chart_engine') as 'uplot' | 'recharts') || 'uplot';
  });
  const toggleEngine = useCallback(() => {
    setChartEngine(prev => {
      const next = prev === 'uplot' ? 'recharts' : 'uplot';
      try { localStorage.setItem('node_chart_engine', next); } catch { /* ignore */ }
      return next;
    });
  }, []);

  // Click-and-drag zoom — select x1→x2 on any chart, all charts zoom together.
  // We keep ALL mouse-driven visuals out of React. Native event listeners
  // attached at the document level (in useEffect below) run synchronously with
  // the browser's input pipeline — no React batching, no recharts internal
  // syncId churn before our cursor moves. Refs hold all live state.
  const [zoomDomain, setZoomDomain] = useState<[number, number] | null>(null);
  const zoomDomainRef = useRef<[number, number] | null>(null);
  zoomDomainRef.current = zoomDomain;
  const viewMinRef = useRef(0);
  const viewMaxRef = useRef(0);
  const dragStartTsRef = useRef<number | null>(null);
  const dragEndTsRef = useRef<number | null>(null);
  const dragStartPxRef = useRef<number | null>(null);
  // chartData ref — native handler needs it to look up nearest data point
  // for the hover-details row. Render syncs this to the latest memoized array.
  const chartDataRef = useRef<any[]>([]);
  // Hover details — only state update from mouse activity, debounced 200ms.
  // null = mouse not over any chart (hide).
  const [hoverInfo, setHoverInfo] = useState<any | null>(null);
  const hoverTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const scheduleHover = useCallback((ts: number) => {
    if (hoverTimerRef.current) clearTimeout(hoverTimerRef.current);
    hoverTimerRef.current = setTimeout(() => {
      const cd = chartDataRef.current;
      if (cd.length === 0) return;
      let lo = 0, hi = cd.length - 1;
      while (lo < hi) {
        const mid = (lo + hi) >>> 1;
        if (cd[mid].tsMs < ts) lo = mid + 1; else hi = mid;
      }
      const cand = cd[lo];
      const prev = lo > 0 ? cd[lo - 1] : cand;
      const nearest = Math.abs(cand.tsMs - ts) < Math.abs(prev.tsMs - ts) ? cand : prev;
      setHoverInfo(nearest);
    }, 80);
  }, []);
  // Direct-DOM updaters. querySelectorAll finds every overlay across all 8
  // charts in one shot; transform/translateX is GPU-composited (no reflow).
  const updateCursors = useCallback((xPx: number | null) => {
    const els = document.querySelectorAll<HTMLElement>('[data-chart-cursor="node-detail"]');
    if (xPx == null) {
      els.forEach(el => { el.style.opacity = '0'; });
      return;
    }
    els.forEach(el => {
      el.style.transform = `translate3d(${xPx}px, 0, 0)`;
      el.style.opacity = '1';
    });
  }, []);
  const updateDragRects = useCallback((aPx: number | null, bPx: number | null) => {
    const els = document.querySelectorAll<HTMLElement>('[data-chart-drag="node-detail"]');
    if (aPx == null || bPx == null) {
      els.forEach(el => { el.style.opacity = '0'; });
      return;
    }
    const lo = Math.min(aPx, bPx);
    const w = Math.abs(bPx - aPx);
    els.forEach(el => {
      el.style.transform = `translate3d(${lo}px, 0, 0)`;
      el.style.width = `${w}px`;
      el.style.opacity = '1';
    });
  }, []);
  // Snap range dropdown to the smallest option that covers the zoom span.
  // When a drag-zoom (or zoom button) snaps the dropdown, we want the new
  // SWR window to take effect WITHOUT also clearing the active zoom (which
  // is what the [range] effect normally does). The ref below marks the
  // upcoming range change as zoom-driven so the reset is skipped once.
  const rangeRef = useRef(range);
  rangeRef.current = range;
  const zoomDrivenRangeRef = useRef(false);
  const closestRangeForZoom = (spanMs: number): string => {
    for (const opt of TIME_RANGE_OPTIONS) {
      if (opt.ms > 0 && opt.ms >= spanMs) return opt.value;
    }
    return TIME_RANGE_OPTIONS[TIME_RANGE_OPTIONS.length - 2].value;
  };
  const applyZoom = useCallback((a: number, b: number) => {
    const lo = Math.min(a, b);
    const hi = Math.max(a, b);
    if (hi - lo < 1000) return;
    setZoomDomain([lo, hi]);
    const next = closestRangeForZoom(hi - lo);
    if (next !== rangeRef.current) {
      zoomDrivenRangeRef.current = true;
      setRange(next);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  // Reset zoom when outer history range changes — UNLESS this range change
  // was triggered by a zoom snap (in which case we want the zoom to stick).
  useEffect(() => {
    if (zoomDrivenRangeRef.current) {
      zoomDrivenRangeRef.current = false;
      return;
    }
    setZoomDomain(null);
  }, [range]);

  // Native mouse listeners — bypass React's synthetic event system entirely.
  // Mouse hover on ANY chart updates the cursor on ALL charts via the shared
  // querySelectorAll. Mouse pixel→time conversion uses an approximate plot
  // inset (Y-axis takes ~40px, right margin ~10px) to map drag bounds back
  // to timestamps for the zoom commit.
  useEffect(() => {
    const PLOT_LEFT_INSET = 40;
    const PLOT_RIGHT_INSET = 10;
    const xToTs = (xInWrapper: number, wrapperW: number): number => {
      const plotW = wrapperW - PLOT_LEFT_INSET - PLOT_RIGHT_INSET;
      if (plotW <= 0) return viewMinRef.current;
      const ratio = Math.max(0, Math.min(1, (xInWrapper - PLOT_LEFT_INSET) / plotW));
      return viewMinRef.current + ratio * (viewMaxRef.current - viewMinRef.current);
    };

    const findWrapper = (target: EventTarget | null): HTMLElement | null => {
      const el = target as HTMLElement | null;
      return el?.closest?.('[data-chart-wrapper="node-detail"]') as HTMLElement | null ?? null;
    };

    let hideTimer: ReturnType<typeof setTimeout> | null = null;
    const onMove = (e: MouseEvent) => {
      const wrapper = findWrapper(e.target);
      if (!wrapper) {
        // Mouse is briefly outside every chart wrapper — could be the gap
        // between two cards, or a re-render flash. Don't hide instantly;
        // wait 80ms so quick traversals don't flicker the cursor.
        if (dragStartPxRef.current == null && hideTimer == null) {
          hideTimer = setTimeout(() => {
            hideTimer = null;
            updateCursors(null);
            if (hoverTimerRef.current) clearTimeout(hoverTimerRef.current);
            setHoverInfo(null);
          }, 80);
        }
        return;
      }
      if (hideTimer != null) { clearTimeout(hideTimer); hideTimer = null; }
      const rect = wrapper.getBoundingClientRect();
      const x = e.clientX - rect.left;
      updateCursors(x);
      const ts = xToTs(x, rect.width);
      scheduleHover(ts);
      if (dragStartPxRef.current != null) {
        updateDragRects(dragStartPxRef.current, x);
        dragEndTsRef.current = ts;
      }
    };

    const onDown = (e: MouseEvent) => {
      if (e.button !== 0) return;
      const wrapper = findWrapper(e.target);
      if (!wrapper) return;
      const rect = wrapper.getBoundingClientRect();
      const x = e.clientX - rect.left;
      dragStartPxRef.current = x;
      dragStartTsRef.current = xToTs(x, rect.width);
      dragEndTsRef.current = dragStartTsRef.current;
      updateDragRects(x, x);
    };

    const onUp = () => {
      const s = dragStartTsRef.current;
      const e = dragEndTsRef.current;
      if (s != null && e != null && Math.abs(e - s) > 1000) {
        applyZoom(s, e);
      }
      dragStartPxRef.current = null;
      dragStartTsRef.current = null;
      dragEndTsRef.current = null;
      updateDragRects(null, null);
    };

    document.addEventListener('mousemove', onMove, { passive: true });
    document.addEventListener('mousedown', onDown);
    document.addEventListener('mouseup', onUp);
    return () => {
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('mouseup', onUp);
    };
  }, [updateCursors, updateDragRects, scheduleHover]);

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
    setBootStatuses(prev => ({ ...prev, [harness.id]: { state: 'verifying' } }));
    try {
      const res = await fetch('/api/harness/verify', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          host: bootHost,
          install: harness.install,
          verify: harness.verify,
          id: harness.id,
        }),
      });
      const data = await res.json();
      if (data.success) {
        setBootStatuses(prev => ({ ...prev, [harness.id]: { state: 'success', version: data.version, steps: data.steps } }));
      } else {
        setBootStatuses(prev => ({ ...prev, [harness.id]: { state: 'error', detail: data.error || 'Verification failed', steps: data.steps } }));
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

  const memTotalGB = useMemo(
    () => Math.round(((probe?.memory?.totalKB ?? 0) / 1048576) * 10) / 10,
    [probe?.memory?.totalKB],
  );
  // useDeferredValue makes the timeline a low-priority input: when SWR polls
  // new mesh data every 6s, React renders the chart subtree with the OLD
  // timeline immediately (so the parent re-render is cheap) and schedules a
  // re-render with the new timeline at low priority. Mouse moves during that
  // low-priority work INTERRUPT it — React yields the main thread back to
  // input, so our native listener keeps firing and the cursor stays smooth.
  const timeline = meshHistory?.timeline;
  const deferredTimeline = useDeferredValue(timeline);
  const chartData = useMemo(() => {
    if (!Array.isArray(deferredTimeline) || deferredTimeline.length === 0) return [] as any[];
    return deferredTimeline
      .filter((t: any) => t.nodes?.[host])
      .map((t: any) => {
        const n = t.nodes[host];
        return {
          tsMs: utcToLocalDate(t.timestamp).getTime(),
          timestamp: t.timestamp,
          watts: n.watts ?? 0,
          cpuWatts: (n.watts ?? 0) - (n.gpuWatts ?? 0),
          gpuWatts: n.gpuWatts ?? 0,
          load: n.load ?? 0,
          cores: n.cores ?? 0,
          memUsedGB: n.memUsed ?? 0,
          memTotalGB,
          claudes: n.claudes ?? 0,
          gpuUtil: n.gpuUtil ?? 0,
          gpuMemUsedGB: Math.round((n.gpuMemUsedMB ?? 0) / 1024 * 10) / 10,
          gpuMemTotalGB: Math.round((n.gpuMemTotalMB ?? 0) / 1024 * 10) / 10,
          elecCostPerHour: Math.round(((n.watts ?? 0) / 1000) * kwhRate * 100) / 100,
        };
      });
  }, [deferredTimeline, host, memTotalGB, kwhRate]);

  return (
    <div className="p-6 w-full">
      {/* Breadcrumb */}
      <div className="flex items-center gap-2 text-sm text-[var(--color-muted)] mb-4">
        <Link href="/permacomputer" className="hover:text-[var(--color-foreground)]">&larr; Permacomputer</Link>
        <span>/</span>
        <span className="text-[var(--color-foreground)] font-bold">{host}</span>
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
              <span className={`text-xs ${wattsOverride ? 'text-yellow-400' : 'text-[var(--color-accent)]'}`}>
                [{wattsOverride ? 'override' : node.powerSource ?? 'n/a'}
                {!wattsOverride && node.cpuTdpWatts && ` ${node.cpuTdpWatts}W`}]
              </span>
              {gpuWatts > 0 && <span className="text-xs text-green-400"> [gpu nvidia-smi]</span>}
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
      {activeTab === 'Overview' && (<>
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

        {/* Time-Series Charts */}
        {chartData.length > 0 && (() => {
          const tooltipStyle = { background: '#18181b', border: '1px solid #3f3f46', borderRadius: 4 };
          // Tooltip pinned at top-left so it never covers the data line.
          // No magnetic flip: that required a state update mid-mousemove, which
          // forced a parent re-render of all 8 charts — the source of chop.
          const tooltipPosition = { x: 60, y: 0 };
          const fmtLabel = (v: any) => {
            const n = typeof v === 'number' ? v : Number(v);
            if (!Number.isFinite(n)) return String(v);
            return new Date(n).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false });
          };
          const xAxisProps = {
            dataKey: 'tsMs',
            type: 'number' as const,
            scale: 'time' as const,
            domain: (zoomDomain ?? ['dataMin', 'dataMax']) as [number | string, number | string],
            tick: { fill: '#71717a', fontSize: 12 },
            tickFormatter: (ms: number) => new Date(ms).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false }),
            allowDataOverflow: true,
          };
          // recharts' built-in cursor and ReferenceArea are disabled — we render
          // our own DOM overlay so neither requires React re-renders during drag.

          const last = chartData[chartData.length - 1];

          const dataMin: number = chartData[0].tsMs;
          const dataMax: number = chartData[chartData.length - 1].tsMs;
          const [viewMin, viewMax] = zoomDomain ?? [dataMin, dataMax];
          // Refs that the native mouse listener (outside this IIFE) reads to
          // map pixel x → time and look up the nearest data point for the
          // hover-details row. Mutating refs during render is safe.
          viewMinRef.current = viewMin;
          viewMaxRef.current = viewMax;
          chartDataRef.current = chartData;
          const viewSpanMs = viewMax - viewMin;
          const fmtSpan = (ms: number) => {
            if (ms < 60_000) return `${Math.round(ms / 1000)}s`;
            if (ms < 3_600_000) return `${Math.round(ms / 60_000)}m`;
            if (ms < 86_400_000) return `${(ms / 3_600_000).toFixed(1)}h`;
            return `${(ms / 86_400_000).toFixed(1)}d`;
          };
          const zoomBy = (factor: number) => {
            const mid = (viewMin + viewMax) / 2;
            const half = (viewSpanMs * factor) / 2;
            let a = mid - half, b = mid + half;
            if (a <= dataMin && b >= dataMax) { setZoomDomain(null); return; }
            a = Math.max(dataMin, a);
            b = Math.min(dataMax, b);
            if (b - a < 1000) return;
            applyZoom(a, b);
          };
          const zoomIn = () => zoomBy(0.5);
          const zoomOut = () => zoomBy(2);
          const resetZoom = () => setZoomDomain(null);
          // Pan: shift the visible window by ½ its current span, clamped
          // to data bounds. When at full view (no zoom), pan creates an
          // initial half-zoom on the side we moved toward — that way the
          // user always has somewhere to navigate even from the wide view.
          const panBy = (fraction: number) => {
            if (!zoomDomain) {
              const half = (dataMax - dataMin) / 2;
              if (fraction < 0) setZoomDomain([dataMin, dataMin + half]);
              else setZoomDomain([dataMax - half, dataMax]);
              return;
            }
            const [curMin, curMax] = zoomDomain;
            const span = curMax - curMin;
            if (span <= 0) return;
            const delta = span * fraction;
            let a = curMin + delta, b = curMax + delta;
            if (a < dataMin) { b += dataMin - a; a = dataMin; }
            if (b > dataMax) { a -= b - dataMax; b = dataMax; }
            if (a < dataMin) a = dataMin;
            if (b - a < 1000) return;
            // Snapping back to full data range clears the zoom (auto-fit).
            if (a === dataMin && b === dataMax) setZoomDomain(null);
            else setZoomDomain([a, b]);
          };
          const panLeft = () => panBy(-0.5);
          const panRight = () => panBy(0.5);
          // Left: always available if there's data — even at full view, a
          // pan-left creates a half-zoom into the older window. Right:
          // disabled when the forecast zone is already visible (no zoom
          // OR the zoom already ends at dataMax).
          const canPanLeft = chartData.length > 0;
          const canPanRight = zoomDomain != null && zoomDomain[1] < dataMax;

          const tz = typeof window !== 'undefined' ? Intl.DateTimeFormat().resolvedOptions().timeZone : 'UTC';
          return (
          <div className="mt-8 space-y-4">
            <div className="flex items-center justify-between flex-wrap gap-2">
              <h2 className="text-lg font-bold">
                History <span className="text-xs font-normal text-[var(--color-muted)] opacity-60 ml-1">{tz}</span>
                <span className="text-xs font-normal text-[var(--color-muted)] ml-2">
                  showing {fmtSpan(viewSpanMs)}{zoomDomain && ' (zoomed)'}
                </span>
              </h2>
              <div className="flex items-center gap-2">
                <div className="flex items-center border border-[var(--color-border)] rounded overflow-hidden text-xs">
                  <button onClick={panLeft} disabled={!canPanLeft} title="Pan left ½ screen"
                    className="px-2 py-1 hover:bg-[var(--color-surface)] cursor-pointer font-bold disabled:opacity-40 disabled:cursor-not-allowed">‹</button>
                  <button onClick={zoomOut} title="Zoom out 2×"
                    className="px-2 py-1 hover:bg-[var(--color-surface)] cursor-pointer border-l border-[var(--color-border)] font-bold">−</button>
                  <button onClick={zoomIn} title="Zoom in 2×"
                    className="px-2 py-1 hover:bg-[var(--color-surface)] cursor-pointer border-l border-[var(--color-border)] font-bold">+</button>
                  <button onClick={panRight} disabled={!canPanRight} title="Pan right ½ screen"
                    className="px-2 py-1 hover:bg-[var(--color-surface)] cursor-pointer border-l border-[var(--color-border)] font-bold disabled:opacity-40 disabled:cursor-not-allowed">›</button>
                  <button onClick={resetZoom} disabled={!zoomDomain}
                    title="Reset zoom to full range"
                    className="px-2 py-1 hover:bg-[var(--color-surface)] cursor-pointer border-l border-[var(--color-border)] disabled:opacity-40 disabled:cursor-not-allowed">
                    reset
                  </button>
                </div>
                <button onClick={toggleEngine} title="Toggle chart engine"
                  className="text-xs px-2 py-1 border border-[var(--color-border)] rounded hover:bg-[var(--color-surface)] cursor-pointer font-mono">
                  engine: <span className="text-[var(--color-accent)]">{chartEngine}</span>
                </button>
                <TimeRangeSelect value={range} onChange={setRange} />
              </div>
            </div>
            <p className="text-xs text-[var(--color-muted)] -mt-2">
              Drag horizontally across any chart to zoom into that window. Use −/+ to step, reset to restore.
            </p>

            {/* Per-chart inline horizontal value lines (drawn by uPlot's
                setCursor hook) replace the shared hover row — updates are
                DOM-direct so values appear with the cursor, no React work. */}

            {chartEngine === 'uplot' && (() => {
              // uPlot chart engine — canvas, no React reconciliation per data tick.
              const SYNC = 'mesh-node-detail';
              const handleZoom = (range: [number, number]) => {
                applyZoom(range[0], range[1]);
              };
              const handleCursor = (idx: number | null) => {
                if (idx == null) {
                  if (hoverTimerRef.current) clearTimeout(hoverTimerRef.current);
                  setHoverInfo(null);
                  return;
                }
                if (hoverTimerRef.current) clearTimeout(hoverTimerRef.current);
                hoverTimerRef.current = setTimeout(() => {
                  const row = chartDataRef.current[idx];
                  if (row) setHoverInfo(row);
                }, 80);
              };
              const cardCls = 'bg-[var(--color-surface)] rounded border border-[var(--color-border)] p-4';
              const titleCls = 'text-base font-bold mb-3 text-[var(--color-muted)]';
              const hasGpuUtil = chartData.some((t: any) => t.gpuUtil > 0 || t.gpuWatts > 0);
              const hasGpuMem = chartData.some((t: any) => t.gpuMemTotalGB > 0);
              const hasGpuPower = chartData.some((t: any) => t.gpuWatts > 0);
              return (
                <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
                  <div className={cardCls}>
                    <h3 className={titleCls}>CPU Load <span className="text-xs font-normal ml-2">{last.load.toFixed(1)} / {last.cores} cores</span></h3>
                    <UPlotTimeChart data={chartData} height={180} syncKey={SYNC} domain={zoomDomain} onZoom={handleZoom} onCursor={handleCursor}
                      series={[
                        { key: 'cores', label: 'Total Cores', stroke: '#52525b', fill: 'rgba(82,82,91,0.18)', watermark: true },
                        { key: 'load', label: 'Load Average', stroke: '#f97316', fill: 'rgba(249,115,22,0.25)' },
                      ]} />
                  </div>

                  <div className={cardCls}>
                    <h3 className={titleCls}>Memory Usage <span className="text-xs font-normal ml-2">{last.memUsedGB} / {last.memTotalGB || '?'} GB</span></h3>
                    <UPlotTimeChart data={chartData} height={180} syncKey={SYNC} domain={zoomDomain} onZoom={handleZoom} onCursor={handleCursor} yUnit="GB"
                      series={[
                        { key: 'memTotalGB', label: 'Total', stroke: '#52525b', fill: 'rgba(82,82,91,0.18)', watermark: true },
                        { key: 'memUsedGB', label: 'Used', stroke: '#60a5fa', fill: 'rgba(96,165,250,0.28)' },
                      ]} />
                  </div>

                  {hasGpuUtil && (
                    <div className={cardCls}>
                      <h3 className={titleCls}>GPU Utilization <span className="text-xs font-normal ml-2">{last.gpuUtil}%</span></h3>
                      <UPlotTimeChart data={chartData} height={180} syncKey={SYNC} domain={zoomDomain} onZoom={handleZoom} onCursor={handleCursor} yUnit="%" yMin={0} yMax={100}
                        series={[{ key: 'gpuUtil', label: 'GPU Util', stroke: '#22c55e', fill: 'rgba(34,197,94,0.28)' }]} />
                    </div>
                  )}

                  {hasGpuMem && (
                    <div className={cardCls}>
                      <h3 className={titleCls}>GPU Memory <span className="text-xs font-normal ml-2">{last.gpuMemUsedGB} / {last.gpuMemTotalGB} GB</span></h3>
                      <UPlotTimeChart data={chartData} height={180} syncKey={SYNC} domain={zoomDomain} onZoom={handleZoom} onCursor={handleCursor} yUnit="GB"
                        series={[
                          { key: 'gpuMemTotalGB', label: 'Total', stroke: '#52525b', fill: 'rgba(82,82,91,0.18)', watermark: true },
                          { key: 'gpuMemUsedGB', label: 'Used', stroke: '#22c55e', fill: 'rgba(34,197,94,0.28)' },
                        ]} />
                    </div>
                  )}

                  {hasGpuPower && (
                    <div className={cardCls}>
                      <h3 className={titleCls}>GPU Power <span className="text-xs font-normal ml-2">{last.gpuWatts}W</span></h3>
                      <UPlotTimeChart data={chartData} height={180} syncKey={SYNC} domain={zoomDomain} onZoom={handleZoom} onCursor={handleCursor} yUnit="W"
                        series={[{ key: 'gpuWatts', label: 'GPU Power', stroke: '#a78bfa', fill: 'rgba(167,139,250,0.25)' }]} />
                    </div>
                  )}

                  <div className={cardCls}>
                    <h3 className={titleCls}>Electricity Cost <span className="text-xs font-normal ml-2">${last.elecCostPerHour.toFixed(3)}/hr · ~${(last.elecCostPerHour * 24 * 30).toFixed(0)}/mo</span></h3>
                    <UPlotTimeChart data={chartData} height={140} syncKey={SYNC} domain={zoomDomain} onZoom={handleZoom} onCursor={handleCursor}
                      series={[{ key: 'elecCostPerHour', label: '$/hr', stroke: '#facc15', fill: 'rgba(250,204,21,0.20)' }]} />
                  </div>

                  <div className={cardCls}>
                    <h3 className={titleCls}>Compute Wattage <span className="text-xs font-normal ml-2">{last.watts}W current</span></h3>
                    <UPlotTimeChart data={chartData} height={180} syncKey={SYNC} domain={zoomDomain} onZoom={handleZoom} onCursor={handleCursor} yUnit="W"
                      series={[
                        { key: 'watts', label: 'Total', stroke: '#d40000', width: 2 },
                        { key: 'cpuWatts', label: 'CPU', stroke: '#f97316', width: 1.5 },
                        ...(hasGpuPower ? [{ key: 'gpuWatts', label: 'GPU', stroke: '#a78bfa', width: 1.5 } as UPlotSeries] : []),
                      ]} />
                  </div>

                  <div className={cardCls}>
                    <h3 className={titleCls}>Active Claudes <span className="text-xs font-normal ml-2">{last.claudes} current</span></h3>
                    <UPlotTimeChart data={chartData} height={140} syncKey={SYNC} domain={zoomDomain} onZoom={handleZoom} onCursor={handleCursor}
                      series={[{ key: 'claudes', label: 'Claudes', stroke: '#d40000', fill: 'rgba(212,0,0,0.20)', step: true }]} />
                  </div>
                </div>
              );
            })()}

            {chartEngine === 'recharts' && (
            <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">

            {/* CPU Load */}
            <div className="bg-[var(--color-surface)] rounded border border-[var(--color-border)] p-4">
              <h3 className="text-base font-bold mb-3 text-[var(--color-muted)]">
                CPU Load
                <span className="text-xs font-normal ml-2">{last.load.toFixed(1)} / {last.cores} cores</span>
              </h3>
              <div data-chart-wrapper="node-detail" className="relative cursor-crosshair select-none">
              <ResponsiveContainer width="100%" height={180}>
                <AreaChart data={chartData}>
                  <XAxis {...xAxisProps} />
                  <YAxis tick={{ fill: '#71717a', fontSize: 12 }} />
                  <Tooltip position={tooltipPosition} cursor={false} isAnimationActive={false} labelFormatter={fmtLabel} formatter={(v: any, name: any) => [typeof v === 'number' ? v.toFixed(1) : v, name]} contentStyle={tooltipStyle} content={NULL_TOOLTIP} wrapperStyle={HIDDEN_WRAPPER_STYLE} />
                  <Legend />
                  <Area type="monotone" dataKey="cores" name="Total Cores" stroke="#3f3f46" fill="#3f3f46" fillOpacity={0.2} dot={false} activeDot={{ r: 4, fill: '#fff', stroke: '#fff', strokeWidth: 1 }} />
                  <Area type="monotone" dataKey="load" name="Load Average" stroke="#f97316" fill="#f97316" fillOpacity={0.3} dot={false} activeDot={{ r: 4, fill: '#fff', stroke: '#fff', strokeWidth: 1 }} />
                </AreaChart>
              </ResponsiveContainer>
              <ChartOverlay />
              </div>
            </div>

            {/* Memory */}
            <div className="bg-[var(--color-surface)] rounded border border-[var(--color-border)] p-4">
              <h3 className="text-base font-bold mb-3 text-[var(--color-muted)]">
                Memory Usage
                <span className="text-xs font-normal ml-2">{last.memUsedGB} / {last.memTotalGB || '?'} GB</span>
              </h3>
              <div data-chart-wrapper="node-detail" className="relative cursor-crosshair select-none">
              <ResponsiveContainer width="100%" height={180}>
                <AreaChart data={chartData}>
                  <XAxis {...xAxisProps} />
                  <YAxis tick={{ fill: '#71717a', fontSize: 12 }} unit="GB" />
                  <Tooltip position={tooltipPosition} cursor={false} isAnimationActive={false} labelFormatter={fmtLabel} formatter={(v: any, name: any) => [`${v}GB`, name]} contentStyle={tooltipStyle} content={NULL_TOOLTIP} wrapperStyle={HIDDEN_WRAPPER_STYLE} />
                  <Legend />
                  {last.memTotalGB > 0 && (
                    <Area type="monotone" dataKey="memTotalGB" name="Total" stroke="#3f3f46" fill="#3f3f46" fillOpacity={0.2} dot={false} activeDot={{ r: 4, fill: '#fff', stroke: '#fff', strokeWidth: 1 }} />
                  )}
                  <Area type="monotone" dataKey="memUsedGB" name="Used" stroke="#60a5fa" fill="#60a5fa" fillOpacity={0.3} dot={false} activeDot={{ r: 4, fill: '#fff', stroke: '#fff', strokeWidth: 1 }} />
                </AreaChart>
              </ResponsiveContainer>
              <ChartOverlay />
              </div>
            </div>

            {/* GPU Utilization */}
            {chartData.some((t: any) => t.gpuUtil > 0 || t.gpuWatts > 0) && (
            <div className="bg-[var(--color-surface)] rounded border border-[var(--color-border)] p-4">
              <h3 className="text-base font-bold mb-3 text-[var(--color-muted)]">
                GPU Utilization
                <span className="text-xs font-normal ml-2">{last.gpuUtil}%</span>
              </h3>
              <div data-chart-wrapper="node-detail" className="relative cursor-crosshair select-none">
              <ResponsiveContainer width="100%" height={180}>
                <AreaChart data={chartData}>
                  <XAxis {...xAxisProps} />
                  <YAxis tick={{ fill: '#71717a', fontSize: 12 }} unit="%" domain={[0, 100]} />
                  <Tooltip position={tooltipPosition} cursor={false} isAnimationActive={false} labelFormatter={fmtLabel} formatter={(v: any, name: any) => [`${v}%`, name]} contentStyle={tooltipStyle} content={NULL_TOOLTIP} wrapperStyle={HIDDEN_WRAPPER_STYLE} />
                  <Area type="monotone" dataKey="gpuUtil" name="GPU Util" stroke="#22c55e" fill="#22c55e" fillOpacity={0.3} dot={false} activeDot={{ r: 4, fill: '#fff', stroke: '#fff', strokeWidth: 1 }} />
                </AreaChart>
              </ResponsiveContainer>
              <ChartOverlay />
              </div>
            </div>
            )}

            {/* GPU Memory */}
            {chartData.some((t: any) => t.gpuMemTotalGB > 0) && (
            <div className="bg-[var(--color-surface)] rounded border border-[var(--color-border)] p-4">
              <h3 className="text-base font-bold mb-3 text-[var(--color-muted)]">
                GPU Memory
                <span className="text-xs font-normal ml-2">{last.gpuMemUsedGB} / {last.gpuMemTotalGB} GB</span>
              </h3>
              <div data-chart-wrapper="node-detail" className="relative cursor-crosshair select-none">
              <ResponsiveContainer width="100%" height={180}>
                <AreaChart data={chartData}>
                  <XAxis {...xAxisProps} />
                  <YAxis tick={{ fill: '#71717a', fontSize: 12 }} unit="GB" />
                  <Tooltip position={tooltipPosition} cursor={false} isAnimationActive={false} labelFormatter={fmtLabel} formatter={(v: any, name: any) => [`${v}GB`, name]} contentStyle={tooltipStyle} content={NULL_TOOLTIP} wrapperStyle={HIDDEN_WRAPPER_STYLE} />
                  <Area type="monotone" dataKey="gpuMemTotalGB" name="Total" stroke="#3f3f46" fill="#3f3f46" fillOpacity={0.2} dot={false} activeDot={{ r: 4, fill: '#fff', stroke: '#fff', strokeWidth: 1 }} />
                  <Area type="monotone" dataKey="gpuMemUsedGB" name="Used" stroke="#22c55e" fill="#22c55e" fillOpacity={0.3} dot={false} activeDot={{ r: 4, fill: '#fff', stroke: '#fff', strokeWidth: 1 }} />
                </AreaChart>
              </ResponsiveContainer>
              <ChartOverlay />
              </div>
            </div>
            )}

            {/* GPU Power */}
            {chartData.some((t: any) => t.gpuWatts > 0) && (
            <div className="bg-[var(--color-surface)] rounded border border-[var(--color-border)] p-4">
              <h3 className="text-base font-bold mb-3 text-[var(--color-muted)]">
                GPU Power
                <span className="text-xs font-normal ml-2">{last.gpuWatts}W</span>
              </h3>
              <div data-chart-wrapper="node-detail" className="relative cursor-crosshair select-none">
              <ResponsiveContainer width="100%" height={180}>
                <AreaChart data={chartData}>
                  <XAxis {...xAxisProps} />
                  <YAxis tick={{ fill: '#71717a', fontSize: 12 }} unit="W" />
                  <Tooltip position={tooltipPosition} cursor={false} isAnimationActive={false} labelFormatter={fmtLabel} formatter={(v: any, name: any) => [`${v}W`, name]} contentStyle={tooltipStyle} content={NULL_TOOLTIP} wrapperStyle={HIDDEN_WRAPPER_STYLE} />
                  <Area type="monotone" dataKey="gpuWatts" name="GPU Power" stroke="#a78bfa" fill="#a78bfa" fillOpacity={0.3} dot={false} activeDot={{ r: 4, fill: '#fff', stroke: '#fff', strokeWidth: 1 }} />
                </AreaChart>
              </ResponsiveContainer>
              <ChartOverlay />
              </div>
            </div>
            )}

            {/* Electricity Cost */}
            <div className="bg-[var(--color-surface)] rounded border border-[var(--color-border)] p-4">
              <h3 className="text-base font-bold mb-3 text-[var(--color-muted)]">
                Electricity Cost
                <span className="text-xs font-normal ml-2">
                  ${last.elecCostPerHour.toFixed(3)}/hr &middot; ~${(last.elecCostPerHour * 24 * 30).toFixed(0)}/mo
                </span>
              </h3>
              <div data-chart-wrapper="node-detail" className="relative cursor-crosshair select-none">
              <ResponsiveContainer width="100%" height={140}>
                <AreaChart data={chartData}>
                  <XAxis {...xAxisProps} />
                  <YAxis tick={{ fill: '#71717a', fontSize: 12 }} tickFormatter={(v: number) => `$${v.toFixed(2)}`} />
                  <Tooltip position={tooltipPosition} cursor={false} isAnimationActive={false} labelFormatter={fmtLabel} formatter={(v: any) => [`$${Number(v).toFixed(3)}/hr`, '$/hr']} contentStyle={tooltipStyle} content={NULL_TOOLTIP} wrapperStyle={HIDDEN_WRAPPER_STYLE} />
                  <Area type="monotone" dataKey="elecCostPerHour" name="$/hr" stroke="#facc15" fill="#facc15" fillOpacity={0.2} dot={false} activeDot={{ r: 4, fill: '#fff', stroke: '#fff', strokeWidth: 1 }} />
                </AreaChart>
              </ResponsiveContainer>
              <ChartOverlay />
              </div>
            </div>

            {/* Wattage */}
            <div className="bg-[var(--color-surface)] rounded border border-[var(--color-border)] p-4">
              <h3 className="text-base font-bold mb-3 text-[var(--color-muted)]">
                Compute Wattage
                <span className="text-xs font-normal ml-2">{last.watts}W current</span>
              </h3>
              <div data-chart-wrapper="node-detail" className="relative cursor-crosshair select-none">
              <ResponsiveContainer width="100%" height={180}>
                <LineChart data={chartData}>
                  <XAxis {...xAxisProps} />
                  <YAxis tick={{ fill: '#71717a', fontSize: 12 }} unit="W" />
                  <Tooltip position={tooltipPosition} cursor={false} isAnimationActive={false} labelFormatter={fmtLabel} formatter={(v: any, name: any) => [`${v}W`, name]} contentStyle={tooltipStyle} content={NULL_TOOLTIP} wrapperStyle={HIDDEN_WRAPPER_STYLE} />
                  <Legend />
                  <Line type="monotone" dataKey="watts" name="Total" stroke="var(--color-accent)" strokeWidth={2} dot={false} activeDot={{ r: 4, fill: '#fff', stroke: '#fff', strokeWidth: 1 }} />
                  <Line type="monotone" dataKey="cpuWatts" name="CPU" stroke="#f97316" strokeWidth={1.5} dot={false} activeDot={{ r: 4, fill: '#fff', stroke: '#fff', strokeWidth: 1 }} />
                  {chartData.some((t: any) => t.gpuWatts > 0) && (
                    <Line type="monotone" dataKey="gpuWatts" name="GPU" stroke="#a78bfa" strokeWidth={1.5} dot={false} activeDot={{ r: 4, fill: '#fff', stroke: '#fff', strokeWidth: 1 }} />
                  )}
                </LineChart>
              </ResponsiveContainer>
              <ChartOverlay />
              </div>
            </div>

            {/* Active Claudes */}
            <div className="bg-[var(--color-surface)] rounded border border-[var(--color-border)] p-4">
              <h3 className="text-base font-bold mb-3 text-[var(--color-muted)]">
                Active Claudes
                <span className="text-xs font-normal ml-2">{last.claudes} current</span>
              </h3>
              <div data-chart-wrapper="node-detail" className="relative cursor-crosshair select-none">
              <ResponsiveContainer width="100%" height={140}>
                <AreaChart data={chartData}>
                  <XAxis {...xAxisProps} />
                  <YAxis tick={{ fill: '#71717a', fontSize: 12 }} allowDecimals={false} />
                  <Tooltip position={tooltipPosition} cursor={false} isAnimationActive={false} labelFormatter={fmtLabel} formatter={(v: any, name: any) => [v, name]} contentStyle={tooltipStyle} content={NULL_TOOLTIP} wrapperStyle={HIDDEN_WRAPPER_STYLE} />
                  <Area type="stepAfter" dataKey="claudes" name="Claudes" stroke="var(--color-accent)" fill="var(--color-accent)" fillOpacity={0.2} dot={false} activeDot={{ r: 4, fill: '#fff', stroke: '#fff', strokeWidth: 1 }} />
                </AreaChart>
              </ResponsiveContainer>
              <ChartOverlay />
              </div>
            </div>

            </div>
            )}
          </div>
          );
        })()}
      </>)}

      {/* ===== HARNESSES TAB ===== */}
      {activeTab === 'Harnesses' && (() => {
        // tmuxData comes from /api/tmux/stream (with host param for remote)
        const sessions: string[] = tmuxData?.sessions ?? [];
        const tmuxEntries = sessions.map((s: string) => ({ name: s, type: 'tmux' as const }));

        // Bare claude processes (not in tmux) from probe data
        const claudeProcs: any[] = Array.isArray(probe?.claudeProcesses) ? probe.claudeProcesses : [];
        const bareEntries = claudeProcs.map((p: any) => ({
          name: `claude (PID ${p.pid})`,
          type: 'process' as const,
          pid: p.pid,
          tty: p.tty,
          cpu: p.cpu,
          mem: p.mem,
          start: p.start,
          command: (p.command ?? '').slice(0, 120),
        }));

        const allEntries = [...tmuxEntries, ...bareEntries];

        return (
          <div className="space-y-4">
            {allEntries.length === 0 && (
              <div className="text-sm text-[var(--color-muted)] text-center py-8 bg-[var(--color-surface)] rounded border border-[var(--color-border)]">
                No harnesses running on {host}.
              </div>
            )}

            {tmuxEntries.length > 0 && (
              <div className="grid grid-cols-1 gap-3">
                <h3 className="text-xs font-bold text-[var(--color-muted)] uppercase tracking-wide">Tmux Sessions ({tmuxEntries.length})</h3>
                {tmuxEntries.map(s => {
                  const isActive = previewSession === s.name;

                  return (
                    <div
                      key={s.name}
                      onClick={() => setPreviewSession(isActive ? null : s.name)}
                      className={`bg-[var(--color-surface)] rounded border p-4 transition-colors cursor-pointer ${
                        isActive ? 'border-[var(--color-accent)]' :
                        'border-[var(--color-border)] hover:border-[var(--color-accent)]/50'
                      }`}
                    >
                      <div className="flex items-center justify-between">
                        <div className="flex items-center gap-2">
                          <span className="w-2 h-2 rounded-full bg-green-400 animate-pulse" />
                          <span className="font-bold font-mono text-sm">{s.name}</span>
                        </div>
                        <div className="flex items-center gap-2" onClick={(e) => e.stopPropagation()}>
                          {isLocal && (
                            <Link
                              href={`/tmux/${encodeURIComponent(s.name)}`}
                              className="text-xs px-2 py-1 rounded bg-[var(--color-accent)] text-[var(--color-background)] font-bold hover:opacity-90 transition-opacity"
                            >
                              Full View
                            </Link>
                          )}
                          {!isLocal && (
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
            )}

            {bareEntries.length > 0 && (
              <div className="space-y-3">
                <h3 className="text-xs font-bold text-[var(--color-muted)] uppercase tracking-wide">Bare Processes ({bareEntries.length})</h3>
                <div className="grid grid-cols-1 gap-2">
                  {bareEntries.map(p => (
                    <div
                      key={p.pid}
                      className="bg-[var(--color-surface)] rounded border border-[var(--color-border)] p-3"
                    >
                      <div className="flex items-center justify-between">
                        <div className="flex items-center gap-2">
                          <span className="w-2 h-2 rounded-full bg-yellow-400 animate-pulse" />
                          <span className="font-bold font-mono text-sm">{p.name}</span>
                        </div>
                        <div className="flex items-center gap-3 text-xs text-[var(--color-muted)]">
                          {p.tty && <span>TTY {p.tty}</span>}
                          <span>CPU {p.cpu}%</span>
                          <span>MEM {p.mem}%</span>
                          {p.start && <span>started {p.start}</span>}
                        </div>
                      </div>
                      {p.command && (
                        <div className="mt-1 text-xs font-mono text-[var(--color-muted)] truncate">{p.command}</div>
                      )}
                    </div>
                  ))}
                </div>
              </div>
            )}

            {allEntries.length > 0 && (
              <p className="text-xs text-[var(--color-muted)]">
                {tmuxEntries.length > 0 && <>Click a tmux session to preview live output. {isLocal ? 'Full View' : 'Watch'} opens the interactive terminal viewer. </>}
                {bareEntries.length > 0 && <>Yellow dots indicate claude processes running outside tmux.</>}
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
            <Section title={`Top Processes (${Array.isArray(probe.claudeProcesses) ? probe.claudeProcesses.length : probe.claudeProcesses ?? 0} claudes)`}>
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
                      disabled={status.state === 'verifying'}
                      className="bg-[var(--color-accent)] text-black px-2.5 py-0.5 rounded text-xs font-bold disabled:opacity-50 cursor-pointer"
                    >
                      {status.state === 'verifying' ? 'Verifying...' : status.state === 'success' ? 'Re-verify' : 'Verify & Install'}
                    </button>
                    {status.state === 'success' && (
                      <span className="text-xs text-[var(--color-accent)] font-mono ml-auto truncate max-w-60">{status.version}</span>
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
            Installs and verifies harnesses on {bootHost}. For claude-code, also syncs OAuth credentials.
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

// Static style refs for the chart overlay — module-level so React sees the same
// reference on every render and (with React.memo on ChartOverlay) skips
// reconciling these divs entirely. That keeps the DOM mutations from the
// native mouse listener intact even when meshHistory polls new data.
const CHART_CURSOR_STYLE: React.CSSProperties = {
  position: 'absolute', top: 0, bottom: 0, left: 0, width: 1,
  background: 'rgba(255,255,255,0.85)',
  boxShadow: '0 0 3px rgba(255,255,255,0.5)',
  opacity: 0,
  transform: 'translate3d(-1px,0,0)',
  willChange: 'transform, opacity',
  pointerEvents: 'none',
};
const CHART_DRAG_STYLE: React.CSSProperties = {
  position: 'absolute', top: 0, bottom: 0, left: 0, width: 0,
  background: 'rgba(212,0,0,0.18)',
  borderLeft: '1px solid rgba(212,0,0,0.55)',
  borderRight: '1px solid rgba(212,0,0,0.55)',
  opacity: 0,
  transform: 'translate3d(0,0,0)',
  willChange: 'transform, width, opacity',
  pointerEvents: 'none',
};
const CHART_OVERLAY_WRAP_STYLE: React.CSSProperties = {
  position: 'absolute', inset: 0, pointerEvents: 'none', overflow: 'hidden',
};
// Per-chart Tooltip is hidden (shared hover row replaces it) but kept mounted
// so recharts still updates its activeIndex on hover, which drives activeDot.
const NULL_TOOLTIP = () => null;
const HIDDEN_WRAPPER_STYLE: React.CSSProperties = { display: 'none' };
const ChartOverlay = React.memo(function ChartOverlay() {
  return (
    <div style={CHART_OVERLAY_WRAP_STYLE}>
      <div data-chart-cursor="node-detail" style={CHART_CURSOR_STYLE} />
      <div data-chart-drag="node-detail" style={CHART_DRAG_STYLE} />
    </div>
  );
});
ChartOverlay.displayName = 'ChartOverlay';

// Tooltip content that debounces re-renders — cursor line tracks ASAP (recharts
// native), but the numeric details only update once the mouse has settled for
// `delay` ms, so the box doesn't thrash on every pixel of motion. Recharts
// clones this element with live { active, label, payload } props each render.
function DebouncedTooltip({ active, label, payload, labelFormatter, formatter, contentStyle, delay = 200 }: any) {
  const [snap, setSnap] = useState<{ active: boolean; label: any; payload: any[] } | null>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = setTimeout(() => {
      setSnap({ active: !!active, label, payload: payload ?? [] });
    }, delay);
    return () => { if (timerRef.current) clearTimeout(timerRef.current); };
  }, [active, label, delay, payload]);
  if (!snap?.active || !snap.payload?.length) return null;
  const rows = snap.payload;
  return (
    <div style={{ ...(contentStyle ?? {}), padding: '6px 10px', fontSize: 12, lineHeight: '1.5em' }}>
      <div style={{ color: '#a1a1aa', marginBottom: 2 }}>
        {labelFormatter ? labelFormatter(snap.label) : String(snap.label)}
      </div>
      {rows.map((p: any, i: number) => {
        const result = formatter ? formatter(p.value, p.name, p, i, rows) : [p.value, p.name];
        const value = Array.isArray(result) ? result[0] : result;
        const name = Array.isArray(result) ? result[1] : p.name;
        return (
          <div key={i} style={{ color: p.color || p.stroke }}>
            <span style={{ color: '#a1a1aa' }}>{name}: </span>
            <span>{value}</span>
          </div>
        );
      })}
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
