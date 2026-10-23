/**
 * Training-set export: our sessions as supervised fine-tuning (SFT) data.
 *
 * Shape. unfirehose/1.0 defines how a harness LOGS (message, session, …) and
 * how a training run REPORTS (`run.*` events, `datapoint`), but no line for a
 * training example; `run.sample` is text a run generated, not an input. So
 * each exported line is our de-facto chat SFT shape, the one OpenAI's
 * fine-tuning API, Hugging Face TRL's SFTTrainer and most chat templates
 * read, with tool calls in OpenAI's function-calling form:
 *
 *   {"messages":[
 *     {"role":"user","content":"Add pagination to /orders"},
 *     {"role":"assistant","content":"Reading the route first.",
 *      "tool_calls":[{"id":"toolu_1","type":"function",
 *                     "function":{"name":"Read","arguments":"{\"file_path\":\"…\"}"}}]},
 *     {"role":"tool","tool_call_id":"toolu_1","content":"export function …"},
 *     {"role":"assistant","content":"Done. Tests pass."}]}
 *
 * One line is one session. Rendering rules, so a reader knows what it got:
 *   - user text blocks → one `user` message (blocks joined by a blank line);
 *     a user line is the start of a turn.
 *   - assistant text → `content`; consecutive assistant entries merge, as
 *     Claude Code writes one reply as several lines.
 *   - tool calls → `tool_calls[]`, `arguments` the JSON string of the input.
 *   - tool results → `tool` messages answering a call by `tool_call_id`.
 *     A call with no result in its turn, or a result with no call, is left
 *     out, so every line pairs them exactly. `toolResultMaxChars` cuts long
 *     output with a `…[truncated N chars]` marker.
 *   - reasoning → `reasoning_content` on the assistant message (the field
 *     DeepSeek and TRL chat templates read), only with `reasoning: true`.
 *   - `tools: false` drops calls and results and keeps the prose.
 *   - system lines, sidechain lines and non-text blocks (images, files) are
 *     not exported. `metadata: true` adds a `metadata` object (session,
 *     project display name, harness, models, start, turns); off by default,
 *     since some trainers refuse unknown keys.
 *
 * Every string goes through redactForExport (secrets, home-path usernames,
 * then sanitizePII), replaced by a token rather than dropped, with a count
 * per type in our stats. Ingest already sanitized PII on the way in; the
 * export applies it again because rows from before that, and tool inputs,
 * were never sanitized.
 *
 * Streaming: sessions are read in keyset pages and each session's rows in a
 * single pass, so memory holds one session at a time, never our database.
 */
import type Database from 'better-sqlite3';
import { redactForExport } from './pii';
import { isToolCall, isToolResult, isReasoning } from './block-types';

export type ToolErrorPolicy = 'keep' | 'turn' | 'session';

export interface TrainingExportFilters {
  /** `projects.name` (encoded dir) or an alias of it. */
  project?: string;
  /** Sessions with at least one assistant message on this model. */
  model?: string;
  /** `sessions.harness`; a session without one is claude-code. */
  harness?: string;
  /** Sessions started on or after (ISO date or instant). */
  from?: string;
  /** Sessions started on or before; a bare date covers that whole day. */
  to?: string;
  /** What an errored tool result costs: nothing, its turn (default), or its session. */
  toolErrors?: ToolErrorPolicy;
  /** Turns kept, after tool-error filtering; a session outside is skipped. */
  minTurns?: number;
  maxTurns?: number;
  /** Include reasoning as `reasoning_content`. Default false. */
  reasoning?: boolean;
  /** Include tool calls and results. Default true. */
  tools?: boolean;
  /** Add a `metadata` object per line. Default false. */
  metadata?: boolean;
  /** Cut tool output past this many characters; 0 or absent keeps it whole. */
  toolResultMaxChars?: number;
  /** Stop after this many examples. */
  limit?: number;
}

export interface SftToolCall {
  id: string;
  type: 'function';
  function: { name: string; arguments: string };
}

export type SftMessage =
  | { role: 'user'; content: string }
  | { role: 'assistant'; content: string; tool_calls?: SftToolCall[]; reasoning_content?: string }
  | { role: 'tool'; tool_call_id: string; content: string };

export interface SftExample {
  messages: SftMessage[];
  metadata?: {
    session: string;
    project: string;
    harness: string;
    models: string[];
    startedAt: string | null;
    turns: number;
  };
}

export interface TrainingExportStats {
  sessionsScanned: number;
  examples: number;
  turns: number;
  messages: number;
  toolCalls: number;
  toolResults: number;
  /** Turns left out because a tool result in them errored (policy `turn`). */
  turnsDroppedForToolErrors: number;
  skipped: { toolErrors: number; tooFewTurns: number; tooManyTurns: number; empty: number };
  /** Redactions by type across every exported string. */
  redactions: Record<string, number>;
  redactionsTotal: number;
}

export function emptyTrainingExportStats(): TrainingExportStats {
  return {
    sessionsScanned: 0, examples: 0, turns: 0, messages: 0, toolCalls: 0, toolResults: 0,
    turnsDroppedForToolErrors: 0,
    skipped: { toolErrors: 0, tooFewTurns: 0, tooManyTurns: 0, empty: 0 },
    redactions: {}, redactionsTotal: 0,
  };
}

/**
 * JSON Schema (draft 2020-12) for one exported line. unfirehose/1.0 has no
 * schema for a training example (see the head of this file), so ours lives
 * here, beside the code that writes it, and our tests hold every line to it.
 */
export const SFT_EXAMPLE_JSON_SCHEMA = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  $id: 'https://unfirehose.org/export/sft-example.json',
  title: 'unfirehose training-set export: one SFT example',
  type: 'object',
  required: ['messages'],
  additionalProperties: false,
  properties: {
    messages: {
      type: 'array',
      minItems: 2,
      items: {
        oneOf: [
          {
            type: 'object',
            required: ['role', 'content'],
            additionalProperties: false,
            properties: { role: { const: 'user' }, content: { type: 'string', minLength: 1 } },
          },
          {
            type: 'object',
            required: ['role', 'content'],
            additionalProperties: false,
            properties: {
              role: { const: 'assistant' },
              content: { type: 'string' },
              reasoning_content: { type: 'string' },
              tool_calls: {
                type: 'array',
                minItems: 1,
                items: {
                  type: 'object',
                  required: ['id', 'type', 'function'],
                  additionalProperties: false,
                  properties: {
                    id: { type: 'string', minLength: 1 },
                    type: { const: 'function' },
                    function: {
                      type: 'object',
                      required: ['name', 'arguments'],
                      additionalProperties: false,
                      properties: { name: { type: 'string', minLength: 1 }, arguments: { type: 'string' } },
                    },
                  },
                },
              },
            },
          },
          {
            type: 'object',
            required: ['role', 'tool_call_id', 'content'],
            additionalProperties: false,
            properties: {
              role: { const: 'tool' },
              tool_call_id: { type: 'string', minLength: 1 },
              content: { type: 'string' },
            },
          },
        ],
      },
    },
    metadata: {
      type: 'object',
      required: ['session', 'project', 'harness', 'models', 'startedAt', 'turns'],
      additionalProperties: false,
      properties: {
        session: { type: 'string' },
        project: { type: 'string' },
        harness: { type: 'string' },
        models: { type: 'array', items: { type: 'string' } },
        startedAt: { type: ['string', 'null'] },
        turns: { type: 'integer', minimum: 1 },
      },
    },
  },
} as const;

/** A project by its encoded name or one of its aliases; null when neither. */
export function resolveProjectId(db: Database.Database, name: string): number | null {
  const row = db.prepare(
    `SELECT id FROM projects WHERE name = ?
     UNION ALL SELECT project_id AS id FROM project_aliases WHERE encoded_name = ?
     LIMIT 1`,
  ).get(name, name) as { id: number } | undefined;
  return row?.id ?? null;
}

const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;

/** `to` as an exclusive bound: a bare date runs to the start of the next day. */
function toBound(to: string): { op: '<' | '<='; value: string } {
  if (!DATE_ONLY.test(to)) return { op: '<=', value: to };
  const next = new Date(`${to}T00:00:00.000Z`);
  next.setUTCDate(next.getUTCDate() + 1);
  return { op: '<', value: next.toISOString().slice(0, 10) };
}

interface SessionRow {
  id: number;
  session_uuid: string;
  harness: string;
  started_at: string | null;
  project: string;
}

interface BlockRow {
  message_id: number;
  type: string;
  model: string | null;
  block_type: string | null;
  text_content: string | null;
  tool_name: string | null;
  tool_input: string | null;
  tool_use_id: string | null;
  is_error: number | null;
}

/** One user prompt and everything up to the next, before rendering. */
interface Turn {
  messages: SftMessage[];
  errored: boolean;
}

const PAGE = 200;

/** Every string leaf of a parsed value, redacted; the shape is kept. */
function redactDeep(value: unknown, r: (s: string) => string): unknown {
  if (typeof value === 'string') return r(value);
  if (Array.isArray(value)) return value.map((v) => redactDeep(v, r));
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) out[r(k)] = redactDeep(v, r);
    return out;
  }
  return value;
}

function truncate(text: string, max: number | undefined): string {
  if (!max || max <= 0 || text.length <= max) return text;
  return `${text.slice(0, max)}…[truncated ${text.length - max} chars]`;
}

/**
 * Keep a turn's calls and results paired: a call nobody answered and a result
 * answering nothing are both dropped, then empty assistant messages, then
 * anything after the last assistant message (a trailing result).
 */
function closeTurn(turn: Turn): SftMessage[] {
  const called = new Set<string>();
  const answered = new Set<string>();
  for (const m of turn.messages) {
    if (m.role === 'assistant') for (const c of m.tool_calls ?? []) called.add(c.id);
    if (m.role === 'tool') answered.add(m.tool_call_id);
  }
  const out: SftMessage[] = [];
  for (const m of turn.messages) {
    if (m.role === 'tool') {
      if (called.has(m.tool_call_id)) out.push(m);
      continue;
    }
    if (m.role === 'assistant') {
      const calls = (m.tool_calls ?? []).filter((c) => answered.has(c.id));
      const msg: SftMessage = { role: 'assistant', content: m.content };
      if (m.reasoning_content) msg.reasoning_content = m.reasoning_content;
      if (calls.length) msg.tool_calls = calls;
      if (msg.content || msg.tool_calls) out.push(msg);
      continue;
    }
    out.push(m);
  }
  let last = out.length - 1;
  while (last >= 0 && out[last].role !== 'assistant') last--;
  return out.slice(0, last + 1);
}

/**
 * Stream our sessions as SFT examples. `stats`, when given, is filled as the
 * generator runs; read it after the last example.
 */
export function* exportTrainingSet(
  db: Database.Database,
  filters: TrainingExportFilters = {},
  stats: TrainingExportStats = emptyTrainingExportStats(),
): Generator<SftExample> {
  const policy: ToolErrorPolicy = filters.toolErrors ?? 'turn';
  const withTools = filters.tools !== false;
  const withReasoning = filters.reasoning === true;
  const limit = filters.limit && filters.limit > 0 ? filters.limit : Infinity;

  const where: string[] = ['s.id > ?'];
  const args: unknown[] = [];
  if (filters.project) {
    const id = resolveProjectId(db, filters.project);
    if (id === null) return;
    where.push('s.project_id = ?');
    args.push(id);
  }
  if (filters.harness) {
    where.push(`COALESCE(s.harness, 'claude-code') = ?`);
    args.push(filters.harness);
  }
  if (filters.from) {
    where.push('COALESCE(s.created_at, s.updated_at) >= ?');
    args.push(filters.from);
  }
  if (filters.to) {
    const b = toBound(filters.to);
    where.push(`COALESCE(s.created_at, s.updated_at) ${b.op} ?`);
    args.push(b.value);
  }
  if (filters.model) {
    where.push(`EXISTS (SELECT 1 FROM messages mm WHERE mm.session_id = s.id AND mm.type = 'assistant' AND mm.model = ?)`);
    args.push(filters.model);
  }
  const sessionsStmt = db.prepare(
    `SELECT s.id, s.session_uuid, COALESCE(s.harness, 'claude-code') AS harness,
            COALESCE(s.created_at, s.updated_at) AS started_at, p.display_name AS project
       FROM sessions s JOIN projects p ON p.id = s.project_id
      WHERE ${where.join(' AND ')}
      ORDER BY s.id LIMIT ${PAGE}`,
  );
  const rowsStmt = db.prepare(
    `SELECT m.id AS message_id, m.type, m.model, cb.block_type, cb.text_content,
            cb.tool_name, cb.tool_input, cb.tool_use_id, cb.is_error
       FROM messages m LEFT JOIN content_blocks cb ON cb.message_id = m.id
      WHERE m.session_id = ? AND m.type IN ('user', 'assistant') AND COALESCE(m.is_sidechain, 0) = 0
      ORDER BY m.id, cb.position`,
  );

  const redact = (s: string): string => {
    const { text, counts } = redactForExport(s);
    for (const [k, n] of Object.entries(counts)) {
      stats.redactions[k] = (stats.redactions[k] ?? 0) + n;
      stats.redactionsTotal += n;
    }
    return text;
  };

  let cursor = 0;
  for (;;) {
    const page = sessionsStmt.all(cursor, ...args) as SessionRow[];
    if (page.length === 0) return;
    cursor = page[page.length - 1].id;

    for (const session of page) {
      stats.sessionsScanned++;
      const kept: SftMessage[][] = [];
      const models = new Set<string>();
      let turn: Turn | null = null;
      let lastMessageId = -1;
      let userText: string[] | null = null;
      let tooMany = false;
      let sessionErrored = false;
      let droppedForErrors = 0;

      const flushUser = () => {
        if (userText && userText.length && turn) turn.messages.unshift({ role: 'user', content: userText.join('\n\n') });
        userText = null;
      };
      // A turn is judged as soon as the next one starts, so `kept` is exact
      // while we read and a session past maxTurns stops being read.
      const finishTurn = () => {
        flushUser();
        if (!turn) return;
        const t = turn;
        turn = null;
        if (t.errored) sessionErrored = true;
        if (policy === 'turn' && t.errored) { droppedForErrors++; return; }
        const msgs = closeTurn(t);
        if (msgs.length >= 2 && msgs[0].role === 'user') kept.push(msgs);
      };
      const assistant = (): Extract<SftMessage, { role: 'assistant' }> => {
        const last = turn!.messages[turn!.messages.length - 1];
        if (last?.role === 'assistant') return last;
        const m: SftMessage = { role: 'assistant', content: '' };
        turn!.messages.push(m);
        return m;
      };

      // Raw strings first: redaction runs once a session is kept, so a
      // skipped session never adds to the redaction counts.
      for (const row of rowsStmt.iterate(session.id) as Iterable<BlockRow>) {
        const isNewMessage = row.message_id !== lastMessageId;
        lastMessageId = row.message_id;
        const bt = row.block_type;
        if (!bt) continue;
        if (row.type === 'user') {
          if (bt === 'text' && row.text_content) {
            if (isNewMessage || userText === null) {
              // A user line with text starts a turn.
              finishTurn();
              if (filters.maxTurns && kept.length > filters.maxTurns) { tooMany = true; break; }
              if (policy === 'session' && sessionErrored) break;
              turn = { messages: [], errored: false };
              userText = [];
            }
            userText!.push(row.text_content);
          } else if (isToolResult(bt) && turn) {
            if (row.is_error) turn.errored = true;
            if (withTools && row.tool_use_id) {
              turn.messages.push({ role: 'tool', tool_call_id: row.tool_use_id, content: row.text_content ?? '' });
            }
          }
          continue;
        }
        // assistant
        if (!turn) continue; // a reply before any prompt has nothing to answer
        flushUser();
        if (row.model) models.add(row.model);
        if (bt === 'text' && row.text_content) {
          let a = assistant();
          if (a.tool_calls?.length) { a = { role: 'assistant', content: '' }; turn.messages.push(a); }
          a.content = a.content ? `${a.content}\n\n${row.text_content}` : row.text_content;
        } else if (isReasoning(bt) && withReasoning && row.text_content) {
          const a = assistant();
          a.reasoning_content = a.reasoning_content ? `${a.reasoning_content}\n\n${row.text_content}` : row.text_content;
        } else if (isToolCall(bt) && withTools && row.tool_use_id && row.tool_name) {
          const a = assistant();
          (a.tool_calls ??= []).push({
            id: row.tool_use_id, type: 'function',
            function: { name: row.tool_name, arguments: row.tool_input ?? '{}' },
          });
        }
      }
      finishTurn();

      if (tooMany) { stats.skipped.tooManyTurns++; continue; }
      if (policy === 'session' && sessionErrored) { stats.skipped.toolErrors++; continue; }
      if (kept.length === 0) {
        if (droppedForErrors > 0) stats.skipped.toolErrors++;
        else stats.skipped.empty++;
        continue;
      }
      if (filters.minTurns && kept.length < filters.minTurns) { stats.skipped.tooFewTurns++; continue; }
      if (filters.maxTurns && kept.length > filters.maxTurns) { stats.skipped.tooManyTurns++; continue; }

      const messages: SftMessage[] = [];
      for (const msgs of kept) {
        for (const m of msgs) {
          if (m.role === 'user') {
            messages.push({ role: 'user', content: redact(m.content) });
          } else if (m.role === 'tool') {
            messages.push({ role: 'tool', tool_call_id: redact(m.tool_call_id), content: redact(truncate(m.content, filters.toolResultMaxChars)) });
            stats.toolResults++;
          } else {
            const out: SftMessage = { role: 'assistant', content: redact(m.content) };
            if (m.reasoning_content) out.reasoning_content = redact(m.reasoning_content);
            if (m.tool_calls) {
              out.tool_calls = m.tool_calls.map((c) => {
                let args: string;
                try { args = JSON.stringify(redactDeep(JSON.parse(c.function.arguments), redact)); }
                catch { args = redact(c.function.arguments); }
                return { id: redact(c.id), type: 'function', function: { name: redact(c.function.name), arguments: args } };
              });
              stats.toolCalls += out.tool_calls.length;
            }
            messages.push(out);
          }
        }
      }

      const example: SftExample = { messages };
      if (filters.metadata) {
        example.metadata = {
          session: session.session_uuid,
          project: redact(session.project),
          harness: session.harness,
          models: [...models].sort(),
          startedAt: session.started_at,
          turns: kept.length,
        };
      }
      stats.examples++;
      stats.turnsDroppedForToolErrors += droppedForErrors;
      stats.turns += kept.length;
      stats.messages += messages.length;
      yield example;
      if (stats.examples >= limit) return;
    }
  }
}

/** The same stream as NDJSON lines, each ending in a newline. */
export function* trainingExportLines(
  db: Database.Database,
  filters: TrainingExportFilters = {},
  stats?: TrainingExportStats,
): Generator<string> {
  for (const example of exportTrainingSet(db, filters, stats)) yield `${JSON.stringify(example)}\n`;
}

export interface TrainingExportDryRun {
  filters: TrainingExportFilters;
  stats: TrainingExportStats;
  /** Our first example as it would be written, for a preview. */
  sample: SftExample | null;
  /** Bytes the download would be. */
  bytes: number;
}

/** Run the whole export and keep only counts, our first example and the size. */
export function dryRunTrainingExport(db: Database.Database, filters: TrainingExportFilters = {}): TrainingExportDryRun {
  const stats = emptyTrainingExportStats();
  let sample: SftExample | null = null;
  let bytes = 0;
  for (const example of exportTrainingSet(db, filters, stats)) {
    sample ??= example;
    bytes += Buffer.byteLength(JSON.stringify(example)) + 1;
  }
  return { filters, stats, sample, bytes };
}

/** What a filter form can offer for a project (or all of ours): harnesses and models seen. */
export function trainingExportFacets(db: Database.Database, project?: string): { harnesses: string[]; models: string[] } {
  let scope = '';
  const args: unknown[] = [];
  if (project) {
    const id = resolveProjectId(db, project);
    if (id === null) return { harnesses: [], models: [] };
    scope = 'WHERE s.project_id = ?';
    args.push(id);
  }
  const harnesses = (db.prepare(
    `SELECT DISTINCT COALESCE(s.harness, 'claude-code') AS v FROM sessions s ${scope} ORDER BY v`,
  ).all(...args) as { v: string }[]).map((r) => r.v);
  const models = (db.prepare(
    `SELECT DISTINCT m.model AS v FROM sessions s JOIN messages m ON m.session_id = s.id
      ${scope ? `${scope} AND` : 'WHERE'} m.type = 'assistant' AND m.model IS NOT NULL ORDER BY v`,
  ).all(...args) as { v: string }[]).map((r) => r.v);
  return { harnesses, models };
}

/**
 * Filters from URL query parameters, as our API route takes them. Returns an
 * error string for a value that cannot mean anything, rather than guessing.
 */
export function parseTrainingExportQuery(q: URLSearchParams): TrainingExportFilters | { error: string } {
  const f: TrainingExportFilters = {};
  const str = (k: string) => q.get(k)?.trim() || undefined;
  f.project = str('project');
  f.model = str('model');
  f.harness = str('harness');
  for (const k of ['from', 'to'] as const) {
    const v = str(k);
    if (v === undefined) continue;
    if (!DATE_ONLY.test(v) && Number.isNaN(Date.parse(v))) return { error: `${k} is not a date: "${v}"` };
    f[k] = v;
  }
  const te = str('toolErrors');
  if (te !== undefined) {
    if (te !== 'keep' && te !== 'turn' && te !== 'session') return { error: `toolErrors must be keep, turn or session` };
    f.toolErrors = te;
  }
  for (const k of ['minTurns', 'maxTurns', 'toolResultMaxChars', 'limit'] as const) {
    const v = str(k);
    if (v === undefined) continue;
    if (!/^\d+$/.test(v)) return { error: `${k} must be a whole number` };
    f[k] = Number(v);
  }
  const bool = (k: string) => {
    const v = str(k);
    return v === undefined ? undefined : v === '1' || v === 'true';
  };
  f.reasoning = bool('reasoning');
  f.tools = bool('tools');
  f.metadata = bool('metadata');
  for (const k of Object.keys(f) as (keyof TrainingExportFilters)[]) if (f[k] === undefined) delete f[k];
  return f;
}
