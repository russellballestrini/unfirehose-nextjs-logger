/**
 * Gemini CLI chat recordings → unfirehose/1.0 messages.
 *
 * Format source: google-gemini/gemini-cli, packages/core/src/services/
 * chatRecordingTypes.ts and chatRecordingService.ts (main at a713410,
 * fetched 2026-10-23). Gemini CLI records every chat, unasked, under
 *
 *   ~/.gemini/tmp/<project>/chats/session-<YYYY-MM-DDTHH-MM>-<id8>.jsonl
 *   ~/.gemini/tmp/<project>/chats/<parentSessionId>/<sessionId>.jsonl  (subagents)
 *
 * `<project>` is a slug from ~/.gemini/projects.json whose owner is written
 * in `<project>/.project_root`; before that registry it was
 * sha256(projectRoot), and those dirs are migrated as Gemini CLI meets them.
 *
 * A .jsonl recording is append-only but not one message per line: line 1 is
 * the session's metadata, a message is appended again (same id) each time
 * it changes (tokens arrive, tool calls are recorded), `$patch` lines set
 * tool results or content, `$rewindTo` drops everything from an id on, and
 * `$set` updates metadata (or, in older writers, replaces the whole history).
 * So a recording is folded the way Gemini CLI's own loader folds it, and
 * only then turned into messages. The older .json recordings are one
 * ConversationRecord object, rewritten whole.
 */
import type { UfMessage } from './session-paths';

/* eslint-disable @typescript-eslint/no-explicit-any */

export interface GeminiConversation {
  sessionId: string;
  projectHash?: string;
  startTime?: string;
  lastUpdated?: string;
  summary?: string;
  kind?: 'main' | 'subagent';
  directories?: string[];
  /** In record order, after every patch and rewind. */
  messages: any[];
}

const isObj = (v: unknown): v is Record<string, any> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** Fold a recording's text (JSONL, or a legacy whole-file JSON) into a conversation. */
export function foldGeminiRecording(text: string): GeminiConversation | null {
  const trimmed = text.trimStart();
  // Legacy: one ConversationRecord. A JSONL's first line is an object too,
  // but it has no `messages` array and is followed by more lines.
  if (trimmed.startsWith('{')) {
    try {
      const whole = JSON.parse(trimmed);
      if (isObj(whole) && Array.isArray(whole.messages) && typeof whole.sessionId === 'string') {
        return { ...whole, messages: whole.messages.filter(isMessageRecord) } as GeminiConversation;
      }
    } catch { /* not one object: JSONL */ }
  }

  let meta: Record<string, any> = {};
  const messages = new Map<string, any>();
  const patch = (p: any) => {
    const m = messages.get(p?.id);
    if (!m) return;
    if (p.content !== undefined) m.content = p.content;
    if (Array.isArray(p.toolCalls) && Array.isArray(m.toolCalls)) {
      for (const tp of p.toolCalls) {
        const tc = m.toolCalls.find((t: any) => t.id === tp.id);
        if (tc && 'result' in tp) tc.result = tp.result;
      }
    }
  };
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    let r: any;
    try { r = JSON.parse(line); } catch { continue; }
    if (!isObj(r)) continue;
    if (typeof r.$rewindTo === 'string') {
      let found = false;
      for (const id of [...messages.keys()]) {
        if (id === r.$rewindTo) found = true;
        if (found) messages.delete(id);
      }
      if (!found) messages.clear();
    } else if (isObj(r.$patch)) {
      const p = r.$patch;
      if (typeof p.id === 'string') patch(p);
      for (const u of Array.isArray(p.updates) ? p.updates : []) patch(u);
      for (const id of Array.isArray(p.removeIds) ? p.removeIds : []) messages.delete(id);
      if (Array.isArray(p.orderIds)) {
        const ordered = p.orderIds.filter((id: unknown) => typeof id === 'string' && messages.has(id));
        const set = new Set(ordered);
        const entries = [...messages].filter(([id]) => !set.has(id)).concat(ordered.map((id: string) => [id, messages.get(id)]));
        messages.clear();
        for (const [id, m] of entries) messages.set(id, m);
      }
    } else if (isMessageRecord(r)) {
      // Re-appended to update: the newest copy wins, the first position stays.
      messages.set(r.id, structuredClone(r));
    } else if (isObj(r.$set)) {
      if (Array.isArray(r.$set.messages)) {
        messages.clear();
        for (const m of r.$set.messages) if (isMessageRecord(m)) messages.set(m.id, structuredClone(m));
      }
      const { messages: _drop, ...rest } = r.$set;
      meta = { ...meta, ...rest };
    } else if (typeof r.sessionId === 'string') {
      const { messages: inline, ...rest } = r;
      meta = { ...meta, ...rest };
      for (const m of Array.isArray(inline) ? inline : []) if (isMessageRecord(m)) messages.set(m.id, structuredClone(m));
    }
  }
  if (typeof meta.sessionId !== 'string') return null;
  return { ...(meta as GeminiConversation), messages: [...messages.values()] };
}

function isMessageRecord(r: any): boolean {
  return isObj(r) && typeof r.id === 'string' && typeof r.type === 'string' && 'content' in r;
}

/** A PartListUnion (string | Part | (string|Part)[]) as a list of parts. */
function parts(content: unknown): any[] {
  if (content == null) return [];
  if (typeof content === 'string') return [{ text: content }];
  if (Array.isArray(content)) return content.map((p) => (typeof p === 'string' ? { text: p } : p)).filter(isObj);
  return isObj(content) ? [content] : [];
}

/** Text and thought parts of a message, in order. */
function textBlocks(content: unknown): any[] {
  const out: any[] = [];
  for (const p of parts(content)) {
    if (typeof p.text !== 'string' || !p.text) continue;
    out.push({ type: p.thought ? 'reasoning' : 'text', text: p.text });
  }
  return out;
}

/** What a tool call returned, as text: its functionResponse output, error, or text parts. */
function toolOutput(result: unknown): string {
  const ps = parts(result);
  const texts: string[] = [];
  for (const p of ps) {
    const resp = p.functionResponse?.response;
    if (resp !== undefined) {
      if (typeof resp?.output === 'string') texts.push(resp.output);
      else if (typeof resp?.error === 'string') texts.push(resp.error);
      else texts.push(JSON.stringify(resp));
    } else if (typeof p.text === 'string') texts.push(p.text);
  }
  return texts.join('\n');
}

/** Gemini's prompt count includes cached and tool-use prompt tokens; thoughts bill as output. */
export function geminiUsage(tokens: any): UfMessage['usage'] | undefined {
  if (!isObj(tokens)) return undefined;
  const cached = Number(tokens.cached) || 0;
  const input = (Number(tokens.input) || 0) + (Number(tokens.tool) || 0);
  const output = (Number(tokens.output) || 0) + (Number(tokens.thoughts) || 0);
  if (!input && !output && !cached) return undefined;
  return {
    inputTokens: Math.max(0, input - cached),
    outputTokens: output,
    inputTokenDetails: { cacheReadTokens: cached, cacheWriteTokens: 0 },
    ...(tokens.thoughts ? { outputTokenDetails: { reasoningTokens: Number(tokens.thoughts) || 0 } } : {}),
  };
}

const ERRORISH = new Set(['error', 'cancelled', 'canceled']);

/**
 * One recorded message as unfirehose/1.0 messages: a gemini turn is the
 * assistant's message (thoughts, text, tool calls, usage) and, when its
 * tools ran, a user message carrying their results — the shape Claude Code
 * rows have. info/warning/error lines are system messages.
 */
export function geminiRecordToMessages(rec: any, ctx: { sessionId: string; cwd?: string | null; sidechain?: boolean }): UfMessage[] {
  const base = {
    $schema: 'unfirehose/1.0' as const, type: 'message' as const, sessionId: ctx.sessionId,
    timestamp: rec.timestamp ?? null, harness: 'gemini-cli',
    ...(ctx.cwd ? { cwd: ctx.cwd } : {}), ...(ctx.sidechain ? { sidechain: true } : {}),
  };
  switch (rec.type) {
    case 'user': {
      const content = textBlocks(rec.content);
      return content.length ? [{ ...base, role: 'user', id: rec.id, content }] : [];
    }
    case 'gemini': {
      const content: any[] = [];
      for (const t of Array.isArray(rec.thoughts) ? rec.thoughts : []) {
        const text = [t?.subject, t?.description].filter((x) => typeof x === 'string' && x).join(': ');
        if (text) content.push({ type: 'reasoning', text });
      }
      content.push(...textBlocks(rec.content));
      const calls = Array.isArray(rec.toolCalls) ? rec.toolCalls : [];
      for (const tc of calls) {
        content.push({ type: 'tool-call', toolCallId: tc.id, toolName: tc.name, input: tc.args ?? {} });
      }
      const usage = geminiUsage(rec.tokens);
      const out: UfMessage[] = [];
      if (content.length || usage) {
        out.push({ ...base, role: 'assistant', id: rec.id, model: rec.model ?? null, content, ...(usage ? { usage } : {}) });
      }
      const results = calls.filter((tc: any) => tc.result != null).map((tc: any) => ({
        type: 'tool-result', toolCallId: tc.id, toolName: tc.name, output: toolOutput(tc.result), isError: ERRORISH.has(tc.status),
      }));
      if (results.length) {
        const last = calls[calls.length - 1];
        out.push({ ...base, role: 'user', id: `${rec.id}:tool-results`, timestamp: last?.timestamp ?? rec.timestamp ?? null, content: results });
      }
      return out;
    }
    case 'info':
    case 'warning':
    case 'error': {
      const content = textBlocks(rec.content);
      return content.length ? [{ ...base, role: 'system', id: rec.id, subtype: rec.type, content }] : [];
    }
    default:
      return [];
  }
}
