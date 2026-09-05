/**
 * One line that says what a message did.
 *
 * The all-logs page is the last resort when something is not where it should
 * be, and for a long time most of its rows said nothing: a tool result showed
 * as an empty USR row, a tool call as "[Bash]" with no command, a sealed
 * reasoning block as an empty AST row, and a system event as "SYS" and
 * nothing else. Of the last two thousand messages' blocks, 607 were tool
 * results the preview query did not even select.
 *
 * This is pure — blocks in, one summary out — so the rule for what a row
 * says lives in one place and can be tested without a database.
 */

import { isToolCall, isToolResult, isReasoning } from '@unturf/unfirehose/block-types';

export interface PreviewBlock {
  block_type: string;
  text_content: string | null;
  tool_name: string | null;
  tool_input: string | null;
  tool_use_id: string | null;
  is_error: number | null;
}

export interface Summary {
  /** What kind of row this is, for the badge and the colour. */
  kind: 'text' | 'tool-call' | 'tool-result' | 'reasoning' | 'system' | 'empty';
  /** The tool, for a call or a result. Normalised to the harness's casing. */
  tool: string | null;
  /** The one thing that identifies this call: the command, the path, the pattern. */
  toolArg: string | null;
  /** The line shown in the row. */
  preview: string;
  isError: boolean;
  /** The message carried reasoning, readable or sealed. */
  hasReasoning: boolean;
  /** Reasoning arrived with no readable text (opus-4-7 ships a signature only). */
  sealedReasoning: boolean;
}

const PREVIEW_CHARS = 500;

/** The first line that says something, trimmed. */
export function firstLine(text: string, max = 200): string {
  const line = text.split('\n').map((l) => l.trim()).find((l) => l.length > 0) ?? '';
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
}

/** A path, shortened to the part a reader recognises. */
function shortPath(p: string): string {
  const parts = p.replace(/\/+$/, '').split('/');
  return parts.length > 3 ? `…/${parts.slice(-3).join('/')}` : p;
}

/**
 * The argument that identifies a tool call. Harnesses name things
 * differently — Claude Code says `file_path`, uncloseai says `path` — so each
 * tool gets a list of the keys that have meant "the thing", in order.
 */
const TOOL_KEYS: Record<string, string[]> = {
  bash: ['command'],
  read: ['file_path', 'path'],
  write: ['file_path', 'path'],
  edit: ['file_path', 'path'],
  multiedit: ['file_path', 'path'],
  notebookedit: ['notebook_path', 'path'],
  grep: ['pattern'],
  glob: ['pattern'],
  webfetch: ['url'],
  websearch: ['query'],
  agent: ['description'],
  task: ['description'],
  taskcreate: ['subject'],
  taskupdate: ['taskId'],
  skill: ['skill'],
  done: ['answer'],
};
const PATH_TOOLS = new Set(['read', 'write', 'edit', 'multiedit', 'notebookedit']);

export function toolArgOf(tool: string | null, input: string | null): string | null {
  if (!input) return null;
  let obj: Record<string, unknown>;
  try { obj = JSON.parse(input); } catch { return firstLine(input, 120) || null; }
  if (!obj || typeof obj !== 'object') return null;
  const key = (tool ?? '').toLowerCase();
  const keys = TOOL_KEYS[key] ?? [];
  for (const k of keys) {
    const v = obj[k];
    if (typeof v === 'string' && v.trim()) {
      const s = firstLine(v, 160);
      return PATH_TOOLS.has(key) ? shortPath(s) : s;
    }
    if (typeof v === 'number') return String(v);
  }
  // A tool we have no rule for: its first string value is the best guess.
  for (const v of Object.values(obj)) {
    if (typeof v === 'string' && v.trim()) return firstLine(v, 120);
  }
  return null;
}

/**
 * Summarise one message's blocks.
 *
 * `toolNameFor` resolves a result's tool from its `tool_use_id`: the call
 * that produced a result is a different message, so the caller — which has
 * the whole batch — supplies the lookup.
 */
export function summarise(
  blocks: PreviewBlock[],
  opts: { type: string; subtype?: string | null; durationMs?: number | null; toolNameFor?: (id: string) => string | null } = { type: 'assistant' },
): Summary {
  const out: Summary = {
    kind: 'empty', tool: null, toolArg: null, preview: '', isError: false,
    hasReasoning: false, sealedReasoning: false,
  };
  const parts: string[] = [];

  for (const b of blocks) {
    if (b.block_type === 'text' && b.text_content?.trim()) {
      parts.push(b.text_content.trim());
      if (out.kind === 'empty') out.kind = 'text';
    } else if (isReasoning(b.block_type)) {
      out.hasReasoning = true;
      if (b.text_content?.trim()) {
        parts.push(`[reasoning] ${firstLine(b.text_content, 200)}`);
        if (out.kind === 'empty') out.kind = 'reasoning';
      } else {
        out.sealedReasoning = true;
      }
    } else if (isToolCall(b.block_type)) {
      out.kind = out.kind === 'text' ? 'text' : 'tool-call';
      out.tool = out.tool ?? b.tool_name;
      out.toolArg = out.toolArg ?? toolArgOf(b.tool_name, b.tool_input);
      // Named in the preview too, so a search for the command still hits.
      parts.push([b.tool_name, toolArgOf(b.tool_name, b.tool_input)].filter(Boolean).join(' '));
    } else if (isToolResult(b.block_type)) {
      out.kind = out.kind === 'text' ? 'text' : 'tool-result';
      out.isError = out.isError || !!b.is_error;
      out.tool = out.tool ?? b.tool_name ?? (b.tool_use_id ? opts.toolNameFor?.(b.tool_use_id) ?? null : null);
      const line = b.text_content ? firstLine(b.text_content, 240) : '';
      parts.push(line || (b.is_error ? '(error, no output)' : '(no output)'));
    }
  }

  if (opts.type === 'system') {
    out.kind = 'system';
    const label = (opts.subtype ?? 'system').replace(/_/g, ' ');
    const dur = opts.durationMs != null && opts.subtype === 'turn_duration' ? ` ${formatMs(opts.durationMs)}` : '';
    out.preview = `${label}${dur}${parts.length ? ` — ${parts.join(' ')}` : ''}`;
    return out;
  }

  if (out.kind === 'empty' && out.sealedReasoning) {
    // The model thought and told us only that it had. Better than a blank.
    out.kind = 'reasoning';
    out.preview = '(reasoning, sealed)';
    return out;
  }

  out.preview = parts.join(' · ').slice(0, PREVIEW_CHARS);
  return out;
}

function formatMs(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  const m = Math.floor(ms / 60_000);
  return `${m}m ${Math.round((ms % 60_000) / 1000)}s`;
}
