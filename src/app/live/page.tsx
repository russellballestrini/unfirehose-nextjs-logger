'use client';

import { useEffect, useState, useRef } from 'react';
import { formatTimestamp } from '@/lib/format';
import { decodeProjectName } from '@/lib/claude-paths-client';
import { PageContext } from '@/components/PageContext';

/* eslint-disable @typescript-eslint/no-explicit-any */

interface LiveEntry {
  type: 'entry';
  project: string;
  projectName: string;
  sessionId: string;
  entry: any;
}

interface LiveSession {
  project: string;
  projectName: string;
  sessionId: string;
}

const SESSION_COLORS = [
  '#10b981', '#a78bfa', '#60a5fa', '#f472b6', '#fbbf24',
  '#34d399', '#818cf8', '#38bdf8', '#fb923c', '#a3e635',
  '#e879f9', '#2dd4bf', '#f87171', '#facc15', '#4ade80',
  '#c084fc', '#22d3ee', '#fb7185', '#a8a29e', '#84cc16',
  '#67e8f9',
];

function getSessionColor(index: number): string {
  return SESSION_COLORS[index % SESSION_COLORS.length];
}

function extractText(entry: any): string {
  if (!entry?.message?.content) return '';
  const content = entry.message.content;
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';

  return content
    .filter((b: any) => b.type === 'text')
    .map((b: any) => b.text ?? '')
    .join(' ');
}

function extractThinking(entry: any): string | null {
  if (entry?.type !== 'assistant' || !Array.isArray(entry?.message?.content)) return null;
  const block = entry.message.content.find((b: any) => b.type === 'thinking');
  return block?.thinking ?? null;
}

function extractTools(entry: any): { name: string; detail?: string }[] {
  if (entry?.type !== 'assistant' || !Array.isArray(entry?.message?.content)) return [];
  return entry.message.content
    .filter((b: any) => b.type === 'tool_use')
    .map((b: any) => {
      let detail: string | undefined;
      if (b.name === 'Bash' && b.input?.command) {
        detail = b.input.command;
      } else if (b.name === 'Read' && b.input?.file_path) {
        detail = b.input.file_path;
      } else if (b.name === 'Write' && b.input?.file_path) {
        detail = b.input.file_path;
      } else if (b.name === 'Edit' && b.input?.file_path) {
        detail = b.input.file_path;
      } else if (b.name === 'Glob' && b.input?.pattern) {
        detail = b.input.pattern;
      } else if (b.name === 'Grep' && b.input?.pattern) {
        detail = b.input.pattern;
      }
      return { name: b.name, detail };
    });
}

function shortModel(model?: string): string {
  if (!model) return '';
  return model.replace('claude-', '').replace(/-\d{8}$/, '');
}

export default function LivePage() {
  const [entries, setEntries] = useState<LiveEntry[]>([]);
  const [sessions, setSessions] = useState<LiveSession[]>([]);
  const [connected, setConnected] = useState(false);
  const [showThinking, setShowThinking] = useState(false);
  const [autoScroll, setAutoScroll] = useState(true);
  const scrollRef = useRef<HTMLDivElement>(null);
  const sessionColorMap = useRef<Map<string, number>>(new Map());

  function getColorForSession(sessionId: string): string {
    if (!sessionColorMap.current.has(sessionId)) {
      sessionColorMap.current.set(sessionId, sessionColorMap.current.size);
    }
    return getSessionColor(sessionColorMap.current.get(sessionId)!);
  }

  useEffect(() => {
    let eventSource: EventSource | null = null;
    let reconnectTimeout: ReturnType<typeof setTimeout>;

    function connect() {
      eventSource = new EventSource('/api/live');

      eventSource.onopen = () => setConnected(true);

      eventSource.onmessage = (event) => {
        try {
          const data = JSON.parse(event.data);

          if (data.type === 'sessions') {
            setSessions(data.sessions);
          } else if (data.type === 'entry') {
            setEntries((prev) => {
              const next = [...prev, data];
              // Keep last 500 entries to prevent memory bloat
              return next.length > 500 ? next.slice(-500) : next;
            });
          }
        } catch { /* skip parse errors */ }
      };

      eventSource.onerror = () => {
        setConnected(false);
        eventSource?.close();
        reconnectTimeout = setTimeout(connect, 3000);
      };
    }

    connect();

    return () => {
      eventSource?.close();
      clearTimeout(reconnectTimeout);
    };
  }, []);

  // Auto-scroll: stick to bottom when new entries arrive
  useEffect(() => {
    if (autoScroll && scrollRef.current) {
      requestAnimationFrame(() => {
        if (scrollRef.current) {
          scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
        }
      });
    }
  }, [entries, autoScroll]);

  // Detect manual scroll-up to disable auto-scroll, re-enable when scrolled to bottom
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const onScroll = () => {
      const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
      setAutoScroll(atBottom);
    };
    el.addEventListener('scroll', onScroll, { passive: true });
    return () => el.removeEventListener('scroll', onScroll);
  }, []);

  // Count unique active sessions from recent entries
  const activeSessionIds = new Set(
    entries.slice(-100).map((e) => e.sessionId)
  );

  return (
    <div className="flex flex-col h-[calc(100vh-3rem)]">
      <PageContext
        pageType="live"
        summary={`Live stream. ${connected ? 'Connected' : 'Disconnected'}. ${sessions.length} hot sessions, ${activeSessionIds.size} active, ${entries.length} entries buffered.`}
        metrics={{
          connected: connected ? 'yes' : 'no',
          hot_sessions: sessions.length,
          active_sessions: activeSessionIds.size,
          buffered_entries: entries.length,
        }}
        details={sessions.map((s) => `${s.projectName} (${s.sessionId.slice(0, 8)})`).join('\n')}
      />
      {/* Header */}
      <div className="shrink-0 mb-3">
        <div className="flex items-center gap-3">
          <h2 className="text-lg font-bold">Live</h2>
          <span
            className={`inline-block w-2 h-2 rounded-full ${
              connected ? 'bg-[var(--color-accent)] animate-pulse' : 'bg-[var(--color-error)]'
            }`}
          />
          <span className="text-base text-[var(--color-muted)]">
            {connected ? 'streaming' : 'reconnecting...'}
          </span>
          <span className="text-base text-[var(--color-muted)]">
            {sessions.length} hot sessions
          </span>
          <span className="text-base text-[var(--color-muted)]">
            {activeSessionIds.size} active
          </span>
        </div>

        <div className="flex items-center gap-4 mt-2">
          <label className="flex items-center gap-1.5 text-base text-[var(--color-muted)] cursor-pointer">
            <input
              type="checkbox"
              checked={showThinking}
              onChange={(e) => setShowThinking(e.target.checked)}
              className="accent-[var(--color-thinking)]"
            />
            Show thinking
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
            onClick={() => setEntries([])}
            className="text-base text-[var(--color-muted)] hover:text-[var(--color-foreground)]"
          >
            Clear
          </button>
        </div>

        {/* Active sessions bar */}
        {sessions.length > 0 && (
          <div className="flex flex-wrap gap-1.5 mt-2">
            {sessions.map((s) => (
              <span
                key={s.sessionId}
                className="text-base px-2 py-0.5 rounded-full border"
                style={{
                  borderColor: getColorForSession(s.sessionId),
                  color: getColorForSession(s.sessionId),
                }}
              >
                {s.projectName}
                <span className="opacity-50 ml-1">
                  {s.sessionId.slice(0, 6)}
                </span>
              </span>
            ))}
          </div>
        )}
      </div>

      {/* Live stream */}
      <div
        ref={scrollRef}
        className="flex-1 overflow-auto space-y-0.5 font-mono text-base"
      >
        {entries.length === 0 && connected && (
          <div className="text-[var(--color-muted)] text-base py-8 text-center">
            Watching for activity across all sessions...
          </div>
        )}

        {entries.map((item, i) => {
          const e = item.entry;
          const color = getColorForSession(item.sessionId);
          const text = extractText(e);
          const thinking = showThinking ? extractThinking(e) : null;
          const tools = extractTools(e);
          const model = e?.message?.model;
          const usage = e?.message?.usage;

          const typeTag =
            e.type === 'user'
              ? 'USR'
              : e.type === 'assistant'
                ? 'AST'
                : 'SYS';

          const typeBg =
            e.type === 'user'
              ? 'var(--color-user)'
              : e.type === 'assistant'
                ? 'var(--color-assistant)'
                : 'var(--color-muted)';

          return (
            <div
              key={i}
              className="flex gap-2 py-1 px-2 hover:bg-[var(--color-surface)] rounded leading-tight"
            >
              {/* Session color dot + project tag */}
              <div className="shrink-0 flex items-start gap-1.5 w-40">
                <span
                  className="inline-block w-2 h-2 rounded-full mt-1 shrink-0"
                  style={{ background: color }}
                />
                <span
                  className="break-words"
                  style={{ color }}
                >
                  {item.projectName}
                </span>
              </div>

              {/* Type badge */}
              <span
                className="shrink-0 text-base font-bold px-1 rounded mt-0.5"
                style={{ color: typeBg }}
              >
                {typeTag}
              </span>

              {/* Timestamp */}
              <span className="shrink-0 text-[var(--color-muted)] w-20 mt-0.5">
                {e.timestamp
                  ? formatTimestamp(e.timestamp).slice(11)
                  : ''}
              </span>

              {/* Content */}
              <div className="flex-1 min-w-0">
                {/* Model + tokens for assistant */}
                {e.type === 'assistant' && model && (
                  <span className="text-[var(--color-muted)] mr-2">
                    [{shortModel(model)}
                    {usage
                      ? ` in:${usage.input_tokens?.toLocaleString()} out:${usage.output_tokens?.toLocaleString()}`
                      : ''}
                    ]
                  </span>
                )}

                {/* System subtype */}
                {e.type === 'system' && (
                  <span className="text-[var(--color-muted)]">
                    {e.subtype ?? 'event'}
                    {e.durationMs ? ` (${(e.durationMs / 1000).toFixed(1)}s)` : ''}
                  </span>
                )}

                {/* Tool calls */}
                {tools.length > 0 && (
                  <span className="text-[var(--color-tool)]">
                    {tools.map((t, ti) => (
                      <span key={ti}>
                        [{t.name}]{t.detail ? <span className="text-[var(--color-muted)]"> {t.detail}</span> : ''}{' '}
                      </span>
                    ))}
                  </span>
                )}

                {/* Text content */}
                {text && (
                  <span className="text-[var(--color-foreground)] break-words">
                    {text}
                  </span>
                )}

                {/* Thinking preview */}
                {thinking && (
                  <div className="text-[var(--color-thinking)] opacity-60 mt-0.5 italic">
                    {thinking}
                  </div>
                )}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
