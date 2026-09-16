/**
 * Chain verification at ingest — the layer where "schema-legal" becomes
 * "kept". `session.json` and `message.json` allow the chain keys today
 * (`additionalProperties: true`), but this ingester extracts columns
 * and keeps no raw line, so without these tables a `hash` a writer
 * paid for was dropped on the floor.
 *
 * One `session_chain` row per session holds the verifier state between
 * incremental passes (ingest resumes from a byte offset, so the state
 * machine has to too); `session_chain_leaves` holds every line hash in
 * write order, which is what the root at close is computed over and
 * what an inclusion proof for one message is built from later.
 *
 * Verdict per session: unchained / open / verified / corrupted — the
 * vocabulary `provenance.ts` shares with the Python verifier. A break
 * is recorded with its line index and reason; nothing is skipped
 * silently. See packages/schema/docs/sessions.md § Chain.
 */
import type Database from 'better-sqlite3';
import { readFileSync, statSync } from 'fs';
import { ChainState, emptyChainState, witnessHash, type ChainStateData, type ChainVerdict, splitChainedLine, lineHash } from '../provenance';

export interface SessionChainRow extends ChainStateData {
  session_uuid: string;
  state: ChainVerdict;
  updated_at: string;
  file_path: string | null;
  anchor_state: AnchorState | null;
  anchor_checked_at: string | null;
  anchor_detail: string | null;
}

/**
 * What the file looks like now against what THIS process recorded as it
 * grew. A chain can be re-hashed by whoever can rewrite the file; the
 * leaves this ingester wrote down earlier cannot. So `intact` means the
 * recorded leaves are still a prefix of the file, `rewritten` means a
 * recorded line now hashes differently or the file lost lines, `missing`
 * means the journal is gone. The witness is only as independent as the
 * process running it: on the fleet, that is the host beside the
 * container, which is the point.
 */
export type AnchorState = 'intact' | 'rewritten' | 'missing';

export function ensureProvenanceTables(db: Database.Database) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS session_chain (
      session_uuid TEXT PRIMARY KEY,
      state TEXT NOT NULL DEFAULT 'unchained',   -- unchained | open | verified | corrupted
      entries INTEGER NOT NULL DEFAULT 0,        -- lines seen, chained or not
      hashed INTEGER NOT NULL DEFAULT 0,         -- lines carrying a hash
      breaks INTEGER NOT NULL DEFAULT 0,
      first_break INTEGER,                       -- 0-based line index of the first break
      first_break_reason TEXT,
      last_hash TEXT,
      root_expected TEXT,                        -- sessionRoot the closed record claimed
      root_computed TEXT,                        -- root recomputed over the leaves before it
      root_seq INTEGER,                          -- line index of the closed record
      hash_version TEXT,
      merkle_version TEXT,                       -- rules the root was minted under, as the record named them
      encoding_version TEXT,
      root_semantics TEXT,                       -- SET | SEQUENCE | MULTISET
      file_path TEXT,                            -- where the journal was read from, for the anchor audit
      anchor_state TEXT,                         -- intact | rewritten | missing — the file vs what this witness recorded
      anchor_checked_at TEXT,
      anchor_detail TEXT,
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS session_chain_leaves (
      session_uuid TEXT NOT NULL,
      seq INTEGER NOT NULL,                      -- position among the lines this witness read
      hash TEXT NOT NULL,                        -- the writer's hash for a chained line, sha256 of the bytes otherwise
      kind TEXT NOT NULL DEFAULT 'chain',        -- chain | line
      PRIMARY KEY (session_uuid, seq)
    );
    CREATE INDEX IF NOT EXISTS idx_session_chain_state ON session_chain(state);
    -- One row per finding, never one per session: every leaf the witness
    -- sees differ, every range of lines a file lost, every chain break the
    -- verifier hit. A re-audit that finds the same divergence again adds
    -- nothing (unique below); a line rewritten a second time is a second
    -- event, because its current hash is new.
    CREATE TABLE IF NOT EXISTS session_anchor_events (
      id INTEGER PRIMARY KEY,
      session_uuid TEXT NOT NULL,
      seq INTEGER NOT NULL,                      -- 0-based line index (first of a lost range)
      seq_to INTEGER,                            -- last index of a lost range, else NULL
      kind TEXT NOT NULL,                        -- rewritten | lost | hash_mismatch | prev_mismatch | root_mismatch | unchained_line | late_genesis | unparseable | unknown_rules
      recorded_hash TEXT,                        -- what the witness / chain expected at seq
      current_hash TEXT,                         -- what the file holds now (NULL when lost)
      current_text TEXT,                         -- the line as it is now, capped
      observed_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_anchor_events_once
      ON session_anchor_events(session_uuid, seq, kind, IFNULL(current_hash, ''));
    CREATE INDEX IF NOT EXISTS idx_anchor_events_observed ON session_anchor_events(observed_at DESC);
  `);
  // A database created before the rule columns were named.
  for (const col of ['merkle_version', 'encoding_version', 'root_semantics',
    'file_path', 'anchor_state', 'anchor_checked_at', 'anchor_detail']) {
    try { db.exec(`ALTER TABLE session_chain ADD COLUMN ${col} TEXT`); } catch { /* exists */ }
  }
  try { db.exec("ALTER TABLE session_chain_leaves ADD COLUMN kind TEXT NOT NULL DEFAULT 'chain'"); } catch { /* exists */ }
  // Rows the mid-file join wrote between 12:16 and the fix on 2026-09-16:
  // unchained, numbered from the wrong line, audited "leaf 0 differs".
  // They are a defect's output, not evidence; dropping them lets the
  // backfill record the file properly from byte 0. Once.
  try {
    const done = db.prepare("SELECT value FROM settings WHERE key = 'witness_repair_2026_09_16'").get();
    if (!done) {
      const bad = db.prepare(
        `SELECT session_uuid FROM session_chain
          WHERE hashed = 0 AND anchor_state = 'rewritten'
            AND anchor_detail = 'leaf 0 differs from what was recorded at ingest'
            AND updated_at < '2026-09-16 13:00:00'`,
      ).all() as { session_uuid: string }[];
      for (const r of bad) {
        db.prepare('DELETE FROM session_chain_leaves WHERE session_uuid = ?').run(r.session_uuid);
        db.prepare('DELETE FROM session_chain WHERE session_uuid = ?').run(r.session_uuid);
      }
      db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('witness_repair_2026_09_16', ?)").run(String(bad.length));
    }
    // Unchained rows recorded before the quiescence rule, i.e. while their
    // writer was still rewriting the tail; same reasoning, same day.
    const done2 = db.prepare("SELECT value FROM settings WHERE key = 'witness_repair_2026_09_16b'").get();
    if (!done2) {
      const live = db.prepare(
        `SELECT session_uuid FROM session_chain
          WHERE hashed = 0 AND anchor_state = 'rewritten' AND updated_at < '2026-09-16 14:00:00'`,
      ).all() as { session_uuid: string }[];
      for (const r of live) {
        db.prepare('DELETE FROM session_chain_leaves WHERE session_uuid = ?').run(r.session_uuid);
        db.prepare('DELETE FROM session_chain WHERE session_uuid = ?').run(r.session_uuid);
      }
      db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('witness_repair_2026_09_16b', ?)").run(String(live.length));
    }
    // Fleet sessions the backfill recorded as missing at a path resolved
    // from the project name, before it learned to ask ingest_offsets.
    const done3 = db.prepare("SELECT value FROM settings WHERE key = 'witness_repair_2026_09_16c'").get();
    if (!done3) {
      const n = db.prepare('DELETE FROM session_chain WHERE entries = 0 AND hashed = 0').run().changes;
      db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('witness_repair_2026_09_16c', ?)").run(String(n));
    }
  } catch { /* no settings table yet: a fresh database has nothing to repair */ }
}

/** Read a session's chain row, or null when nothing has been verified for it. */
export function getSessionChain(db: Database.Database, sessionUuid: string): SessionChainRow | null {
  const row = db.prepare('SELECT * FROM session_chain WHERE session_uuid = ?').get(sessionUuid) as
    | SessionChainRow
    | undefined;
  return row ?? null;
}

/** Chain verdict and witness state for many sessions at once, keyed by uuid. */
export function getSessionChains(
  db: Database.Database,
  uuids: string[],
): Record<string, { state: ChainVerdict; anchor: AnchorState | null; breaks: number; firstBreak: number | null }> {
  const out: Record<string, { state: ChainVerdict; anchor: AnchorState | null; breaks: number; firstBreak: number | null }> = {};
  const ids = [...new Set(uuids)].filter(Boolean);
  for (let i = 0; i < ids.length; i += 500) {
    const slice = ids.slice(i, i + 500);
    const rows = db.prepare(
      `SELECT session_uuid, state, anchor_state, breaks, first_break FROM session_chain
        WHERE session_uuid IN (${slice.map(() => '?').join(',')})`,
    ).all(...slice) as { session_uuid: string; state: ChainVerdict; anchor_state: AnchorState | null; breaks: number; first_break: number | null }[];
    for (const r of rows) out[r.session_uuid] = { state: r.state, anchor: r.anchor_state, breaks: r.breaks, firstBreak: r.first_break };
  }
  return out;
}

/** Counts per verdict across every session that has a chain row. */
export function getChainSummary(db: Database.Database): Record<ChainVerdict, number> {
  const out: Record<ChainVerdict, number> = { unchained: 0, open: 0, verified: 0, corrupted: 0 };
  for (const r of db.prepare('SELECT state, COUNT(*) AS c FROM session_chain GROUP BY state').all() as
    { state: ChainVerdict; c: number }[]) {
    out[r.state] = r.c;
  }
  return out;
}

/** The per-session tracker the ingest loops drive. */
export class SessionChainTracker {
  private readonly state: ChainState;
  private readonly pendingLeaves: [number, string, 'chain' | 'line'][] = [];
  private leafCount: number;

  /**
   * `reset` when the caller is reading the file from byte 0 (a first
   * pass, or an offset that was reset): prior state is a different
   * reading of the same bytes. The cloud path, which receives batches
   * with no offset, always continues.
   */
  private readonly filePath: string | null;
  /** True when this pass started mid-file with no prior record: nothing is recorded. */
  readonly deferred: boolean;
  private readonly headKnown: boolean;

  constructor(
    private readonly db: Database.Database,
    private readonly sessionUuid: string,
    opts: { reset: boolean; filePath?: string; headKnown?: boolean } = { reset: false },
  ) {
    this.filePath = opts.filePath ?? null;
    const existing = opts.reset ? null : getSessionChain(db, sessionUuid);
    // Joining a file MID-WAY with no record of its head would number the
    // leaves from the wrong line and the audit would then call line 0
    // "rewritten" (2026-09-16 12:16, two live Claude Code transcripts).
    // Such a session is left to backfillWitness, which reads from byte 0.
    // The cloud batch path has no offset to consult and treats a session's
    // first batch as its head (`headKnown`), which is what it did before.
    this.deferred = !opts.reset && !existing && !opts.headKnown;
    this.headKnown = !!opts.headKnown;
    if (existing) {
      const { session_uuid: _u, state: _s, updated_at: _t, ...data } = existing;
      // The chain resumes from the writer's own hashes; the witness list
      // (every line, chained or not) only needs its length.
      const leaves = (db
        .prepare("SELECT hash FROM session_chain_leaves WHERE session_uuid = ? AND kind = 'chain' ORDER BY seq")
        .all(sessionUuid) as { hash: string }[]).map((r) => r.hash);
      this.state = new ChainState({ ...emptyChainState(), ...data }, leaves);
      this.leafCount = (db.prepare('SELECT COUNT(*) AS c FROM session_chain_leaves WHERE session_uuid = ?')
        .get(sessionUuid) as { c: number }).c;
    } else {
      if (opts.reset) {
        db.prepare('DELETE FROM session_chain_leaves WHERE session_uuid = ?').run(sessionUuid);
        db.prepare('DELETE FROM session_chain WHERE session_uuid = ?').run(sessionUuid);
      }
      this.state = new ChainState();
      this.leafCount = 0;
    }
  }

  /** Feed one COMPLETE line (never a partial tail). Returns its hash, or null when unchained. */
  feed(line: string): string | null {
    if (this.deferred) return null;
    const hash = this.state.feed(line);
    // Every line is witnessed; only a chained one is also a chain leaf.
    this.pendingLeaves.push([this.leafCount++, hash ?? witnessHash(line), hash !== null ? 'chain' : 'line']);
    return hash;
  }

  get verdict(): ChainVerdict {
    return this.state.verdict;
  }

  /** Persist state and new leaves. Runs inside the caller's transaction when there is one. */
  flush() {
    const d = this.state.data;
    if (this.deferred || (d.entries === 0 && this.pendingLeaves.length === 0)) return;
    // An unchained journal is recorded by the backfill, once its writer
    // has gone quiet (see QUIESCENT_MS): lines taken from a live file a
    // non-append-only writer may still rewrite would be false memory.
    if (d.hashed === 0 && !this.headKnown) return;
    db_upsert(this.db, this.sessionUuid, this.state.verdict, d, this.filePath);
    const ins = this.db.prepare(
      'INSERT OR REPLACE INTO session_chain_leaves (session_uuid, seq, hash, kind) VALUES (?, ?, ?, ?)',
    );
    for (const [seq, hash, kind] of this.pendingLeaves.splice(0)) ins.run(this.sessionUuid, seq, hash, kind);
    // Every chain break the verifier hit is its own finding, by index and
    // reason — the row keeps the first and the count, the events keep all.
    for (const b of this.state.breakLog.splice(0)) {
      recordAnchorEvent(this.db, this.sessionUuid, { seq: b.seq, kind: b.reason });
    }
  }
}

const CHAIN_COLUMNS = [
  'state', 'entries', 'hashed', 'breaks', 'first_break', 'first_break_reason',
  'last_hash', 'root_expected', 'root_computed', 'root_seq', 'hash_version',
  'merkle_version', 'encoding_version', 'root_semantics',
] as const;

function db_upsert(db: Database.Database, uuid: string, state: ChainVerdict, d: ChainStateData, filePath: string | null) {
  const values: Record<string, unknown> = { ...d, state };
  const cols = ['session_uuid', ...CHAIN_COLUMNS, 'file_path'];
  const sets = [...CHAIN_COLUMNS.map((c) => `${c} = excluded.${c}`),
    // A later pass without a path (the cloud batch route) keeps the one ingest recorded.
    'file_path = COALESCE(excluded.file_path, session_chain.file_path)',
    "updated_at = datetime('now')"];
  db.prepare(
    `INSERT INTO session_chain (${cols.join(', ')}, updated_at)
     VALUES (${cols.map(() => '?').join(', ')}, datetime('now'))
     ON CONFLICT(session_uuid) DO UPDATE SET ${sets.join(', ')}`,
  ).run(uuid, ...CHAIN_COLUMNS.map((c) => values[c] ?? null), filePath);
}

/**
 * Re-read one journal from byte 0 and compare it with the leaves this
 * witness recorded when it first read it. Returns the verdict written.
 */
/**
 * A writer we do not own is not necessarily append-only: Claude Code
 * rewrites lines near the tail of a LIVE transcript (this session's own
 * file read "leaf 2255 differs" 37 s after backfill, 2026-09-16). Its
 * bytes are evidence only once it has stopped writing, so the witness
 * neither records nor audits an unchained file touched within this
 * window. A chained journal is append-only by contract and needs no
 * such grace.
 */
export const QUIESCENT_MS = 10 * 60_000;

/** True once the file has gone `windowMs` without a write, or is gone. Shared with rewrite-watch.ts. */
export function quiescent(filePath: string, windowMs = QUIESCENT_MS): boolean {
  try { return Date.now() - statSync(filePath).mtimeMs >= windowMs; } catch { return true; }
}

/** Events one audit records by index before it only counts; a rewrite of a whole file is one fact, not ten thousand rows. */
export const ANCHOR_EVENTS_PER_AUDIT = 500;
/** Longest line body an event keeps verbatim. */
export const ANCHOR_EVENT_TEXT_CAP = 4096;

export interface AnchorEvent {
  id: number; session_uuid: string; seq: number; seq_to: number | null; kind: string;
  recorded_hash: string | null; current_hash: string | null; current_text: string | null; observed_at: string;
}

/** Record one finding; a repeat of the same finding (same seq, kind and current hash) is ignored. */
export function recordAnchorEvent(
  db: Database.Database, sessionUuid: string,
  e: { seq: number; kind: string; seq_to?: number | null; recorded_hash?: string | null; current_hash?: string | null; current_text?: string | null },
): boolean {
  const text = e.current_text == null ? null : String(e.current_text).slice(0, ANCHOR_EVENT_TEXT_CAP);
  const r = db.prepare(
    `INSERT OR IGNORE INTO session_anchor_events (session_uuid, seq, seq_to, kind, recorded_hash, current_hash, current_text)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(sessionUuid, e.seq, e.seq_to ?? null, e.kind, e.recorded_hash ?? null, e.current_hash ?? null, text);
  return r.changes > 0;
}

/** A session's findings, oldest line first. */
export function getAnchorEvents(db: Database.Database, sessionUuid: string, limit = 200): AnchorEvent[] {
  return db.prepare(
    'SELECT * FROM session_anchor_events WHERE session_uuid = ? ORDER BY seq ASC, id ASC LIMIT ?',
  ).all(sessionUuid, limit) as AnchorEvent[];
}

/** Findings across every session, newest first, for a feed. */
export function getRecentAnchorEvents(
  db: Database.Database, opts: { hours?: number; limit?: number; kind?: string } = {},
): (AnchorEvent & { project: string | null; harness: string | null })[] {
  const hours = opts.hours ?? 24;
  const params: unknown[] = [`-${hours} hours`];
  let where = "WHERE e.observed_at >= datetime('now', ?)";
  if (opts.kind) { where += ' AND e.kind = ?'; params.push(opts.kind); }
  params.push(opts.limit ?? 100);
  return db.prepare(
    `SELECT e.*, p.name AS project, s.harness AS harness FROM session_anchor_events e
       LEFT JOIN sessions s ON s.session_uuid = e.session_uuid
       LEFT JOIN projects p ON p.id = s.project_id
       ${where} ORDER BY e.observed_at DESC, e.id DESC LIMIT ?`,
  ).all(...params) as (AnchorEvent & { project: string | null; harness: string | null })[];
}

export function auditAnchor(db: Database.Database, sessionUuid: string): AnchorState | null {
  const row = getSessionChain(db, sessionUuid);
  if (!row || !row.file_path || row.entries === 0) return null;
  if (row.hashed === 0 && !quiescent(row.file_path)) return null;
  const recorded = (db
    .prepare('SELECT hash FROM session_chain_leaves WHERE session_uuid = ? ORDER BY seq')
    .all(sessionUuid) as { hash: string }[]).map((r) => r.hash);
  let state: AnchorState;
  let detail: string | null = null;
  let text: string | null = null;
  try { text = readFileSync(row.file_path, 'utf8'); } catch { text = null; }
  if (text === null) {
    state = 'missing';
    detail = row.file_path;
  } else {
    if (text.length && !text.endsWith('\n')) text = text.slice(0, text.lastIndexOf('\n') + 1);
    const now: string[] = [];
    for (const line of text.split('\n')) {
      if (!line.trim()) continue;
      now.push(witnessHash(line));
    }
    // The recorded leaves must still be a prefix of the file: the file
    // may have grown since, never changed or shrunk before the frontier.
    // Every divergence is its own event (fox, 2026-09-16: all the
    // changes, not the first); the row's detail names the first and
    // the count, which is what a badge can show.
    const lines = text.split('\n').filter((l) => l.trim());
    let differ = 0;
    let first = -1;
    const lost = now.length < recorded.length ? recorded.length - now.length : 0;
    for (let i = 0; i < recorded.length && i < now.length; i++) {
      let kind: string | null = null;
      let current = now[i];
      if (now[i] !== recorded[i]) {
        kind = 'rewritten';
      } else {
        // A chained line's leaf IS its claimed hash, so an edit that
        // leaves the 75-byte tail alone keeps the same leaf. Re-derive
        // the hash from the bytes: content changed under its own hash
        // is the needle a re-hashing forger would not bother to hide.
        const split = splitChainedLine(lines[i]);
        if (split && lineHash(split.preimage) !== split.hash) {
          kind = 'hash_mismatch';
          current = lineHash(split.preimage);
        }
      }
      if (!kind) continue;
      differ += 1;
      if (first < 0) first = i;
      if (differ <= ANCHOR_EVENTS_PER_AUDIT) {
        recordAnchorEvent(db, sessionUuid, { seq: i, kind,
          recorded_hash: recorded[i], current_hash: current, current_text: lines[i] });
      }
    }
    if (lost) {
      recordAnchorEvent(db, sessionUuid, { seq: now.length, seq_to: recorded.length - 1, kind: 'lost',
        recorded_hash: recorded[now.length] });
      if (first < 0) first = now.length;
    }
    if (differ || lost) {
      state = 'rewritten';
      const parts: string[] = [];
      if (differ === 1) parts.push(`leaf ${first} differs from what was recorded at ingest`);
      else if (differ) parts.push(`${differ} leaves differ from what was recorded at ingest (first at ${first})`);
      if (lost) parts.push(`file has ${now.length} hashed lines, witness recorded ${recorded.length}`);
      detail = parts.join('; ');
    } else {
      state = 'intact';
    }
  }
  db.prepare(
    `UPDATE session_chain SET anchor_state = ?, anchor_checked_at = datetime('now'), anchor_detail = ?
      WHERE session_uuid = ?`,
  ).run(state, detail, sessionUuid);
  return state;
}

/**
 * Sessions ingested before the witness existed have no leaves on record:
 * their offsets sit at end-of-file, so ingest never re-reads them. This
 * reads such a journal once from byte 0 — recording leaves only, never
 * re-inserting messages — so the whole history comes under the witness,
 * a bounded number per pass. The recorded leaves are then what the file
 * held at backfill time, which is as early as this witness can start.
 */
export function backfillWitness(
  db: Database.Database,
  limit: number,
  resolve: (project: string, sessionUuid: string) => string,
): number {
  const rows = db.prepare(
    `SELECT s.session_uuid, p.name AS project FROM sessions s
       JOIN projects p ON p.id = s.project_id
      WHERE NOT EXISTS (SELECT 1 FROM session_chain c WHERE c.session_uuid = s.session_uuid)
      ORDER BY s.id DESC LIMIT ?`,
  ).all(limit) as { session_uuid: string; project: string }[];
  let done = 0;
  // Where ingest actually read a session from — a fleet worker's journal
  // sits under its private home, where a path resolved from the project
  // name (the user's own home) does not exist. 850 fleet sessions were
  // recorded as missing that way on 2026-09-16 before this lookup.
  const seen = db.prepare(
    "SELECT file_path FROM ingest_offsets WHERE file_path LIKE ? ORDER BY last_ingested DESC LIMIT 1",
  );
  for (const r of rows) {
    let filePath: string;
    const known = seen.get(`%/${r.session_uuid}.jsonl`) as { file_path: string } | undefined;
    if (known) filePath = known.file_path;
    else { try { filePath = resolve(r.project, r.session_uuid); } catch { continue; } }
    if (!quiescent(filePath)) continue;          // still being written: not evidence yet
    let text: string | null = null;
    try { text = readFileSync(filePath, 'utf8'); } catch { text = null; }
    const tracker = new SessionChainTracker(db, r.session_uuid, { reset: true, filePath, headKnown: true });
    if (text !== null) {
      if (text.length && !text.endsWith('\n')) text = text.slice(0, text.lastIndexOf('\n') + 1);
      for (const line of text.split('\n')) if (line.trim()) tracker.feed(line);
    }
    // A missing file still gets a row, so the session is not retried every pass.
    db.transaction(() => { tracker.flush(); if (text === null) {
      db.prepare(`INSERT OR IGNORE INTO session_chain (session_uuid, state, file_path) VALUES (?, 'unchained', ?)`)
        .run(r.session_uuid, filePath);
    } })();
    done += 1;
  }
  return done;
}

/**
 * One bounded pass of anchor audits — the sessions least recently
 * checked first, never-checked ones ahead of all. Runs after every
 * ingest pass; `limit` keeps a 16,000-journal host from re-reading
 * everything each cycle.
 */
export function auditAnchors(
  db: Database.Database,
  limit = 25,
  // Injected rather than imported: session-paths pulls in the harness
  // path modules, and a static import here reaches them through
  // db-helper → migrate before a test file's own constants exist —
  // which is exactly what a hoisted vi.mock factory trips over.
  resolve?: (project: string, sessionUuid: string) => string,
): Record<AnchorState, number> {
  const out: Record<AnchorState, number> = { intact: 0, rewritten: 0, missing: 0 };
  // A row recorded before file_path existed still names its session and
  // project, which is enough to know where its journal lives.
  const unresolved = !resolve ? [] : db.prepare(
    `SELECT c.session_uuid, p.name AS project FROM session_chain c
       JOIN sessions s ON s.session_uuid = c.session_uuid
       JOIN projects p ON p.id = s.project_id
      WHERE c.file_path IS NULL AND c.entries > 0 LIMIT ?`,
  ).all(limit) as { session_uuid: string; project: string }[];
  for (const r of unresolved) {
    try {
      db.prepare('UPDATE session_chain SET file_path = ? WHERE session_uuid = ?')
        .run(resolve!(r.project, r.session_uuid), r.session_uuid);
    } catch { /* an adapter without a file layout: nothing to witness */ }
  }
  const rows = db.prepare(
    `SELECT session_uuid FROM session_chain
      WHERE file_path IS NOT NULL AND entries > 0
      ORDER BY anchor_checked_at IS NOT NULL, anchor_checked_at ASC
      LIMIT ?`,
  ).all(limit) as { session_uuid: string }[];
  for (const r of rows) {
    const s = auditAnchor(db, r.session_uuid);
    if (s) out[s] += 1;
  }
  return out;
}
