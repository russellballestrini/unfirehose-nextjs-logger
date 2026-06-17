'use client';

import { use, useEffect, useState, useRef, useCallback } from 'react';
import useSWR from 'swr';
import Link from 'next/link';
import type { SessionEntry } from '@unturf/unfirehose/types';
import { MessageBlock } from '@unturf/unfirehose-ui/viewer/MessageBlock';
import { PageContext } from '@unturf/unfirehose-ui/PageContext';
import { SessionPopover } from '@unturf/unfirehose-ui/SessionPopover';

const fetcher = (url: string) => fetch(url).then((r) => r.json());

export default function SessionViewerPage({
  params,
}: {
  params: Promise<{ project: string; sessionId: string }>;
}) {
  const { project, sessionId } = use(params);
  const [entries, setEntries] = useState<SessionEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [showThinking, setShowThinking] = useState(true);
  const [showTools, setShowTools] = useState(true);
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

  useEffect(() => {
    const controller = new AbortController();

    async function stream() {
      try {
        const response = await fetch(
          `/api/sessions/${sessionId}?project=${encodeURIComponent(project)}&stream=true&types=user,assistant,system,tool`,
          { signal: controller.signal }
        );
        if (!response.ok || !response.body) {
          setLoading(false);
          return;
        }

        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';

        while (true) {
          const { done, value } = await reader.read();
          if (done) break;

          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split('\n');
          buffer = lines.pop()!;

          const newEntries = lines
            .filter((l) => l.trim())
            .map((l) => {
              try {
                return JSON.parse(l);
              } catch {
                return null;
              }
            })
            .filter(Boolean);

          if (newEntries.length > 0) {
            setEntries((prev) => [...prev, ...newEntries]);
          }
        }
      } catch (err) {
        if (!(err instanceof DOMException && err.name === 'AbortError')) {
          console.error('Stream error:', err);
        }
      }
      setLoading(false);
    }

    stream();
    return () => controller.abort();
  }, [project, sessionId]);

  useEffect(() => {
    if (autoScroll && scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [entries, autoScroll]);

  const filteredEntries = entries.filter((e: any) => {
    const role = e.role ?? e.type;
    return role === 'user' || role === 'assistant' || role === 'system' || role === 'tool';
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
        summary={`Session ${sessionId.slice(0, 8)}. ${filteredEntries.length} entries${loading ? ' (streaming...)' : ''}. Project: ${decodeURIComponent(project)}.`}
        metrics={{
          session_id: sessionId,
          project: decodeURIComponent(project),
          entries: filteredEntries.length,
          loading: loading ? 'yes' : 'no',
          show_thinking: showThinking ? 'yes' : 'no',
          show_tools: showTools ? 'yes' : 'no',
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
        <div className="flex items-center gap-3 mt-1">
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
        <div className="flex items-center gap-4 mt-2">
          <span className="text-base text-[var(--color-muted)]">
            {filteredEntries.length} entries
            {loading && ' (streaming...)'}
          </span>
          <label className="flex items-center gap-1.5 text-base text-[var(--color-muted)] cursor-pointer">
            <input
              type="checkbox"
              checked={showThinking}
              onChange={(e) => setShowThinking(e.target.checked)}
              className="accent-[var(--color-thinking)]"
            />
            Thinking
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
            Streaming session data...
          </div>
        )}
      </div>
    </div>
  );
}
