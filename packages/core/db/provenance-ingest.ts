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
import { readFileSync } from 'fs';
import { ChainState, emptyChainState, witnessHash, type ChainStateData, type ChainVerdict } from '../provenance';

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
  `);
  // A database created before the rule columns were named.
  for (const col of ['merkle_version', 'encoding_version', 'root_semantics',
    'file_path', 'anchor_state', 'anchor_checked_at', 'anchor_detail']) {
    try { db.exec(`ALTER TABLE session_chain ADD COLUMN ${col} TEXT`); } catch { /* exists */ }
  }
  try { db.exec("ALTER TABLE session_chain_leaves ADD COLUMN kind TEXT NOT NULL DEFAULT 'chain'"); } catch { /* exists */ }
}

/** Read a session's chain row, or null when nothing has been verified for it. */
export function getSessionChain(db: Database.Database, sessionUuid: string): SessionChainRow | null {
  const row = db.prepare('SELECT * FROM session_chain WHERE session_uuid = ?').get(sessionUuid) as
    | SessionChainRow
    | undefined;
  return row ?? null;
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

  constructor(
    private readonly db: Database.Database,
    private readonly sessionUuid: string,
    opts: { reset: boolean; filePath?: string } = { reset: false },
  ) {
    this.filePath = opts.filePath ?? null;
    const existing = opts.reset ? null : getSessionChain(db, sessionUuid);
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
    if (d.entries === 0 && this.pendingLeaves.length === 0) return;
    db_upsert(this.db, this.sessionUuid, this.state.verdict, d, this.filePath);
    const ins = this.db.prepare(
      'INSERT OR REPLACE INTO session_chain_leaves (session_uuid, seq, hash, kind) VALUES (?, ?, ?, ?)',
    );
    for (const [seq, hash, kind] of this.pendingLeaves.splice(0)) ins.run(this.sessionUuid, seq, hash, kind);
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
export function auditAnchor(db: Database.Database, sessionUuid: string): AnchorState | null {
  const row = getSessionChain(db, sessionUuid);
  if (!row || !row.file_path || row.entries === 0) return null;
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
    let diverged = -1;
    for (let i = 0; i < recorded.length; i++) {
      if (now[i] !== recorded[i]) { diverged = i; break; }
    }
    if (diverged >= 0) {
      state = 'rewritten';
      detail = now.length < recorded.length && diverged >= now.length
        ? `file has ${now.length} hashed lines, witness recorded ${recorded.length}`
        : `leaf ${diverged} differs from what was recorded at ingest`;
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
