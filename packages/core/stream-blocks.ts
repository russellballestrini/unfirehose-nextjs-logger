// Normalizing one streamed JSONL entry across harness shapes.
//
// Two wire formats reach our viewers and they disagree about everything:
//
//   Claude Code       entry.type='assistant', entry.message.content[],
//                     block.type='tool_use'    { name, id, input }
//                     block.type='tool_result' { tool_use_id, content, is_error }
//
//   unfirehose/1.0    entry.type='message', entry.role='assistant', entry.content[],
//                     block.type='tool-call'   { toolName, toolCallId, input }
//                     block.type='tool-result' { toolName, toolCallId, output, isError }
//
// The Live page handled the Claude shape only, so every uncloseai entry lost
// its tool calls and its tool results. What survived was the text block, and
// uncloseai-cli writes a placeholder there — literally `[→ bash]` — so the
// stream rendered as a column of arrows with no commands, no paths, no output.
// The detail was in the JSONL the whole time, in fields nothing read.
//
// Everything here is pure so it can be tested against real captured lines.

export interface StreamTool {
  name: string;
  id?: string;
  /** The one field worth showing inline: the command, path, pattern or query. */
  detail?: string;
  input?: unknown;
}

export interface StreamToolResult {
  toolUseId: string;
  toolName?: string;
  content: string;
  isError: boolean;
}

export type StreamRole = 'user' | 'assistant' | 'system' | 'unknown';

/* eslint-disable @typescript-eslint/no-explicit-any */

/** Role of an entry, whichever shape it arrived in. */
export function entryRole(entry: any): StreamRole {
  if (entry?.type === 'message' && typeof entry.role === 'string') {
    const r = entry.role;
    return r === 'user' || r === 'assistant' || r === 'system' ? r : 'unknown';
  }
  if (entry?.type === 'user' || entry?.type === 'assistant' || entry?.type === 'system') {
    return entry.type;
  }
  return 'unknown';
}

/** Content block array, whichever shape it arrived in. */
export function entryBlocks(entry: any): any[] {
  const c = entry?.message?.content ?? entry?.content;
  return Array.isArray(c) ? c : [];
}

/**
 * The single input field worth showing next to a tool name.
 *
 * Keyed by lowercased tool name so Claude's `Bash` and uncloseai's `bash`
 * resolve to the same rule, then by a field fallback for tools we do not know.
 */
const TOOL_DETAIL_FIELDS: Record<string, string[]> = {
  bash:        ['command'],
  read:        ['file_path', 'path'],
  write:       ['file_path', 'path'],
  edit:        ['file_path', 'path'],
  glob:        ['pattern'],
  grep:        ['pattern'],
  search:      ['query', 'pattern'],
  fetch:       ['url'],
  vision:      ['path', 'prompt'],
  screenshot:  ['path'],
  delegate:    ['task', 'role'],
  arborist:    ['question'],
  done:        ['answer'],
  apply_patch: ['patch'],
  agent:       ['description'],
  task:        ['description'],
  webfetch:    ['url'],
  websearch:   ['query'],
};

// Tried in order for a tool we have no rule for. Covers most of what harnesses
// invent without needing a new entry here every time one ships a tool.
const GENERIC_DETAIL_FIELDS = [
  'command', 'file_path', 'path', 'pattern', 'query', 'url',
  'description', 'task', 'question', 'prompt', 'answer', 'name',
];

export function toolDetail(name: string, input: unknown): string | undefined {
  if (!input || typeof input !== 'object') {
    return typeof input === 'string' && input ? input : undefined;
  }
  const obj = input as Record<string, unknown>;
  const key = (name ?? '').toLowerCase();
  const fields = TOOL_DETAIL_FIELDS[key] ?? GENERIC_DETAIL_FIELDS;
  for (const f of fields) {
    const v = obj[f];
    if (typeof v === 'string' && v.trim()) {
      // Grep reads better with its path alongside the pattern.
      if (key === 'grep' && f === 'pattern' && typeof obj.path === 'string' && obj.path) {
        return `/${v}/ in ${obj.path}`;
      }
      return v;
    }
    if (typeof v === 'number') return String(v);
  }
  return undefined;
}

/** Tool calls made by an assistant entry, from either shape. */
export function extractTools(entry: any): StreamTool[] {
  if (entryRole(entry) !== 'assistant') return [];
  const out: StreamTool[] = [];
  for (const b of entryBlocks(entry)) {
    if (b?.type === 'tool_use') {
      out.push({ name: b.name, id: b.id, detail: toolDetail(b.name, b.input), input: b.input });
    } else if (b?.type === 'tool-call') {
      out.push({
        name: b.toolName,
        id: b.toolCallId,
        detail: toolDetail(b.toolName, b.input),
        input: b.input,
      });
    }
  }
  return out;
}

/** Tool results carried by a user entry, from either shape. */
export function extractToolResults(entry: any): StreamToolResult[] {
  if (entryRole(entry) !== 'user') return [];
  const out: StreamToolResult[] = [];
  for (const b of entryBlocks(entry)) {
    if (b?.type === 'tool_result') {
      let content = '';
      if (typeof b.content === 'string') content = b.content;
      else if (Array.isArray(b.content)) {
        content = b.content
          .filter((c: any) => c?.type === 'text')
          .map((c: any) => c.text ?? '')
          .join('\n');
      }
      out.push({ toolUseId: b.tool_use_id ?? '', content, isError: b.is_error === true });
    } else if (b?.type === 'tool-result') {
      // unfirehose/1.0 puts the payload in `output`, which may be a plain
      // string, a block array, or an object we can only stringify.
      let content = '';
      const o = b.output;
      if (typeof o === 'string') content = o;
      else if (Array.isArray(o)) {
        content = o
          .map((c: any) => (typeof c === 'string' ? c : c?.text ?? ''))
          .join('\n');
      } else if (o && typeof o === 'object') {
        content = JSON.stringify(o);
      }
      out.push({
        toolUseId: b.toolCallId ?? '',
        toolName: b.toolName,
        content,
        isError: b.isError === true,
      });
    }
  }
  return out;
}

/**
 * Text a harness meant as prose, with its own tool placeholders removed.
 *
 * uncloseai-cli writes `[→ bash]` into the text block when a turn is a tool
 * call. That is a display placeholder, not content, and rendering it as the
 * message body is what made the Live stream unreadable — the real command
 * sits in the tool-call block beside it. Stripped here so callers can fall
 * back to the tool detail instead of showing an arrow.
 */
const TOOL_PLACEHOLDER = /^\s*\[\s*(?:→|->)\s*[\w.-]+\s*\]\s*$/;

export function isToolPlaceholder(text: string): boolean {
  return TOOL_PLACEHOLDER.test(text);
}

export function extractText(entry: any, opts: { stripPlaceholders?: boolean } = {}): string {
  const content = entry?.message?.content ?? entry?.content;
  if (!content) return '';
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';

  const text = content
    .filter((b: any) => b?.type === 'text')
    .map((b: any) => b.text ?? '')
    .join('\n')
    .trim();

  if (opts.stripPlaceholders !== false && isToolPlaceholder(text)) return '';
  return text;
}

/** Reasoning blocks, from either shape. Sealed reasoning has a signature only. */
export function extractReasoningInfo(entry: any): { text: string; sealed: boolean } | null {
  if (entryRole(entry) !== 'assistant') return null;
  const blocks = entryBlocks(entry).filter(
    (b: any) => b?.type === 'thinking' || b?.type === 'reasoning',
  );
  if (blocks.length === 0) return null;
  const text = blocks.map((b: any) => (b.thinking ?? b.text ?? '')).join('\n').trim();
  return { text, sealed: text.length === 0 };
}

/** One-line summary for a row that would otherwise render blank. */
export function summarizeEntry(entry: any, maxLen = 160): string {
  const text = extractText(entry);
  if (text) return text.length > maxLen ? `${text.slice(0, maxLen)}…` : text;

  const tools = extractTools(entry);
  if (tools.length) {
    return tools
      .map((t) => (t.detail ? `${t.name}: ${t.detail}` : t.name))
      .join(' · ')
      .slice(0, maxLen);
  }

  const results = extractToolResults(entry);
  if (results.length) {
    const r = results[0];
    const firstLine = (r.content ?? '').split('\n').find((l) => l.trim()) ?? '';
    const head = r.toolName ? `${r.toolName} → ` : '→ ';
    const body = firstLine.length > maxLen ? `${firstLine.slice(0, maxLen)}…` : firstLine;
    return `${head}${body}`.trim();
  }

  return '';
}
