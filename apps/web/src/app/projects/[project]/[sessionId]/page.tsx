'use client';

import { use, useEffect, useState, useRef, useCallback } from 'react';
import useSWR from 'swr';
import Link from 'next/link';
import type { SessionEntry } from '@unturf/unfirehose/types';
import { MessageBlock } from '@unturf/unfirehose-ui/viewer/MessageBlock';
import { PageContext } from '@unturf/unfirehose-ui/PageContext';
import { SessionPopover } from '@unturf/unfirehose-ui/SessionPopover';

const fetcher = (url: string) => fetch(url).then((r) => r.json());

const HARNESS_COLORS: Record<string, string> = {
  'claude-code': '#a78bfa',
  'agnt': '#34d399',
  'uncloseai': '#60a5fa',
  'uncloseai-cli': '#60a5fa',
  'fetch': '#fbbf24',
  'arborist': '#fb7185',
  'aborist': '#fb7185',
};

function harnessColor(h: string): string {
  return HARNESS_COLORS[h] ?? '#9ca3af';
}

function HarnessBadge({ harness }: { harness: string }) {
  const c = harnessColor(harness);
  return (
    <span
      className="px-1.5 py-0.5 rounded text-xs font-mono shrink-0"
      style={{
        backgroundColor: `${c}22`,
        color: c,
        border: `1px solid ${c}55`,
      }}
      title={`Harness: ${harness}`}
    >
      {harness}
    </span>
  );
}

export default function SessionViewerPage({
  params,
}: {
  params: Promise<{ project: string; sessionId: string }>;
}) {
  const { project, sessionId } = use(params);
  const [showThinking, setShowThinking] = useState(true);
  const [showTools, setShowTools] = useState(true);
  const [reasoningOnly, setReasoningOnly] = useState(false);
  const [autoScroll, setAutoScroll] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);
  const { data: projectData } = useSWR<{ originalPath: string }>(
    `/api/projects/${project}/sessions`,
    fetcher
  );
  const { data: tmuxData } = useSWR<{ sessions: string[] }>(
    '/api/tmux/stream',
    fetcher,
    { refreshInterval: 10000 }
  );
  const tmuxSessions = tmuxData?.sessions ?? [];
  // Match project name to tmux session (tmux sessions often use the project dir name)
  const decodedProject = decodeURIComponent(project);
  const projectSuffix = decodedProject.split('-').pop() || '';
  const matchingTmux = tmuxSessions.find(s => decodedProject.includes(s) || (projectSuffix.length > 3 && s.includes(projectSuffix)));

  // Derive harness from project name. Format: "{harness}:{slug}" for native harnesses,
  // bare encoded path for claude-code.
  const colonIdx = decodedProject.indexOf(':');
  const harness = colonIdx < 0 ? 'claude-code' : decodedProject.slice(0, colonIdx);

  // `project` from Next.js params is the raw URL-encoded segment (e.g. "agnt%3Achat") —
  // it must NOT be encoded again, or special chars (e.g. ":") double-encode and the server
  // resolves the wrong harness path.
  const { data: sessionData, isLoading: loading } = useSWR<{ entries: SessionEntry[]; count: number }>(
    `/api/sessions/${sessionId}?project=${project}&types=user,assistant,system,tool`,
    fetcher,
  );
  const entries: SessionEntry[] = sessionData?.entries ?? [];

  useEffect(() => {
    if (autoScroll && scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [entries, autoScroll]);

  const hasReasoning = (e: any) =>
    Array.isArray(e?.content) && e.content.some((b: any) => b?.type === 'reasoning' && (b?.text ?? '').length > 0);

  const reasoningCount = entries.reduce((n, e) => n + (hasReasoning(e) ? 1 : 0), 0);

  const filteredEntries = entries.filter((e: any) => {
    const role = e.role ?? e.type;
    const rolePass = role === 'user' || role === 'assistant' || role === 'system' || role === 'tool';
    if (!rolePass) return false;
    if (reasoningOnly) return hasReasoning(e);
    return true;
  });

  const scrollToBottom = useCallback(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, []);

  return (
    <div className="flex flex-col h-[calc(100vh-3rem)]">
      <PageContext
        pageType="session-viewer"
        summary={`Session ${sessionId.slice(0, 8)}. ${filteredEntries.length} entries${loading ? ' (loading...)' : ''}. Project: ${decodeURIComponent(project)}.`}
        metrics={{
          session_id: sessionId,
          project: decodeURIComponent(project),
          entries: filteredEntries.length,
          reasoning_blocks: reasoningCount,
          loading: loading ? 'yes' : 'no',
          show_thinking: showThinking ? 'yes' : 'no',
          show_tools: showTools ? 'yes' : 'no',
          reasoning_only: reasoningOnly ? 'yes' : 'no',
        }}
      />
      {/* Header */}
      <div className="shrink-0 mb-4">
        <Link
          href={`/projects/${project}`}
          className="text-base text-[var(--color-muted)] hover:text-[var(--color-foreground)]"
        >
          &larr; Sessions
        </Link>
        <div className="flex items-center gap-3 mt-1 flex-wrap">
          <HarnessBadge harness={harness} />
          <h2 className="text-base font-bold break-all">
            Session: {sessionId}
          </h2>
          <SessionPopover
            sessionId={sessionId}
            project={project}
            projectPath={projectData?.originalPath}
            label="actions"
          />
          {matchingTmux && (
            <Link
              href={`/tmux/${encodeURIComponent(matchingTmux)}`}
              className="px-2 py-1 text-xs font-bold bg-blue-500 text-white rounded hover:opacity-90 flex items-center gap-1.5"
            >
              <span className="w-1.5 h-1.5 rounded-full bg-white animate-pulse" />
              Watch terminal
            </Link>
          )}
        </div>
        <div className="flex items-center gap-4 mt-2 flex-wrap">
          <span className="text-base text-[var(--color-muted)]">
            {filteredEntries.length} entries
            {loading && ' (loading…)'}
          </span>
          {reasoningCount > 0 && (
            <span className="text-base" style={{ color: 'var(--color-thinking)' }}>
              {reasoningCount} reasoning {reasoningCount === 1 ? 'block' : 'blocks'}
            </span>
          )}
          <label className="flex items-center gap-1.5 text-base text-[var(--color-muted)] cursor-pointer">
            <input
              type="checkbox"
              checked={showThinking}
              onChange={(e) => setShowThinking(e.target.checked)}
              className="accent-[var(--color-thinking)]"
            />
            Thinking
          </label>
          <label
            className={`flex items-center gap-1.5 text-base cursor-pointer ${reasoningCount === 0 ? 'opacity-40 cursor-not-allowed' : 'text-[var(--color-muted)]'}`}
            title={reasoningCount === 0 ? 'No reasoning blocks in this session' : 'Show only entries that contain reasoning'}
          >
            <input
              type="checkbox"
              checked={reasoningOnly}
              disabled={reasoningCount === 0}
              onChange={(e) => {
                setReasoningOnly(e.target.checked);
                if (e.target.checked) setShowThinking(true);
              }}
              className="accent-[var(--color-thinking)]"
            />
            Reasoning only
          </label>
          <label className="flex items-center gap-1.5 text-base text-[var(--color-muted)] cursor-pointer">
            <input
              type="checkbox"
              checked={showTools}
              onChange={(e) => setShowTools(e.target.checked)}
              className="accent-[var(--color-tool)]"
            />
            Tools
          </label>
          <label className="flex items-center gap-1.5 text-base text-[var(--color-muted)] cursor-pointer">
            <input
              type="checkbox"
              checked={autoScroll}
              onChange={(e) => setAutoScroll(e.target.checked)}
              className="accent-[var(--color-accent)]"
            />
            Auto-scroll
          </label>
          <button
            onClick={scrollToBottom}
            className="text-base text-[var(--color-accent)] hover:underline"
          >
            Jump to end
          </button>
        </div>
      </div>

      {/* Message stream */}
      <div
        ref={scrollRef}
        className="flex-1 overflow-auto space-y-2"
      >
        {filteredEntries.map((entry, i) => (
          <MessageBlock
            key={('uuid' in entry ? String(entry.uuid) : '') || i}
            entry={entry}
            showThinking={showThinking}
            showTools={showTools}
          />
        ))}
        {loading && (
          <div className="text-center py-4 text-[var(--color-muted)] text-base">
            Loading session data…
          </div>
        )}
      </div>
    </div>
  );
}
