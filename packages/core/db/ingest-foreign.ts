// Harnesses whose sessions are not `{root}/{slug}/{uuid}.jsonl` of message
// lines: Codex's dated rollout tree, Gemini CLI's chat recordings, Continue's
// rewritten-whole session files, Aider's markdown log in each repo root. Each format has a reader here that turns a
// file into unfirehose/1.0 messages, and every reader lands them through the
// same rows Claude Code's do (getOrCreateProject, getOrCreateSession,
// insertMessage, insertContentBlocks, updateUsageMinutes).
//
// Reads only. Never writes, renames or locks a harness's files.
//
// Two disciplines, as the formats demand:
//   append  (Codex, Aider)  resume from the stored byte offset; a partial
//                     last line waits for next pass; the reader's folded state
//                     (session, model, cumulative token counters) is stored
//                     beside the offset, so no line is read twice. Aider's
//                     newest turn waits too while the file moved within
//                     SETTLE_MS, so its usage line lands with its reply.
//   whole   (Gemini, Continue)  a file is skipped while its size and mtime
//                     match what we stored; a changed file is folded whole and
//                     its messages inserted by id (INSERT OR IGNORE dedupes).
//                     A message still being written (the newest one, in a file
//                     touched within SETTLE_MS) waits, and the file's
//                     signature is not stored until it has, so a turn is not
//                     frozen half-recorded.
import { readFileSync, openSync, readSync, closeSync, existsSync } from 'fs';
import { createHash } from 'crypto';
import path from 'path';
import type { getDb } from './schema';
import { decodeProjectName } from '../claude-paths';
import { getOrCreateProject } from './ingest-projects';
import {
  extractProvidenceFromSession,
  getOrCreateSession,
  insertContentBlocks,
  insertMessage,
  updateUsageMinutes,
} from './ingest-rows';
import { statSyncSafe, stmt } from './ingest-cache';
import type { IngestResult } from './ingest-harness';
import type { UfMessage } from '../session-paths';
import { normalizeCodexEntry, type CodexState } from '../codex-adapter';
import { foldGeminiRecording, geminiRecordToMessages } from '../gemini-adapter';
import { continueSessionToMessages } from '../continue-adapter';
import {
  AIDER_INPUT_HISTORY_FILE, aiderItemToMessages, aiderLocalTime, aiderUserText, parseAiderInputHistory, splitAiderLines,
  type AiderItem, type AiderSessionState,
} from '../aider-adapter';
import { knownProjectRoots } from './project-roots';
import { foreignSessionFiles } from '../harness-files';
import { FOREIGN_FORMATS, ingestedHarnesses, type HarnessFormat } from '../harness-registry';
import { HARNESS_ROOTS } from '../harness-roots';

/* eslint-disable @typescript-eslint/no-explicit-any */

type Db = ReturnType<typeof getDb>;
type Counts = Omit<IngestResult, 'alertsTriggered'>;

/** How long a whole-file session must sit untouched before its newest message counts as written. */
export const SETTLE_MS = 30_000;
/** Bytes of one append-only file read per pass: a long backlog catches up over passes, not in one. */
const APPEND_BUDGET = 32 * 1024 * 1024;

const emptyCounts = (): Counts => ({
  projectsAdded: 0, sessionsAdded: 0, messagesAdded: 0, blocksAdded: 0, filesScanned: 0, providenceAdded: 0,
});

/** A cwd as a project slug, the way Claude Code (and the codex bridge before us) encode one. */
export function cwdSlug(cwd: string): string {
  return cwd.replace(/[^a-zA-Z0-9_-]/g, '-');
}

export interface ForeignSessionMeta {
  sessionUuid: string;
  cwd: string | null;
  /** Project slug to use when the cwd is unknown. */
  slugHint?: string;
  createdAt?: string | null;
  gitBranch?: string | null;
  firstPrompt?: string | null;
  sidechain?: boolean;
  delegatedFrom?: string | null;
  cliVersion?: string | null;
}

/**
 * One session's messages into our rows. Returns the session row id. Every
 * reader ends here, so a Gemini turn and a Claude Code turn are the same
 * kind of row.
 */
function landSession(db: Db, harness: string, meta: ForeignSessionMeta, messages: UfMessage[], counts: Counts): number {
  const slug = meta.cwd ? cwdSlug(meta.cwd) : (meta.slugHint || 'unknown');
  const projectName = `${harness}:${slug}`;
  const projectId = getOrCreateProject(db, projectName, `[${harness}] ${decodeProjectName(slug)}`, meta.cwd ?? undefined);
  const hadSessions = stmt(db, 'SELECT 1 AS x FROM sessions WHERE project_id = ? LIMIT 1').get(projectId);
  const existed = stmt(db, 'SELECT id FROM sessions WHERE session_uuid = ?').get(meta.sessionUuid);
  const sessionId = getOrCreateSession(db, meta.sessionUuid, projectId, {
    harness,
    cliVersion: meta.cliVersion ?? harness,
    ...(meta.createdAt ? { createdAt: meta.createdAt } : {}),
    ...(meta.gitBranch ? { gitBranch: meta.gitBranch } : {}),
    ...(meta.firstPrompt ? { firstPrompt: meta.firstPrompt } : {}),
    ...(meta.sidechain ? { isSidechain: true } : {}),
    ...(meta.delegatedFrom ? { delegatedFrom: meta.delegatedFrom } : {}),
  });
  if (!existed) {
    counts.sessionsAdded++;
    if (!hadSessions) counts.projectsAdded++;
  }
  db.transaction(() => {
    for (const message of messages) {
      const messageId = insertMessage(db, sessionId, message);
      if (messageId === null) continue;
      counts.messagesAdded++;
      counts.blocksAdded += insertContentBlocks(db, messageId, message.content);
      const usage = message.usage;
      if (usage && message.timestamp) {
        updateUsageMinutes(db, projectId, message.timestamp, {
          inputTokens: usage.inputTokens ?? 0,
          outputTokens: usage.outputTokens ?? 0,
          cacheReadTokens: usage.inputTokenDetails?.cacheReadTokens ?? 0,
          cacheCreationTokens: usage.inputTokenDetails?.cacheWriteTokens ?? 0,
        });
      }
    }
    db.prepare('UPDATE sessions SET updated_at = ? WHERE id = ?').run(new Date().toISOString(), sessionId);
  })();
  counts.providenceAdded += extractProvidenceFromSession(db, sessionId, decodeProjectName(slug), harness);
  return sessionId;
}

interface OffsetRow { byte_offset: number; mtime_ms: number | null; reader_state: string | null }
function offsetRow(db: Db, file: string): OffsetRow | undefined {
  return db.prepare('SELECT byte_offset, mtime_ms, reader_state FROM ingest_offsets WHERE file_path = ?').get(file) as OffsetRow | undefined;
}
function storeOffset(db: Db, file: string, offset: number, mtimeMs: number | null, state: unknown) {
  db.prepare(`INSERT INTO ingest_offsets (file_path, byte_offset, mtime_ms, reader_state, last_ingested)
            VALUES (?, ?, ?, ?, datetime('now'))
            ON CONFLICT(file_path) DO UPDATE SET byte_offset = excluded.byte_offset, mtime_ms = excluded.mtime_ms,
              reader_state = excluded.reader_state, last_ingested = excluded.last_ingested`)
    .run(file, offset, mtimeMs, state === undefined ? null : JSON.stringify(state));
}

/** Complete lines of `file` from `start`, at most ~APPEND_BUDGET bytes, and where the next read starts. */
function readCompleteLines(file: string, start: number, size: number): { lines: Array<{ text: string; offset: number }>; end: number } {
  const fd = openSync(file, 'r');
  try {
    let pending = Buffer.alloc(0);
    let position = start;
    let pendingStart = start;
    const lines: Array<{ text: string; offset: number }> = [];
    // Keep reading past the budget only to finish a line already begun.
    while (position < size && (position - start < APPEND_BUDGET || pending.length > 0)) {
      const buf = Buffer.alloc(Math.min(1024 * 1024, size - position));
      const n = readSync(fd, buf, 0, buf.length, position);
      if (!n) break;
      position += n;
      pending = pending.length ? Buffer.concat([pending, buf.subarray(0, n)]) : buf.subarray(0, n);
      let nl: number;
      while ((nl = pending.indexOf(10)) >= 0) {
        lines.push({ text: pending.subarray(0, nl).toString('utf8'), offset: pendingStart });
        pendingStart += nl + 1;
        pending = pending.subarray(nl + 1);
      }
    }
    return { lines, end: pendingStart };
  } finally { closeSync(fd); }
}

interface CodexReaderState extends CodexState { gitBranch?: string; createdAt?: string; cliVersion?: string }

/**
 * Codex rollouts, read in place. Message ids are the ones scripts/codex-bridge
 * gave the same lines (`codex:<sha256(path)>:<byte offset>`), and the project
 * and session are the ones its output landed as, so a box that ran the bridge
 * keeps its history and gains no duplicates when it switches to this reader.
 */
function ingestCodexFile(db: Db, file: string, counts: Counts): void {
  const st = statSyncSafe(file);
  if (!st) return;
  const row = offsetRow(db, file);
  const start = row?.byte_offset ?? 0;
  if (st.size <= start) return;
  counts.filesScanned++;
  const state: CodexReaderState = start > 0 && row?.reader_state ? JSON.parse(row.reader_state) : {};
  const key = createHash('sha256').update(file).digest('hex');
  const { lines, end } = readCompleteLines(file, start, st.size);
  const messages: UfMessage[] = [];
  for (const { text, offset } of lines) {
    if (!text.trim()) continue;
    let raw: any;
    try { raw = JSON.parse(text); } catch { continue; }
    if (raw?.type === 'session_meta') {
      state.gitBranch = raw.payload?.git?.branch ?? state.gitBranch;
      state.createdAt = raw.payload?.timestamp ?? raw.timestamp ?? state.createdAt;
      state.cliVersion = raw.payload?.cli_version ?? state.cliVersion;
    }
    const message = normalizeCodexEntry(raw, state, `codex:${key}:${offset}`);
    if (message) messages.push(message);
  }
  // A rollout opens with session_meta; without a valid session id there is
  // nothing to hang its lines on yet, so nothing is consumed.
  if (!state.sessionId || !/^[a-zA-Z0-9-]+$/.test(state.sessionId)) return;
  landSession(db, 'codex', {
    sessionUuid: state.sessionId, cwd: state.cwd ?? null, createdAt: state.createdAt,
    gitBranch: state.gitBranch, cliVersion: state.cliVersion ? `codex ${state.cliVersion}` : 'codex',
  }, messages.map((m) => ({ ...m, sessionId: state.sessionId })), counts);
  storeOffset(db, file, end, st.mtimeMs, state);
}

/** True when a whole-file session is unchanged since we last finished it. */
function unchanged(db: Db, file: string, size: number, mtimeMs: number): boolean {
  const row = offsetRow(db, file);
  return !!row && row.byte_offset === size && row.mtime_ms === mtimeMs;
}

/**
 * Where a Gemini CLI project dir points: its `.project_root` marker, then
 * ~/.gemini/projects.json (path → slug), then — for a legacy dir named
 * sha256(projectRoot) — any project path we already know that hashes to it.
 */
function geminiCwdResolver(db: Db, root: string): (projectDir: string) => string | null {
  const memo = new Map<string, string | null>();
  let registry: Record<string, string> | null = null;
  let known: Map<string, string> | null = null;
  return (projectDir) => {
    if (memo.has(projectDir)) return memo.get(projectDir)!;
    const id = path.basename(projectDir);
    let cwd: string | null = null;
    try {
      const marker = readFileSync(path.join(projectDir, '.project_root'), 'utf8').trim();
      if (path.isAbsolute(marker)) cwd = marker;
    } catch { /* no marker */ }
    if (!cwd) {
      if (registry === null) {
        try {
          const data = JSON.parse(readFileSync(path.join(path.dirname(root), 'projects.json'), 'utf8'));
          registry = data && typeof data.projects === 'object' ? data.projects : {};
        } catch { registry = {}; }
      }
      cwd = Object.entries(registry!).find(([, slug]) => slug === id)?.[0] ?? null;
    }
    if (!cwd && /^[0-9a-f]{64}$/.test(id)) {
      if (!known) {
        known = new Map();
        const rows = db.prepare('SELECT DISTINCT p FROM (SELECT path AS p FROM projects UNION SELECT last_cwd_seen FROM projects) WHERE p IS NOT NULL').all() as Array<{ p: string }>;
        for (const { p } of rows) known.set(createHash('sha256').update(p).digest('hex'), p);
      }
      cwd = known.get(id) ?? null;
    }
    memo.set(projectDir, cwd);
    return cwd;
  };
}

function ingestGeminiFile(db: Db, file: string, root: string, cwdOf: (dir: string) => string | null, counts: Counts, now: number): void {
  const st = statSyncSafe(file);
  if (!st || unchanged(db, file, st.size, st.mtimeMs)) return;
  counts.filesScanned++;
  let text: string;
  try { text = readFileSync(file, 'utf8'); } catch { return; }
  const conv = foldGeminiRecording(text);
  if (!conv) { storeOffset(db, file, st.size, st.mtimeMs, undefined); return; }
  // <root>/<project>/chats/<file> or <root>/<project>/chats/<parent>/<file>
  const rel = path.relative(root, file).split(path.sep);
  const projectDir = path.join(root, rel[0]);
  const parentSession = rel.length === 4 ? rel[2] : null;
  const cwd = cwdOf(projectDir);
  const sidechain = conv.kind === 'subagent' || !!parentSession;
  const settledAll = now - st.mtimeMs >= SETTLE_MS;
  const messages: UfMessage[] = [];
  conv.messages.forEach((rec, i) => {
    if (i === conv.messages.length - 1 && !settledAll) return;
    messages.push(...geminiRecordToMessages(rec, { sessionId: conv.sessionId, cwd, sidechain }));
  });
  const firstUser = messages.find((m) => m.role === 'user' && m.content[0]?.type === 'text');
  landSession(db, 'gemini-cli', {
    sessionUuid: conv.sessionId, cwd, slugHint: `gemini-${rel[0]}`, createdAt: conv.startTime ?? null,
    firstPrompt: conv.summary || firstUser?.content[0]?.text || null, sidechain, delegatedFrom: parentSession,
    cliVersion: 'gemini-cli',
  }, messages, counts);
  if (settledAll) storeOffset(db, file, st.size, st.mtimeMs, undefined);
}

function continueCreatedAt(root: string): Map<string, string> {
  const out = new Map<string, string>();
  try {
    const list = JSON.parse(readFileSync(path.join(root, 'sessions.json'), 'utf8'));
    for (const s of Array.isArray(list) ? list : []) {
      const ms = Number(s?.dateCreated);
      if (typeof s?.sessionId === 'string' && Number.isFinite(ms) && ms > 0) out.set(s.sessionId, new Date(ms).toISOString());
      else if (typeof s?.sessionId === 'string' && typeof s?.dateCreated === 'string' && !Number.isNaN(Date.parse(s.dateCreated))) {
        out.set(s.sessionId, new Date(Date.parse(s.dateCreated)).toISOString());
      }
    }
  } catch { /* no index: sessions stamp from their file */ }
  return out;
}

function ingestContinueFile(db: Db, file: string, created: () => Map<string, string>, counts: Counts, now: number): void {
  const st = statSyncSafe(file);
  if (!st || unchanged(db, file, st.size, st.mtimeMs)) return;
  counts.filesScanned++;
  let session: any;
  try { session = JSON.parse(readFileSync(file, 'utf8')); } catch {
    // Mid-rewrite, or not ours. A file that stays broken is retried only when it changes.
    if (now - st.mtimeMs >= SETTLE_MS) storeOffset(db, file, st.size, st.mtimeMs, undefined);
    return;
  }
  const createdAt = created().get(session?.sessionId) ?? new Date(st.birthtimeMs || st.mtimeMs).toISOString();
  const parsed = continueSessionToMessages(session, { createdAt });
  if (!parsed) { storeOffset(db, file, st.size, st.mtimeMs, undefined); return; }
  const settledAll = now - st.mtimeMs >= SETTLE_MS;
  const lastItem = Math.max(-1, ...parsed.itemIndex);
  const messages = parsed.messages.filter((_, k) => settledAll || parsed.itemIndex[k] !== lastItem);
  const firstUser = messages.find((m) => m.role === 'user' && m.content[0]?.type === 'text');
  landSession(db, 'continue', {
    sessionUuid: parsed.sessionId, cwd: parsed.cwd, createdAt,
    firstPrompt: firstUser?.content[0]?.text ?? parsed.title ?? null, cliVersion: 'continue',
  }, messages, counts);
  if (settledAll) storeOffset(db, file, st.size, st.mtimeMs, undefined);
}

/** A stable session id for one Aider run: the file and where and when its header was written. */
function aiderSessionId(file: string, headerOffset: number, startedAt: string): string {
  const h = createHash('sha256').update(`${file}\0${headerOffset}\0${startedAt}`).digest('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20, 32)}`;
}

/**
 * One repo's `.aider.chat.history.md`, appended to by every run of Aider
 * there. Each `# aider chat started at` header is a session; the session's
 * project is the repo root the file sits in. Resumes at a stored offset that
 * is always the first line of an item, with the open run's state beside it.
 */
function ingestAiderFile(db: Db, file: string, counts: Counts, now: number): void {
  const st = statSyncSafe(file);
  if (!st) return;
  const row = offsetRow(db, file);
  let start = row?.byte_offset ?? 0;
  let state: AiderSessionState | null = start > 0 && row?.reader_state ? JSON.parse(row.reader_state) : null;
  // Shorter than where we stopped: the log was cleared or replaced. Ids
  // carry each run's header time, so its new runs do not collide with old ones.
  if (st.size < start) { start = 0; state = null; }
  if (st.size <= start) return;
  counts.filesScanned++;
  const cwd = path.dirname(file);
  const { lines, end } = readCompleteLines(file, start, st.size);
  const items = splitAiderLines(lines);
  // Land everything once the file has sat still and was read to its end.
  // Otherwise the newest turn (its prompt onward) waits: Aider writes the
  // reply whole, then its usage line and edit results after it.
  let cut = items.length;
  if (now - st.mtimeMs < SETTLE_MS || end < st.size) {
    let lastUser = -1;
    items.forEach((it, i) => { if (it.kind === 'user') lastUser = i; });
    cut = lastUser >= 0 ? lastUser : items.length - (items[items.length - 1]?.kind === 'output' ? 1 : 0);
    // A single item larger than our read budget would never land otherwise.
    if (cut === 0 && end < st.size) cut = items.length;
  }
  const landing = items.slice(0, cut);
  const resumeAt = cut < items.length ? items[cut].offset : end;

  let inputs: Array<{ ms: number; text: string }> | null = null;
  const inputHistory = () => {
    if (inputs) return inputs;
    try { inputs = parseAiderInputHistory(readFileSync(path.join(cwd, AIDER_INPUT_HISTORY_FILE), 'utf8')); } catch { inputs = []; }
    return inputs;
  };

  let messages: UfMessage[] = [];
  const land = () => {
    if (state && messages.length) {
      const firstPrompt = messages.find((m) => m.role === 'user' && m.content[0]?.type === 'text')?.content[0]?.text ?? null;
      const sessionId = landSession(db, 'aider', {
        sessionUuid: state.sessionId, cwd, createdAt: new Date(state.startedMs).toISOString(), firstPrompt,
        cliVersion: state.version ? `aider ${state.version}` : 'aider',
      }, messages, counts);
      // A run's startup lines can land a pass before its first prompt does.
      if (firstPrompt) db.prepare('UPDATE sessions SET first_prompt = ? WHERE id = ? AND first_prompt IS NULL').run(firstPrompt, sessionId);
    }
    messages = [];
  };
  const opened = (item: AiderItem): AiderSessionState | null => {
    const ms = aiderLocalTime(item.startedAt!);
    if (Number.isNaN(ms)) return null;
    return {
      sessionId: aiderSessionId(file, item.offset, item.startedAt!), startedMs: ms, headerOffset: item.offset,
      model: null, version: null, clockMs: ms, inputMs: 0,
    };
  };
  for (const item of landing) {
    if (item.kind === 'header') {
      land();
      state = opened(item);
      continue;
    }
    // Aider writes a header before anything else on every run (io.py), so
    // lines before the first one are not a run of its.
    if (!state) continue;
    const needsInputs = item.kind === 'user' && !!aiderUserText(item);
    messages.push(...aiderItemToMessages(item, state, {
      cwd, inputs: needsInputs ? inputHistory() : [], previous: messages[messages.length - 1] ?? null,
    }));
  }
  land();
  storeOffset(db, file, resumeAt, st.mtimeMs, state ?? undefined);
}

export interface ForeignSource {
  harness: string;
  format: HarnessFormat;
  /** Where its files live; empty for a harness that writes inside each repository (`repoFile`). */
  root: string;
  /**
   * For a `repoFile` harness: the repository roots to look in. Absent, the
   * roots of the projects already in our database (db/project-roots.ts).
   */
  roots?: string[];
}

/** The registry's ingested harnesses that need a reader of their own. */
export function foreignSources(): ForeignSource[] {
  return ingestedHarnesses()
    .filter((h) => FOREIGN_FORMATS.has(h.format!))
    .map((h) => ({ harness: h.id, format: h.format!, root: h.repoFile ? '' : HARNESS_ROOTS[h.id]() }));
}

/**
 * One foreign source: every session file under its root that has something
 * new. Exported for the tests, which point it at a fixture root; production
 * reaches it through `ingestAll`.
 */
export function ingestForeignSource(db: Db, source: ForeignSource, opts: { now?: number } = {}): Counts {
  const counts = emptyCounts();
  const now = opts.now ?? Date.now();
  if (source.format === 'aider-history') {
    // No root of its own: one log per repository we already know.
    for (const root of source.roots ?? knownProjectRoots(db)) {
      for (const f of foreignSessionFiles(source.format, root) ?? []) {
        try { ingestAiderFile(db, f, counts, now); } catch (err) { console.error(`[ingest] aider ${f}:`, err); }
      }
    }
    return counts;
  }
  if (!source.root || !existsSync(source.root)) return counts;
  const files = foreignSessionFiles(source.format, source.root) ?? [];
  switch (source.format) {
    case 'codex-rollout':
      for (const f of files) {
        try { ingestCodexFile(db, f, counts); } catch (err) { console.error(`[ingest] codex ${f}:`, err); }
      }
      break;
    case 'gemini-chat': {
      const cwdOf = geminiCwdResolver(db, source.root);
      for (const f of files) {
        try { ingestGeminiFile(db, f, source.root, cwdOf, counts, now); } catch (err) { console.error(`[ingest] gemini ${f}:`, err); }
      }
      break;
    }
    case 'continue-session': {
      let created: Map<string, string> | null = null;
      const lazy = () => (created ??= continueCreatedAt(source.root));
      for (const f of files) {
        try { ingestContinueFile(db, f, lazy, counts, now); } catch (err) { console.error(`[ingest] continue ${f}:`, err); }
      }
      break;
    }
  }
  return counts;
}
