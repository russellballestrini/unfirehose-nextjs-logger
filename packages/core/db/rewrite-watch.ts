/**
 * Rewrite watch — a diagnostic beside the witness, not part of it.
 *
 * The witness (provenance-ingest.ts) refuses to record an UNCHAINED
 * journal until its writer has been quiet for QUIESCENT_MS, because a
 * writer we do not own rewrites lines near the tail of a live file:
 * Claude Code, 2026-09-16 12:16, "leaf 2255 differs" 37 s after
 * backfill on two live transcripts nobody had touched. That rule keeps
 * false memory out of the evidence lane, and it leaves us knowing that
 * the history of a live file changes while knowing nothing about WHAT
 * changes, or how far back from the tail.
 *
 * This module watches the opposite set of files — the ones still being
 * written — and keeps a live per-line shadow of each. When a line the
 * shadow already holds hashes differently on the next pass, the before
 * and the after are written down side by side, with how far from the
 * tail it sat and which JSON keys moved. When the file is shorter than
 * the shadow, the lost lines are recorded as truncated. The shadow is
 * memory for a diagnostic, never evidence: it is dropped once a file
 * has been quiet long enough to be the witness's business.
 *
 * Bounded per pass, never a dependency of ingest, never throws out of
 * one bad file.
 */
import type Database from 'better-sqlite3';
import { readFileSync, statSync } from 'fs';
import { createHash } from 'crypto';
import path from 'path';
import { witnessHash } from '../provenance';
import { QUIESCENT_MS, quiescent } from './provenance-ingest';

/** Longest line body the shadow and a rewrite row keep verbatim. */
export const SHADOW_TEXT_CAP = 4096;
/** A shadow whose file has been quiet this long belongs to the witness, and is dropped. */
export const SHADOW_PRUNE_MS = 60 * 60_000;

export type RewriteKind = 'rewritten' | 'truncated';

export interface RewriteRow {
  id: number;
  session_uuid: string;
  project: string | null;
  harness: string | null;
  seq: number;
  kind: RewriteKind;
  observed_at: string;
  file_lines: number;
  tail_distance: number;
  before_hash: string;
  after_hash: string | null;
  before_text: string;
  after_text: string | null;
  before_len: number;
  after_len: number | null;
  truncated: boolean;
  changed_keys: string[];
  content_changed: boolean;
  before_type: string | null;
  after_type: string | null;
}

export interface RewriteSummary {
  total: number;
  sessions: number;
  byHarness: Record<string, number>;
  maxTailDistance: number;
  contentChanged: number;
  metadataOnly: number;
  truncations: number;
  byChangedKey: Record<string, number>;
}

export function ensureRewriteTables(db: Database.Database) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS session_shadow_leaves (
      session_uuid TEXT NOT NULL,
      seq INTEGER NOT NULL,                      -- 0-based among the non-blank complete lines
      hash TEXT NOT NULL,                        -- witnessHash of the line
      text TEXT NOT NULL,                        -- the line, capped at SHADOW_TEXT_CAP chars
      len INTEGER NOT NULL,                      -- full length, whatever was kept
      truncated INTEGER NOT NULL DEFAULT 0,      -- 1 when text was capped
      digest TEXT,                               -- JSON {type, keys:{<key>: hash}} of the FULL line, so a capped line still classifies
      PRIMARY KEY (session_uuid, seq)
    );
    CREATE TABLE IF NOT EXISTS session_rewrites (
      id INTEGER PRIMARY KEY,
      session_uuid TEXT NOT NULL,
      harness TEXT,
      seq INTEGER NOT NULL,
      kind TEXT NOT NULL,                        -- rewritten | truncated
      observed_at TEXT NOT NULL DEFAULT (datetime('now')),
      file_lines INTEGER NOT NULL,               -- complete lines in the file when observed
      tail_distance INTEGER NOT NULL,            -- file_lines - 1 - seq (negative for a truncated line)
      before_hash TEXT NOT NULL,
      after_hash TEXT,
      before_text TEXT NOT NULL,
      after_text TEXT,
      before_len INTEGER NOT NULL,
      after_len INTEGER,
      truncated INTEGER NOT NULL DEFAULT 0,      -- 1 when either text was capped
      changed_keys TEXT NOT NULL DEFAULT '[]',   -- JSON array; "message.<key>" for the nested message object
      content_changed INTEGER NOT NULL DEFAULT 0,
      before_type TEXT,
      after_type TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_session_rewrites_observed ON session_rewrites(observed_at DESC);
    CREATE INDEX IF NOT EXISTS idx_session_rewrites_session ON session_rewrites(session_uuid);
  `);
  try { db.exec('ALTER TABLE session_shadow_leaves ADD COLUMN digest TEXT'); } catch { /* exists */ }
}

// ---------------------------------------------------------------------------
// Classification: which keys of a JSON line moved.

interface LineDigest {
  type: string | null;
  keys: Record<string, string>;   // key (or "message.<key>") -> short hash of its canonical JSON
}

/** JSON with keys sorted, so a writer that reorders keys is not a rewrite of every key. */
function canon(v: unknown): string {
  if (v === null || typeof v !== 'object') return JSON.stringify(v) ?? 'undefined';
  if (Array.isArray(v)) return `[${v.map(canon).join(',')}]`;
  const o = v as Record<string, unknown>;
  return `{${Object.keys(o).sort().map((k) => `${JSON.stringify(k)}:${canon(o[k])}`).join(',')}}`;
}

const short = (s: string) => createHash('sha256').update(s, 'utf8').digest('hex').slice(0, 16);

/**
 * Per-key digests of one line. The nested `message` object (Claude Code's
 * shape: `{type, uuid, message: {role, content, usage, …}}`) is opened one
 * level so a usage refresh is told apart from a content edit. `null` when
 * the line is not a JSON object.
 */
export function digestLine(line: string): LineDigest | null {
  let v: unknown;
  try { v = JSON.parse(line); } catch { return null; }
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  const keys: Record<string, string> = {};
  for (const k of Object.keys(o)) {
    const val = o[k];
    if (k === 'message' && val !== null && typeof val === 'object' && !Array.isArray(val)) {
      for (const mk of Object.keys(val as Record<string, unknown>)) {
        keys[`message.${mk}`] = short(canon((val as Record<string, unknown>)[mk]));
      }
      continue;
    }
    keys[k] = short(canon(val));
  }
  return { type: typeof o.type === 'string' ? o.type : null, keys };
}

export interface Classification {
  changed_keys: string[];
  content_changed: 0 | 1;
  before_type: string | null;
  after_type: string | null;
}

/**
 * Keys whose value differs between two digests. When either side is not
 * a JSON object the whole line is the unit and `changed_keys` is `["raw"]`.
 */
export function classify(before: LineDigest | null, after: LineDigest | null): Classification {
  if (!before || !after) {
    return { changed_keys: ['raw'], content_changed: 0, before_type: before?.type ?? null, after_type: after?.type ?? null };
  }
  const all = new Set([...Object.keys(before.keys), ...Object.keys(after.keys)]);
  const changed = [...all].filter((k) => before.keys[k] !== after.keys[k]).sort();
  const content_changed = changed.includes('message.content') || changed.includes('content') ? 1 : 0;
  return { changed_keys: changed, content_changed, before_type: before.type, after_type: after.type };
}

// ---------------------------------------------------------------------------
// The pass.

export interface WatchResult { files: number; rewrites: number; truncations: number; pruned: number }

interface ShadowRow { seq: number; hash: string; text: string; len: number; truncated: number; digest: string | null }
interface Candidate { session_uuid: string; file_path: string; mtime: number }

const uuidOf = (filePath: string) => path.basename(filePath).replace(/\.jsonl$/, '');

/** Complete, non-blank lines of a journal; a trailing partial line (no final newline) is dropped. */
function completeLines(filePath: string): string[] {
  let text = readFileSync(filePath, 'utf8');
  if (text.length && !text.endsWith('\n')) text = text.slice(0, text.lastIndexOf('\n') + 1);
  return text.split('\n').filter((l) => l.trim());
}

/** The digest a shadow row carries; a row from before the column existed digests its text when uncapped. */
function parseDigest(s: ShadowRow): LineDigest | null {
  if (s.digest) { try { return JSON.parse(s.digest) as LineDigest | null; } catch { return null; } }
  return s.truncated ? null : digestLine(s.text);
}

function cap(line: string): { text: string; truncated: 0 | 1 } {
  return line.length > SHADOW_TEXT_CAP ? { text: line.slice(0, SHADOW_TEXT_CAP), truncated: 1 } : { text: line, truncated: 0 };
}

/**
 * Live unchained journals: no `session_chain` row, or one with `hashed = 0`,
 * and a file written within QUIESCENT_MS — the set the witness will not
 * touch yet. Drawn from where ingest actually read each file, most
 * recently ingested first, plus every session the shadow already holds
 * (a rewrite that changes no byte count is invisible to ingest's
 * has-new-bytes check, so a watched file stays watched by its mtime).
 */
function candidates(db: Database.Database, limit: number): Candidate[] {
  const byUuid = new Map<string, Candidate>();
  const consider = (file_path: string) => {
    const session_uuid = uuidOf(file_path);
    if (!session_uuid || byUuid.has(session_uuid)) return;
    let mtime: number;
    try { mtime = statSync(file_path).mtimeMs; } catch { return; }
    if (Date.now() - mtime >= QUIESCENT_MS) return;          // quiescent: the witness's file, not ours
    byUuid.set(session_uuid, { session_uuid, file_path, mtime });
  };
  const recent = db.prepare(
    "SELECT file_path FROM ingest_offsets WHERE file_path LIKE '%.jsonl' ORDER BY last_ingested DESC LIMIT ?",
  ).all(limit * 4) as { file_path: string }[];
  for (const r of recent) consider(r.file_path);
  const held = db.prepare('SELECT DISTINCT session_uuid FROM session_shadow_leaves LIMIT ?')
    .all(limit * 4) as { session_uuid: string }[];
  const where = db.prepare(
    'SELECT file_path FROM ingest_offsets WHERE file_path LIKE ? ORDER BY last_ingested DESC LIMIT 1',
  );
  for (const h of held) {
    if (byUuid.has(h.session_uuid)) continue;
    const known = where.get(`%/${h.session_uuid}.jsonl`) as { file_path: string } | undefined;
    if (known) consider(known.file_path);
  }
  const chained = db.prepare('SELECT hashed FROM session_chain WHERE session_uuid = ?');
  return [...byUuid.values()]
    .filter((c) => {
      const row = chained.get(c.session_uuid) as { hashed: number } | undefined;
      return !row || row.hashed === 0;
    })
    .sort((a, b) => b.mtime - a.mtime)
    .slice(0, limit);
}

/**
 * One bounded pass: compare every live unchained journal with its shadow,
 * record what moved, bring the shadow up to date, and drop shadows whose
 * file has gone quiet for SHADOW_PRUNE_MS. Called at the end of every
 * ingest pass beside the witness; a file that cannot be read or parsed
 * is skipped, never fatal.
 */
export function watchRewrites(db: Database.Database, opts: { limit?: number } = {}): WatchResult {
  const limit = opts.limit ?? 25;
  const out: WatchResult = { files: 0, rewrites: 0, truncations: 0, pruned: 0 };
  ensureRewriteTables(db);

  const harnessOf = db.prepare('SELECT harness FROM sessions WHERE session_uuid = ?');
  const shadowOf = db.prepare('SELECT seq, hash, text, len, truncated, digest FROM session_shadow_leaves WHERE session_uuid = ? ORDER BY seq');
  const putShadow = db.prepare(
    `INSERT OR REPLACE INTO session_shadow_leaves (session_uuid, seq, hash, text, len, truncated, digest)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  );
  const dropPast = db.prepare('DELETE FROM session_shadow_leaves WHERE session_uuid = ? AND seq >= ?');
  const insRewrite = db.prepare(
    `INSERT INTO session_rewrites (session_uuid, harness, seq, kind, file_lines, tail_distance,
       before_hash, after_hash, before_text, after_text, before_len, after_len, truncated,
       changed_keys, content_changed, before_type, after_type)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );

  for (const c of candidates(db, limit)) {
    try {
      const lines = completeLines(c.file_path);
      const harness = (harnessOf.get(c.session_uuid) as { harness: string | null } | undefined)?.harness ?? null;
      const shadow = shadowOf.all(c.session_uuid) as ShadowRow[];
      const fileLines = lines.length;
      db.transaction(() => {
        const hashes = lines.map(witnessHash);
        for (const s of shadow) {
          if (s.seq >= fileLines) {
            insRewrite.run(c.session_uuid, harness, s.seq, 'truncated', fileLines, fileLines - 1 - s.seq,
              s.hash, null, s.text, null, s.len, null, s.truncated, '[]', 0,
              parseDigest(s)?.type ?? null, null);
            out.truncations += 1;
            continue;
          }
          if (hashes[s.seq] === s.hash) continue;
          const line = lines[s.seq];
          const after = cap(line);
          const before = parseDigest(s);
          const cls = classify(before, digestLine(line));
          insRewrite.run(c.session_uuid, harness, s.seq, 'rewritten', fileLines, fileLines - 1 - s.seq,
            s.hash, hashes[s.seq], s.text, after.text, s.len, line.length, s.truncated || after.truncated ? 1 : 0,
            JSON.stringify(cls.changed_keys), cls.content_changed, cls.before_type, cls.after_type);
          out.rewrites += 1;
        }
        // Bring the shadow to the file as it is now: replace changed lines,
        // append new ones, forget those past the end.
        const known = new Map(shadow.map((s) => [s.seq, s.hash]));
        for (let seq = 0; seq < fileLines; seq++) {
          if (known.get(seq) === hashes[seq]) continue;
          const t = cap(lines[seq]);
          putShadow.run(c.session_uuid, seq, hashes[seq], t.text, lines[seq].length, t.truncated,
            JSON.stringify(digestLine(lines[seq])));
        }
        if (shadow.length > fileLines) dropPast.run(c.session_uuid, fileLines);
      })();
      out.files += 1;
    } catch { /* one unreadable file never stops the pass */ }
  }

  out.pruned = pruneShadows(db, limit * 4);
  return out;
}

/**
 * Drop the shadow of every session whose file has been quiet for
 * SHADOW_PRUNE_MS or is gone: by then the witness has recorded it and a
 * later rewrite is its `rewritten` verdict, not this diagnostic's row.
 * Bounded to `limit` sessions checked per pass.
 */
export function pruneShadows(db: Database.Database, limit = 100): number {
  const held = db.prepare('SELECT DISTINCT session_uuid FROM session_shadow_leaves LIMIT ?')
    .all(limit) as { session_uuid: string }[];
  const where = db.prepare(
    'SELECT file_path FROM ingest_offsets WHERE file_path LIKE ? ORDER BY last_ingested DESC LIMIT 1',
  );
  const del = db.prepare('DELETE FROM session_shadow_leaves WHERE session_uuid = ?');
  let n = 0;
  for (const h of held) {
    const known = where.get(`%/${h.session_uuid}.jsonl`) as { file_path: string } | undefined;
    // quiescent() answers true for a missing file too.
    if (!known || quiescent(known.file_path, SHADOW_PRUNE_MS)) { del.run(h.session_uuid); n += 1; }
  }
  return n;
}

// ---------------------------------------------------------------------------
// Read side.

/** SQLite's `datetime('now')` spelling, UTC. */
function sqlTime(d: Date): string {
  return d.toISOString().slice(0, 19).replace('T', ' ');
}

interface RawRewriteRow extends Omit<RewriteRow, 'truncated' | 'changed_keys' | 'content_changed'> {
  truncated: number;
  changed_keys: string;
  content_changed: number;
}

function shape(r: RawRewriteRow): RewriteRow {
  let keys: string[] = [];
  try { keys = JSON.parse(r.changed_keys); } catch { keys = []; }
  return { ...r, truncated: r.truncated === 1, changed_keys: keys, content_changed: r.content_changed === 1 };
}

/** Rewrite rows newest first, each with the project its session belongs to. */
export function getRewrites(
  db: Database.Database,
  opts: { limit?: number; session?: string; harness?: string; since?: Date | string } = {},
): RewriteRow[] {
  const where: string[] = [];
  const args: unknown[] = [];
  if (opts.session) { where.push('r.session_uuid = ?'); args.push(opts.session); }
  if (opts.harness) { where.push('r.harness = ?'); args.push(opts.harness); }
  if (opts.since) { where.push('r.observed_at >= ?'); args.push(opts.since instanceof Date ? sqlTime(opts.since) : opts.since); }
  const rows = db.prepare(
    `SELECT r.*, p.name AS project FROM session_rewrites r
       LEFT JOIN sessions s ON s.session_uuid = r.session_uuid
       LEFT JOIN projects p ON p.id = s.project_id
      ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
      ORDER BY r.observed_at DESC, r.id DESC LIMIT ?`,
  ).all(...args, Math.max(1, Math.min(opts.limit ?? 50, 1000))) as RawRewriteRow[];
  return rows.map(shape);
}

/** What the window's rewrites amount to: who rewrites, how far back, and which keys. */
export function getRewriteSummary(db: Database.Database, opts: { sinceHours?: number } = {}): RewriteSummary {
  const since = sqlTime(new Date(Date.now() - (opts.sinceHours ?? 24) * 3_600_000));
  const agg = db.prepare(
    `SELECT COUNT(*) AS total, COUNT(DISTINCT session_uuid) AS sessions,
            COALESCE(MAX(tail_distance), 0) AS maxTailDistance,
            SUM(content_changed = 1) AS contentChanged,
            SUM(kind = 'rewritten' AND content_changed = 0) AS metadataOnly,
            SUM(kind = 'truncated') AS truncations
       FROM session_rewrites WHERE observed_at >= ?`,
  ).get(since) as { total: number; sessions: number; maxTailDistance: number; contentChanged: number | null; metadataOnly: number | null; truncations: number | null };
  const byHarness: Record<string, number> = {};
  for (const r of db.prepare(
    `SELECT COALESCE(harness, 'unknown') AS h, COUNT(*) AS c FROM session_rewrites WHERE observed_at >= ? GROUP BY h ORDER BY c DESC`,
  ).all(since) as { h: string; c: number }[]) byHarness[r.h] = r.c;
  const byChangedKey: Record<string, number> = {};
  for (const r of db.prepare(
    `SELECT j.value AS k, COUNT(*) AS c FROM session_rewrites r, json_each(r.changed_keys) j
      WHERE r.observed_at >= ? GROUP BY k ORDER BY c DESC, k ASC LIMIT 12`,
  ).all(since) as { k: string; c: number }[]) byChangedKey[r.k] = r.c;
  return {
    total: agg.total,
    sessions: agg.sessions,
    byHarness,
    maxTailDistance: agg.maxTailDistance,
    contentChanged: agg.contentChanged ?? 0,
    metadataOnly: agg.metadataOnly ?? 0,
    truncations: agg.truncations ?? 0,
    byChangedKey,
  };
}
