'use client';

import { use, useEffect, useState, useRef, useCallback } from 'react';
import Link from 'next/link';
import type { SessionEntry } from '@/lib/types';
import { MessageBlock } from '@/components/viewer/MessageBlock';
import { PageContext } from '@/components/PageContext';

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

  useEffect(() => {
    const controller = new AbortController();

    async function stream() {
      try {
        const response = await fetch(
          `/api/sessions/${sessionId}?project=${encodeURIComponent(project)}&stream=true&types=user,assistant,system`,
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

  const filteredEntries = entries.filter((e) => {
    if (e.type === 'user' || e.type === 'system') return true;
    return e.type === 'assistant';
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
        <h2 className="text-base font-bold mt-1 break-all">
          Session: {sessionId}
        </h2>
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
