/**
 * Aider's chat log → unfirehose/1.0 messages.
 *
 * Format source: Aider-AI/aider, aider/io.py (`InputOutput.__init__`,
 * `user_input`, `ai_output`, `_tool_message`, `append_chat_history`),
 * aider/coders/base_coder.py (`calculate_and_show_tokens_and_cost`,
 * `format_tokens`) and prompt_toolkit's `FileHistory.store_string`. Aider
 * appends to `<git root>/.aider.chat.history.md`:
 *
 *   \n# aider chat started at 2026-10-20 09:15:02\n\n    a run starts (local time)
 *   > Main model: <model> with diff edit format  \n     tool output, one "> " line each
 *   \n#### <prompt line>  \n#### <next line>  \n        what the person typed
 *   \n<reply>\n\n                                         the model's reply, written once, whole
 *   > Tokens: 2.4k sent, 1.1k cache hit, 312 received. Cost: ...  \n
 *
 * Every line Aider writes for a person's input or its own output ends in a
 * markdown hard break (two spaces). A reply is written stripped, so inside
 * one a line that merely looks like a marker (a quote, a heading, the
 * `>>>>>>> REPLACE` of an edit) does not end that way, and stays reply.
 *
 * `.aider.input.history` beside it (prompt_toolkit) stamps every input:
 * `\n# 2026-10-20 09:15:04.512345\n+<line>\n`. The chat log has no other
 * times, so a prompt found there takes its time, and everything else takes
 * the latest time known before it: never earlier than the run's start.
 *
 * Token counts are what Aider printed: `format_tokens` rounds 1000–9999 to
 * one decimal of k and 10 000 up to whole k. We read "2.4k" as 2400 and
 * mark the message's counts approximate; no precision is invented.
 */
import type { UfMessage } from './session-paths';

/* eslint-disable @typescript-eslint/no-explicit-any */

export const AIDER_HISTORY_FILE = '.aider.chat.history.md';
export const AIDER_INPUT_HISTORY_FILE = '.aider.input.history';

const HEADER = /^# aider chat started at (\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2})\s*$/;
const FENCE = /^\s*(```|~~~)/;

export type AiderItemKind = 'header' | 'user' | 'assistant' | 'output';
export interface AiderItem {
  kind: AiderItemKind;
  /** Byte offset of the item's first line in the file. */
  offset: number;
  /** The item's lines, markers stripped (`#### `, `> `, the hard break). */
  lines: string[];
  /** For a header: the start time as Aider wrote it. */
  startedAt?: string;
}

/** A local `YYYY-MM-DD HH:MM:SS[.ffffff]` (how Aider and prompt_toolkit write times) as epoch ms, or NaN. */
export function aiderLocalTime(text: string): number {
  const m = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,6}))?$/.exec(text.trim());
  if (!m) return NaN;
  const ms = m[7] ? Math.floor(Number(m[7].padEnd(6, '0')) / 1000) : 0;
  return new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6], ms).getTime();
}

const hardBreak = (line: string) => line.endsWith('  ');
const isUserLine = (line: string) => line.startsWith('#### ') || line === '####';
const isOutputLine = (line: string) => line.startsWith('> ') || /^>\s*$/.test(line);
const unmark = (line: string, marker: string) => line.slice(line.startsWith(marker + ' ') ? marker.length + 1 : marker.length).replace(/\s+$/, '');

/**
 * A run of complete lines (each with its byte offset) as items, in order.
 * Lines before the first header belong to whatever item the caller resumed
 * in; the caller always resumes at an item's first line.
 */
export function splitAiderLines(lines: Array<{ text: string; offset: number }>): AiderItem[] {
  const items: AiderItem[] = [];
  let cur: AiderItem | null = null;
  let fenced = false;
  const close = () => {
    if (cur?.kind === 'assistant') while (cur.lines.length && !cur.lines[cur.lines.length - 1].trim()) cur.lines.pop();
    if (cur) items.push(cur);
    cur = null;
    fenced = false;
  };
  for (const { text: raw, offset } of lines) {
    const text = raw.endsWith('\r') ? raw.slice(0, -1) : raw;
    const header = HEADER.exec(text);
    const inReply = cur?.kind === 'assistant';
    // Inside a reply only Aider's own hard-broken lines, outside a fence, end it.
    const marker = !inReply || (!fenced && hardBreak(text));
    if (header && !fenced) {
      close();
      items.push({ kind: 'header', offset, lines: [], startedAt: header[1] });
      continue;
    }
    if (marker && isUserLine(text)) {
      // One input is consecutive `####` lines; a blank line ends it.
      if (cur?.kind !== 'user') { close(); cur = { kind: 'user', offset, lines: [] }; }
      cur.lines.push(unmark(text, '####'));
      continue;
    }
    if (marker && isOutputLine(text)) {
      if (cur?.kind !== 'output') {
        // Output runs split only by blank lines are one run.
        const last = items[items.length - 1];
        if (!cur && last?.kind === 'output') cur = items.pop()!;
        else { close(); cur = { kind: 'output', offset, lines: [] }; }
      }
      cur.lines.push(unmark(text, '>'));
      continue;
    }
    if (!text.trim()) {
      if (cur?.kind === 'assistant') cur.lines.push('');
      else close();
      continue;
    }
    if (cur?.kind !== 'assistant') { close(); cur = { kind: 'assistant', offset, lines: [] }; }
    if (FENCE.test(text)) fenced = !fenced;
    cur.lines.push(text);
  }
  close();
  return items;
}

/** An input as the person typed it: `<blank>` is how Aider logs an empty one. */
export function aiderUserText(item: AiderItem): string {
  const text = item.lines.join('\n');
  return text === '<blank>' ? '' : text;
}

const SEARCH = /^<{5,9} SEARCH\s*$/;
const DIVIDE = /^={5,9}\s*$/;
const REPLACE = /^>{5,9} REPLACE\s*$/;

/**
 * A reply as content blocks: its prose as text, and each SEARCH/REPLACE
 * edit (Aider's `diff` and `diff-fenced` formats) as an `Edit` tool call in
 * Claude Code's input shape, in the order they were written. The file name
 * and fence lines around an edit go into the call, not the text.
 */
export function aiderReplyBlocks(text: string, callIdPrefix: string): any[] {
  const lines = text.split('\n');
  const blocks: any[] = [];
  let prose: string[] = [];
  let lastFile: string | null = null;
  let n = 0;
  const flush = () => {
    const t = prose.join('\n').trim();
    if (t) blocks.push({ type: 'text', text: t });
    prose = [];
  };
  for (let i = 0; i < lines.length; i++) {
    if (!SEARCH.test(lines[i])) { prose.push(lines[i]); continue; }
    let j = i + 1;
    while (j < lines.length && !DIVIDE.test(lines[j])) j++;
    let k = j + 1;
    while (k < lines.length && !REPLACE.test(lines[k])) k++;
    if (j >= lines.length || k >= lines.length) { prose.push(lines[i]); continue; }
    // The file name sits above the opening fence (diff) or just inside it (diff-fenced).
    let file: string | null = null;
    const above = (d: number) => prose[prose.length - d]?.trim() ?? '';
    if (FENCE.test(above(1)) && above(2) && !FENCE.test(above(2))) { file = above(2); prose.splice(-2); }
    else if (above(1) && !FENCE.test(above(1)) && FENCE.test(above(2))) { file = above(1); prose.splice(-2); }
    else if (above(1) && !FENCE.test(above(1))) { file = above(1); prose.splice(-1); }
    else if (FENCE.test(above(1))) prose.splice(-1);
    file = file ? file.replace(/^[`*]+|[`*:]+$/g, '') : lastFile;
    lastFile = file;
    flush();
    blocks.push({
      type: 'tool-call', toolCallId: `${callIdPrefix}:edit-${n++}`, toolName: 'Edit',
      input: { file_path: file ?? '', old_string: lines.slice(i + 1, j).join('\n'), new_string: lines.slice(j + 1, k).join('\n') },
    });
    i = k;
    if (i + 1 < lines.length && FENCE.test(lines[i + 1])) i++;
  }
  flush();
  return blocks;
}

/** "2.4k" → 2400, "312" → 312, as Aider's format_tokens printed them. */
function tokenCount(text: string | undefined): number {
  if (!text) return 0;
  const m = /^([\d.]+)\s*([kKmM]?)$/.exec(text.trim());
  if (!m) return 0;
  const scale = m[2].toLowerCase() === 'k' ? 1000 : m[2].toLowerCase() === 'm' ? 1_000_000 : 1;
  return Math.round(Number(m[1]) * scale);
}

export interface AiderUsage {
  inputTokens: number;
  outputTokens: number;
  inputTokenDetails: { cacheReadTokens: number; cacheWriteTokens: number };
  /** True when any count was printed rounded (a "k" figure). */
  approximate: boolean;
}

/**
 * One `Tokens: …` report. "sent" is the prompt as the provider counted it;
 * Aider prices cache hits and writes on top of it (base_coder
 * `compute_costs_from_tokens`), so they are booked beside it, not out of it.
 */
export function parseAiderTokens(line: string): AiderUsage | null {
  const m = /^Tokens:\s+(\S+) sent(?:,\s+(\S+) cache write)?(?:,\s+(\S+) cache hit)?,\s+(\S+) received\b/.exec(line);
  if (!m) return null;
  return {
    inputTokens: tokenCount(m[1]), outputTokens: tokenCount(m[4]),
    inputTokenDetails: { cacheReadTokens: tokenCount(m[3]), cacheWriteTokens: tokenCount(m[2]) },
    approximate: [m[1], m[2], m[3], m[4]].some((t) => !!t && /[kKmM]$/.test(t)),
  };
}

/** The model a startup or `/model` announcement names, if this line is one. */
export function parseAiderModel(line: string): string | null {
  const m = /^(?:Main model|Model|Models):\s+(\S+)/.exec(line);
  return m ? m[1].replace(/[,;]$/, '') : null;
}

/** `Aider v0.86.1` → `0.86.1`. */
export function parseAiderVersion(line: string): string | null {
  return /^Aider v(\S+)/.exec(line)?.[1] ?? null;
}

/** `.aider.input.history` as (time, input) pairs, oldest first. */
export function parseAiderInputHistory(text: string): Array<{ ms: number; text: string }> {
  const out: Array<{ ms: number; text: string }> = [];
  let cur: { ms: number; lines: string[] } | null = null;
  const push = () => { if (cur && !Number.isNaN(cur.ms)) out.push({ ms: cur.ms, text: cur.lines.join('\n') }); };
  for (const line of text.split('\n')) {
    if (line.startsWith('# ')) { push(); cur = { ms: aiderLocalTime(line.slice(2)), lines: [] }; }
    else if (line.startsWith('+') && cur) cur.lines.push(line.slice(1).replace(/\r$/, ''));
  }
  push();
  return out;
}

/** What a reader carries from one item to the next, and across passes. */
export interface AiderSessionState {
  sessionId: string;
  /** Epoch ms of the run's start. */
  startedMs: number;
  /** Byte offset of the run's header; message ids are relative to it. */
  headerOffset: number;
  model: string | null;
  version: string | null;
  /** The latest time a message of this run was stamped with. */
  clockMs: number;
  /** Time of the last input matched in .aider.input.history. */
  inputMs: number;
}

/**
 * One item of a run into messages. `inputs` is .aider.input.history parsed;
 * `previous` is the message the last item produced, so a usage report or an
 * "Applied edit" line lands on the reply it is about.
 */
export function aiderItemToMessages(
  item: AiderItem,
  state: AiderSessionState,
  ctx: { cwd: string; inputs: Array<{ ms: number; text: string }>; previous: UfMessage | null },
): UfMessage[] {
  const id = `aider:${state.sessionId}:${item.offset - state.headerOffset}`;
  const base = { $schema: 'unfirehose/1.0' as const, type: 'message' as const, sessionId: state.sessionId, harness: 'aider', cwd: ctx.cwd };
  const stamp = () => new Date(state.clockMs).toISOString();
  switch (item.kind) {
    case 'user': {
      const text = aiderUserText(item);
      const hit = ctx.inputs.find((e) => e.ms >= state.inputMs && e.ms >= state.startedMs - 1000 && e.text === text);
      if (hit) {
        state.inputMs = hit.ms + 1;
        if (hit.ms > state.clockMs) state.clockMs = hit.ms;
      }
      return text ? [{ ...base, role: 'user', id, timestamp: stamp(), content: [{ type: 'text', text }] }] : [];
    }
    case 'assistant': {
      const content = aiderReplyBlocks(item.lines.join('\n'), id);
      return content.length ? [{ ...base, role: 'assistant', id, timestamp: stamp(), model: state.model, content }] : [];
    }
    case 'output': {
      const out: UfMessage[] = [];
      const kept: string[] = [];
      const results: any[] = [];
      const prev = ctx.previous?.role === 'assistant' ? ctx.previous : null;
      const pendingEdits = prev ? prev.content.filter((b: any) => b.type === 'tool-call' && b.toolName === 'Edit') : [];
      for (const line of item.lines) {
        const model = parseAiderModel(line);
        if (model) state.model = model;
        const version = parseAiderVersion(line);
        if (version) state.version = version;
        const usage = parseAiderTokens(line);
        if (usage && prev && !prev.usage) {
          const { approximate, ...counts } = usage;
          prev.usage = counts;
          if (approximate) (prev as any).tokensApprox = true;
        }
        const applied = /^Applied edit to (.+)$/.exec(line);
        const call = applied ? pendingEdits.find((b: any) => b.input.file_path === applied[1].trim()) : undefined;
        if (call) {
          pendingEdits.splice(pendingEdits.indexOf(call), 1);
          results.push({ type: 'tool-result', toolCallId: call.toolCallId, toolName: 'Edit', output: line, isError: false });
          continue;
        }
        kept.push(line);
      }
      if (results.length) out.push({ ...base, role: 'user', id: `${id}:tool-results`, timestamp: stamp(), content: results });
      const text = kept.join('\n').trim();
      if (text) out.push({ ...base, role: 'system', subtype: 'aider-output', id, timestamp: stamp(), content: [{ type: 'text', text }] });
      return out;
    }
    default:
      return [];
  }
}
