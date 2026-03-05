'use client';

import { useState } from 'react';
import { formatTimestamp, formatDuration } from '@sexy-logger/core/format';

/* eslint-disable @typescript-eslint/no-explicit-any */

function shortModel(model?: string): string {
  if (!model) return '';
  return model.replace('claude-', '').replace(/-\d{8}$/, '');
}

function UserMessage({ entry }: { entry: any }) {
  const content = entry.message?.content;
  const text =
    typeof content === 'string'
      ? content
      : Array.isArray(content)
        ? content
            .filter((b: any) => b.type === 'text')
            .map((b: any) => b.text ?? '')
            .join('\n')
        : '';

  return (
    <div className="border-l-2 border-[var(--color-user)] pl-3 py-2">
      <div className="flex items-center gap-2 mb-1">
        <span className="text-base font-bold text-[var(--color-user)]">USER</span>
        {entry.timestamp && (
          <span className="text-base text-[var(--color-muted)]">
            {formatTimestamp(entry.timestamp)}
          </span>
        )}
      </div>
      <div className="text-base whitespace-pre-wrap break-words">{text}</div>
    </div>
  );
}

function ThinkingBlockView({
  thinking,
  show,
}: {
  thinking: string;
  show: boolean;
}) {
  const [expanded, setExpanded] = useState(false);

  if (!show) return null;

  return (
    <div className="border-l-2 border-[var(--color-thinking)] pl-3 py-1 my-1">
      <button
        onClick={() => setExpanded(!expanded)}
        className="text-base text-[var(--color-thinking)] hover:underline cursor-pointer"
      >
        {expanded ? 'collapse thinking' : 'expand thinking'} ({thinking.length.toLocaleString()} chars)
      </button>
      <div className={`text-base text-[var(--color-muted)] whitespace-pre-wrap mt-1 font-mono ${expanded ? 'max-h-96 overflow-auto' : ''}`}>
        {thinking}
      </div>
    </div>
  );
}

function ToolUseView({
  name,
  input,
  show,
}: {
  name: string;
  input: Record<string, unknown>;
  show: boolean;
}) {
  const [expanded, setExpanded] = useState(false);

  if (!show) return null;

  return (
    <div className="border-l-2 border-[var(--color-tool)] pl-3 py-1 my-1">
      <button
        onClick={() => setExpanded(!expanded)}
        className="text-base font-bold text-[var(--color-tool)] hover:underline cursor-pointer"
      >
        {expanded ? '[-]' : '[+]'} {name}
      </button>
      {expanded && (
        <pre className="text-base text-[var(--color-muted)] mt-1 overflow-auto max-h-64 bg-[var(--color-background)] p-2 rounded">
          {JSON.stringify(input, null, 2)}
        </pre>
      )}
    </div>
  );
}

function AssistantMessage({
  entry,
  showThinking,
  showTools,
}: {
  entry: any;
  showThinking: boolean;
  showTools: boolean;
}) {
  const content = entry.message?.content;
  const model = entry.message?.model;
  const usage = entry.message?.usage;

  return (
    <div className="border-l-2 border-[var(--color-assistant)] pl-3 py-2">
      <div className="flex items-center gap-2 mb-1 flex-wrap">
        <span className="text-base font-bold text-[var(--color-assistant)]">
          ASSISTANT
        </span>
        {model && (
          <span className="text-base px-1.5 py-0.5 rounded bg-[var(--color-surface-hover)] text-[var(--color-muted)]">
            {shortModel(model)}
          </span>
        )}
        {entry.timestamp && (
          <span className="text-base text-[var(--color-muted)]">
            {formatTimestamp(entry.timestamp)}
          </span>
        )}
        {usage && (
          <span className="text-base text-[var(--color-muted)]">
            in:{usage.input_tokens?.toLocaleString()} out:{usage.output_tokens?.toLocaleString()}
            {usage.cache_read_input_tokens ? ` cache:${usage.cache_read_input_tokens.toLocaleString()}` : ''}
          </span>
        )}
      </div>
      {Array.isArray(content) &&
        content.map((block: any, i: number) => {
          if (block.type === 'thinking' && block.thinking) {
            return (
              <ThinkingBlockView
                key={i}
                thinking={block.thinking}
                show={showThinking}
              />
            );
          }
          if (block.type === 'text' && block.text) {
            return (
              <div
                key={i}
                className="text-base whitespace-pre-wrap break-words my-1"
              >
                {block.text}
              </div>
            );
          }
          if (block.type === 'tool_use' && block.name) {
            return (
              <ToolUseView
                key={i}
                name={block.name}
                input={block.input ?? {}}
                show={showTools}
              />
            );
          }
          return null;
        })}
    </div>
  );
}

function SystemMessage({ entry }: { entry: any }) {
  return (
    <div className="border-l-2 border-[var(--color-border)] pl-3 py-1">
      <span className="text-base text-[var(--color-muted)]">
        {entry.subtype === 'turn_duration' && entry.durationMs
          ? `turn: ${formatDuration(entry.durationMs)}`
          : `system: ${entry.subtype ?? 'event'}`}
        {entry.slug ? ` (${entry.slug})` : ''}
      </span>
    </div>
  );
}

export function MessageBlock({
  entry,
  showThinking,
  showTools,
}: {
  entry: any;
  showThinking: boolean;
  showTools: boolean;
}) {
  switch (entry.type) {
    case 'user':
      return <UserMessage entry={entry} />;
    case 'assistant':
      return (
        <AssistantMessage
          entry={entry}
          showThinking={showThinking}
          showTools={showTools}
        />
      );
    case 'system':
      return <SystemMessage entry={entry} />;
    default:
      return null;
  }
}
