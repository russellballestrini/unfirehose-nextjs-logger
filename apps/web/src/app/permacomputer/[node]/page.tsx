'use client';

import { fetcher } from '@unturf/unfirehose-ui/fetcher';

import { DEFAULT_KWH_RATE as PRICING_DEFAULT_KWH_RATE } from '@unturf/unfirehose/pricing';

import { useParams } from 'next/navigation';
import useSWR from 'swr';
import Link from 'next/link';
import React, { useState, useEffect, useCallback, useDeferredValue, useMemo, useRef } from 'react';
import { TimeRangeSelect, useTimeRange, getTimeRangeMinutes, TIME_RANGE_OPTIONS } from '@unturf/unfirehose-ui/TimeRangeSelect';
import { UPlotTimeChart, type UPlotSeries } from '@/components/UPlotTimeChart';
import { ThermalPanel } from '@/components/ThermalPanel';
import { AXIS_TICK_SM } from '@unturf/unfirehose-ui/chart-theme';
import { ansiToHtml } from '@unturf/unfirehose-ui/ansi';
import { utcToLocalDate, fmtLocalHHMM, fmtLocalDateTime } from '@/lib/local-time';
import { toNodeSeries, seriesBounds } from '@/lib/node-series';
import { memCapGB as hardwareMemCapGB } from '@/lib/mesh-probe';
import { GaugeTrack } from '@unturf/unfirehose-ui/Gauge';
import { KV } from '@unturf/unfirehose-ui/KV';
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

// Re-exported from @unturf/unfirehose/pricing so pages and server cost math
// cannot drift apart — this file used 0.31 while pricing.ts used 0.33.
const DEFAULT_KWH_RATE = PRICING_DEFAULT_KWH_RATE;

/* eslint-disable @typescript-eslint/no-explicit-any */

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
import {
  OverviewTab, HarnessesTab, ProcessesTab, BootstrapTab, SettingsTab,
  Section, NULL_TOOLTIP, HIDDEN_WRAPPER_STYLE,
} from './tabs';

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
    // One node's page needs one node's history. Unfiltered, this pulled the
    // whole fleet's timeline every LIVE_MS and threw all but one host away.
    `/api/mesh/history?hours=${chartHours}&hostname=${encodeURIComponent(host)}`,
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
    // Range must cover from the zoom's LEFT edge all the way to dataMax,
    // not just the zoom span. If we snap on span alone, a drag-zoom into
    // an old window (e.g. yesterday in a 28d view) snaps range to '24h'
    // = last 24h, SWR refetches recent-only data, and the zoom region is
    // outside the fetched data → blank chart.
    const cd = chartDataRef.current;
    const dataMaxMs = cd && cd.length > 0 ? cd[cd.length - 1].tsMs : hi;
    const required = Math.max(dataMaxMs - lo, hi - lo);
    const next = closestRangeForZoom(required);
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

  // Hydrate SSH form from config — never while editing, or every SWR
  // revalidation clobbers in-progress changes mid-keystroke.
  const sshOriginalName = useRef<string | undefined>(undefined);
  useEffect(() => {
    if (sshEditing) return;
    if (!sshConfig?.hosts) return;
    const found = sshConfig.hosts.find((h: any) => h.name === host || h.hostname === host);
    if (found) { setSshForm(found); sshOriginalName.current = found.name; }
  }, [sshConfig, host, sshEditing]);

  const saveSshHost = async () => {
    setSshSaving(true);
    try {
      const res = await fetch('/api/ssh-config', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        // originalName lets the server treat a name change as a rename of the
        // existing block instead of appending a duplicate; hash makes the save
        // fail with 409 if the file changed since we loaded it.
        body: JSON.stringify({ ...sshForm, originalName: sshOriginalName.current, hash: sshConfig?.hash }),
      });
      if (res.status === 409) {
        await mutateSsh();
        alert('SSH config changed on disk since this page loaded — reloaded it. Please re-apply your edit.');
      } else if (!res.ok) {
        alert((await res.json().catch(() => ({}))).error ?? 'Failed to save host');
      } else {
        await mutateSsh();
        setSshEditing(false);
      }
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

  // probe.memory exposes totalGB directly (the node probe API converts
  // /proc/meminfo MemTotal to GB before responding). The previous read
  // for `totalKB` evaluated to 0 since that field doesn't exist on this
  // endpoint, which is why memCapGB ended up 0 and the watermark line
  // never drew.
  const memTotalGB = useMemo(
    () => probe?.memory?.totalGB ?? 0,
    [probe?.memory?.totalGB],
  );
  // Hardware DIMM cap for the Memory chart's watermark. Same rounding the
  // mesh probe applies, from the same place, rather than a third copy.
  const memCapGB = useMemo(() => hardwareMemCapGB(memTotalGB), [memTotalGB]);
  // useDeferredValue makes the timeline a low-priority input: when SWR polls
  // new mesh data every 6s, React renders the chart subtree with the OLD
  // timeline immediately (so the parent re-render is cheap) and schedules a
  // re-render with the new timeline at low priority. Mouse moves during that
  // low-priority work INTERRUPT it — React yields the main thread back to
  // input, so our native listener keeps firing and the cursor stays smooth.
  const timeline = meshHistory?.timeline;
  const deferredTimeline = useDeferredValue(timeline);
  // Live (non-deferred) data bounds for pan/zoom decisions. useDeferredValue
  // intentionally lags so the chart renders smoothly during SWR polls, but
  // pan logic must see the latest known dataMin so it doesn't falsely think
  // we ran out of data and trigger a range-bump.
  const liveDataMinMaxRef = useRef<{ min: number; max: number }>({ min: 0, max: 0 });
  useEffect(() => {
    if (!Array.isArray(timeline) || timeline.length === 0) return;
    const bounds = seriesBounds(toNodeSeries(timeline, host, { memTotalGB: 0, memCapGB: 0, kwhRate: 0 }));
    if (bounds) liveDataMinMaxRef.current = bounds;
  }, [timeline, host]);
  const chartData = useMemo(
    () => toNodeSeries(deferredTimeline, host, { memTotalGB, memCapGB, kwhRate }),
    [deferredTimeline, host, memTotalGB, memCapGB, kwhRate],
  );

  // One bag rather than twenty-four props on each tab: these are the
  // page's state, and every tab reads some of it.
  const tabProps = { applyZoom, bootFilter, bootHarness, bootHost, bootStatuses, chartData, chartDataRef, chartEngine, closestRangeForZoom, diskOverride, host, hoverTimerRef, isLocal, ispCost, kwhRate, liveDataMinMaxRef, loadPerCore, mem, memPct, node, previewContent, previewRef, previewSession, probe, probeLoading, range, rangeRef, saveSetting, saveSshHost, setBootFilter, setDiskOverride, setHoverInfo, setIspCost, setKwhRate, setPreviewSession, setRange, setSshEditing, setSshForm, setWattsOverride, setZoomDomain, sshEditing, sshForm, sshSaving, sys, tmuxData, toggleEngine, viewMaxRef, viewMinRef, wattsOverride, zoomDomain, zoomDrivenRangeRef };

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
            up {node.uptime} &middot;{' '}
            {(() => {
              const counts: Record<string, number> = node.harnessCounts ?? {};
              const total = Object.values(counts).reduce((a, b) => a + b, 0);
              if (total > 0) {
                return Object.entries(counts).map(([k, n]) => `${n} ${k}`).join(', ');
              }
              return `${node.claudeProcesses ?? 0} claudes`;
            })()}
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
      {/* space-y-6 matches our grid's own gap-6, so the seam between the
          grid, our thermal panel and our charts is the same gutter as the
          one between two cards inside the grid. As a bare fragment these
          blocks butted straight against each other. */}
      {activeTab === 'Overview' && <OverviewTab {...tabProps} />}
      {activeTab === 'Harnesses' && <HarnessesTab {...tabProps} />}
      {activeTab === 'Processes' && <ProcessesTab {...tabProps} />}

      {/* ===== BOOTSTRAP TAB ===== */}
      {activeTab === 'Bootstrap' && <BootstrapTab {...tabProps} />}

      {/* ===== SETTINGS TAB ===== */}
      {activeTab === 'Settings' && <SettingsTab {...tabProps} />}
    </div>
  );
}

// Static style refs for the chart overlay — module-level so React sees the same
// reference on every render and (with React.memo on ChartOverlay) skips
// reconciling these divs entirely. That keeps the DOM mutations from the
// native mouse listener intact even when meshHistory polls new data.
