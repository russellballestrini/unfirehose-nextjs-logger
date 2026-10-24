/**
 * Continue sessions → unfirehose/1.0 messages.
 *
 * Format source: continuedev/continue, core/index.d.ts (`Session`,
 * `ChatHistoryItem`, `ChatMessage`, `Usage`) and core/util/history.ts +
 * core/util/paths.ts (main, fetched 2026-10-23). Continue's IDE extensions
 * save each chat as one JSON object, rewritten whole after every change:
 *
 *   ~/.continue/sessions/<sessionId>.json   { sessionId, title, workspaceDirectory, history[], chatModelTitle?, usage? }
 *   ~/.continue/sessions/sessions.json      [{ sessionId, title, dateCreated (epoch ms as a string), workspaceDirectory }]
 *
 * `history[]` items wrap a `message` whose role is user, assistant,
 * thinking, system or tool. Messages carry no timestamps of their own, so
 * a message is stamped with its item's reasoning times when it has them,
 * and otherwise with the session's creation time, never earlier than the
 * message before it. Message ids are the session id and the item's index:
 * Continue rewrites history in place when a person edits an earlier turn,
 * and a rewritten turn keeps its index.
 */
import { fileURLToPath } from 'url';
import type { UfMessage } from './session-paths';

/* eslint-disable @typescript-eslint/no-explicit-any */

/** A workspace directory as Continue stores it (a file:// URI, or a path) as a path. */
export function continueWorkspacePath(dir: unknown): string | null {
  if (typeof dir !== 'string' || !dir) return null;
  if (dir.startsWith('file://')) {
    try { return fileURLToPath(dir); } catch { return null; }
  }
  return dir.startsWith('/') ? dir : null;
}

function contentBlocks(content: unknown, type: 'text' | 'reasoning'): any[] {
  if (typeof content === 'string') return content ? [{ type, text: content }] : [];
  if (!Array.isArray(content)) return [];
  return content
    .filter((p) => p?.type === 'text' && typeof p.text === 'string' && p.text)
    .map((p) => ({ type, text: p.text }));
}

function parseArgs(args: unknown): unknown {
  if (typeof args !== 'string') return args ?? {};
  try { return JSON.parse(args); } catch { return args; }
}

export interface ContinueSessionMessages {
  sessionId: string;
  title?: string;
  cwd: string | null;
  messages: UfMessage[];
  /** For each message, the history index it came from. */
  itemIndex: number[];
}

/**
 * One saved session as messages. `createdAt` is from sessions.json when the
 * caller has it; `model` falls back to the session's chat model title, since
 * Continue names models by their configured title.
 */
export function continueSessionToMessages(session: any, opts: { createdAt?: string | null } = {}): ContinueSessionMessages | null {
  if (!session || typeof session.sessionId !== 'string' || !Array.isArray(session.history)) return null;
  const sessionId = session.sessionId;
  const cwd = continueWorkspacePath(session.workspaceDirectory);
  const fallbackModel = typeof session.chatModelTitle === 'string' ? session.chatModelTitle : null;
  let clock = opts.createdAt ? Date.parse(opts.createdAt) : NaN;
  const stamp = (ms?: unknown) => {
    const t = typeof ms === 'number' && Number.isFinite(ms) ? ms : NaN;
    if (!Number.isNaN(t) && (Number.isNaN(clock) || t > clock)) clock = t;
    return Number.isNaN(clock) ? null : new Date(clock).toISOString();
  };
  const messages: UfMessage[] = [];
  const itemIndex: number[] = [];
  const base = { $schema: 'unfirehose/1.0' as const, type: 'message' as const, sessionId, harness: 'continue', ...(cwd ? { cwd } : {}) };

  session.history.forEach((item: any, i: number) => {
    const m = item?.message;
    if (!m || typeof m.role !== 'string') return;
    const id = `continue:${sessionId}:${i}`;
    const model = item.promptLogs?.[item.promptLogs.length - 1]?.modelTitle ?? fallbackModel;
    const push = (msg: UfMessage) => { messages.push(msg); itemIndex.push(i); };
    switch (m.role) {
      case 'user': {
        const content = contentBlocks(m.content, 'text');
        if (content.length) push({ ...base, role: 'user', id, timestamp: stamp(), content });
        break;
      }
      case 'thinking':
      case 'assistant': {
        const content: any[] = [];
        // An assistant item may carry its reasoning beside it; a thinking item is all reasoning.
        if (m.role === 'assistant' && typeof item.reasoning?.text === 'string' && item.reasoning.text) {
          content.push({ type: 'reasoning', text: item.reasoning.text });
        }
        content.push(...contentBlocks(m.content, m.role === 'thinking' ? 'reasoning' : 'text'));
        for (const tc of Array.isArray(m.toolCalls) ? m.toolCalls : []) {
          if (!tc?.function?.name) continue;
          content.push({ type: 'tool-call', toolCallId: tc.id, toolName: tc.function.name, input: parseArgs(tc.function.arguments) });
        }
        const u = m.usage;
        const cached = Number(u?.promptTokensDetails?.cachedTokens) || 0;
        const write = Number(u?.promptTokensDetails?.cacheWriteTokens) || 0;
        const usage = u && (u.promptTokens || u.completionTokens) ? {
          // OpenAI-style: prompt tokens include the cached ones.
          inputTokens: Math.max(0, (Number(u.promptTokens) || 0) - cached), outputTokens: Number(u.completionTokens) || 0,
          inputTokenDetails: { cacheReadTokens: cached, cacheWriteTokens: write },
        } : undefined;
        if (content.length || usage) {
          push({ ...base, role: 'assistant', id, timestamp: stamp(item.reasoning?.startAt), model, content, ...(usage ? { usage } : {}) });
        }
        // A tool's output can also live only on the item's tool call states.
        const states = Array.isArray(item.toolCallStates) ? item.toolCallStates : [];
        const results = states
          .filter((s: any) => Array.isArray(s?.output) && s.output.length && s.toolCallId)
          .map((s: any) => ({
            type: 'tool-result', toolCallId: s.toolCallId, toolName: s.toolCall?.function?.name,
            output: s.output.map((c: any) => c?.content ?? '').join('\n'), isError: s.status === 'errored' || s.status === 'canceled',
          }));
        if (results.length) push({ ...base, role: 'user', id: `${id}:tool-results`, timestamp: stamp(item.reasoning?.endAt), content: results });
        break;
      }
      case 'tool':
        push({
          ...base, role: 'user', id, timestamp: stamp(),
          content: [{ type: 'tool-result', toolCallId: m.toolCallId, output: typeof m.content === 'string' ? m.content : JSON.stringify(m.content) }],
        });
        break;
      case 'system': {
        const content = contentBlocks(m.content, 'text');
        if (content.length) push({ ...base, role: 'system', id, timestamp: stamp(), content });
        break;
      }
    }
  });
  // Results recorded twice — as a tool message and on the call's state — keep the tool message.
  const seen = new Set<string>();
  for (let k = 0; k < messages.length; k++) {
    const msg = messages[k];
    if (msg.id?.endsWith(':tool-results')) continue;
    for (const b of msg.content) if (b.type === 'tool-result' && b.toolCallId) seen.add(b.toolCallId);
  }
  const kept = messages.map((msg, k) => ({ msg, k })).filter(({ msg }) => {
    if (!msg.id?.endsWith(':tool-results')) return true;
    msg.content = msg.content.filter((b: any) => !seen.has(b.toolCallId));
    return msg.content.length > 0;
  });
  return {
    sessionId, title: session.title, cwd,
    messages: kept.map(({ msg }) => msg), itemIndex: kept.map(({ k }) => itemIndex[k]),
  };
}
