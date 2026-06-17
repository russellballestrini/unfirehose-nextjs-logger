'use client';

import { useState } from 'react';
import Markdown from 'react-markdown';
import { formatTimestamp, formatDuration } from '@unturf/unfirehose/format';

/* eslint-disable @typescript-eslint/no-explicit-any */

/**
 * Renders a canonical unfirehose/1.0 message.
 *
 * Schema:
 *   { type: "message", role: "user"|"assistant"|"system"|"tool",
 *     content: [{ type: "text"|"reasoning"|"tool-call"|"tool-result"|"image"|"file", ... }],
 *     model?, usage?, timestamp?, subtype?, durationMs? }
 */

function shortModel(model?: string): string {
  if (!model) return '';
  return model.replace('claude-', '').replace(/-\d{8}$/, '');
}

function joinText(content: any[]): string {
  if (!Array.isArray(content)) return '';
  return content
    .filter((b: any) => b?.type === 'text')
    .map((b: any) => b.text ?? '')
    .join('\n');
}

function UserMessage({ entry }: { entry: any }) {
  const text = joinText(entry.content);

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
      <div className="text-base break-words md-content">
        <Markdown>{text}</Markdown>
      </div>
    </div>
  );
}

function ReasoningBlockView({ text, show }: { text: string; show: boolean }) {
  const [expanded, setExpanded] = useState(false);
  if (!show) return null;
  return (
    <div className="border-l-2 border-[var(--color-thinking)] pl-3 py-1 my-1">
      <button
        onClick={() => setExpanded(!expanded)}
        className="text-base text-[var(--color-thinking)] hover:underline cursor-pointer"
      >
        {expanded ? 'collapse thinking' : 'expand thinking'} ({text.length.toLocaleString()} chars)
      </button>
      <div className={`text-base text-[var(--color-muted)] whitespace-pre-wrap mt-1 font-mono ${expanded ? 'max-h-96 overflow-auto' : ''}`}>
        {text}
      </div>
    </div>
  );
}

function ToolCallView({
  name,
  input,
  show,
}: {
  name: string;
  input: Record<string, unknown>;
  show: boolean;
}) {
  if (!show) return null;
  return (
    <div className="border-l-2 border-[var(--color-tool)] pl-3 py-1 my-1">
      <span className="text-base font-bold text-[var(--color-tool)]">{name}</span>
      <pre className="text-base text-[var(--color-muted)] mt-1 overflow-auto max-h-64 bg-[var(--color-background)] p-2 rounded">
        {JSON.stringify(input, null, 2)}
      </pre>
    </div>
  );
}

function ToolResultView({
  output,
  isError,
  toolName,
  show,
}: {
  output: any;
  isError: boolean;
  toolName?: string;
  show: boolean;
}) {
  const [expanded, setExpanded] = useState(false);
  if (!show) return null;
  const rendered = typeof output === 'string' ? output : JSON.stringify(output, null, 2);
  const accent = isError ? 'var(--color-user)' : 'var(--color-tool)';
  return (
    <div className="border-l-2 pl-3 py-1 my-1" style={{ borderColor: accent }}>
      <button
        onClick={() => setExpanded(!expanded)}
        className="text-base hover:underline cursor-pointer"
        style={{ color: accent }}
      >
        {toolName ?? 'tool'} → {isError ? 'error' : 'result'} ({rendered.length.toLocaleString()} chars)
        {expanded ? ' (collapse)' : ' (expand)'}
      </button>
      {expanded && (
        <pre className="text-base text-[var(--color-muted)] mt-1 overflow-auto max-h-64 bg-[var(--color-background)] p-2 rounded whitespace-pre-wrap">
          {rendered}
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
  const content = entry.content;
  const model = entry.model;
  const usage = entry.usage;

  // unfirehose/1.0 usage shape: { inputTokens, outputTokens, inputTokenDetails: { cacheReadTokens, cacheWriteTokens } }
  const inputTokens = usage?.inputTokens ?? usage?.input_tokens;
  const outputTokens = usage?.outputTokens ?? usage?.output_tokens;
  const cacheReadTokens = usage?.inputTokenDetails?.cacheReadTokens ?? usage?.cache_read_input_tokens;

  return (
    <div className="border-l-2 border-[var(--color-assistant)] pl-3 py-2">
      <div className="flex items-center gap-2 mb-1 flex-wrap">
        <span className="text-base font-bold text-[var(--color-assistant)]">ASSISTANT</span>
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
        {usage && (inputTokens != null || outputTokens != null) && (
          <span className="text-base text-[var(--color-muted)]">
            in:{inputTokens?.toLocaleString() ?? 0} out:{outputTokens?.toLocaleString() ?? 0}
            {cacheReadTokens ? ` cache:${cacheReadTokens.toLocaleString()}` : ''}
          </span>
        )}
      </div>
      {Array.isArray(content) &&
        content.map((block: any, i: number) => {
          if (block.type === 'reasoning' && block.text) {
            return <ReasoningBlockView key={i} text={block.text} show={showThinking} />;
          }
          if (block.type === 'text' && block.text) {
            return (
              <div key={i} className="text-base break-words my-1 md-content">
                <Markdown>{block.text}</Markdown>
              </div>
            );
          }
          if (block.type === 'tool-call' && block.toolName) {
            return (
              <ToolCallView
                key={i}
                name={block.toolName}
                input={(block.input as Record<string, unknown>) ?? {}}
                show={showTools}
              />
            );
          }
          return null;
        })}
    </div>
  );
}

function ToolMessage({
  entry,
  showTools,
}: {
  entry: any;
  showTools: boolean;
}) {
  if (!Array.isArray(entry.content)) return null;
  return (
    <>
      {entry.content.map((block: any, i: number) =>
        block.type === 'tool-result' ? (
          <ToolResultView
            key={i}
            output={block.output}
            isError={!!block.isError}
            toolName={block.toolName}
            show={showTools}
          />
        ) : null,
      )}
    </>
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
  // Canonical unfirehose/1.0: dispatch by role.
  const role = entry?.role ?? entry?.type;

  switch (role) {
    case 'user':
      return <UserMessage entry={entry} />;
    case 'assistant':
      return (
        <AssistantMessage entry={entry} showThinking={showThinking} showTools={showTools} />
      );
    case 'tool':
      return <ToolMessage entry={entry} showTools={showTools} />;
    case 'system':
      return <SystemMessage entry={entry} />;
    default:
      return null;
  }
}
