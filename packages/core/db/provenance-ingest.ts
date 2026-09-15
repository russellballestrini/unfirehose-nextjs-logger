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
import { ChainState, emptyChainState, type ChainStateData, type ChainVerdict } from '../provenance';

export interface SessionChainRow extends ChainStateData {
  session_uuid: string;
  state: ChainVerdict;
  updated_at: string;
}

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
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS session_chain_leaves (
      session_uuid TEXT NOT NULL,
      seq INTEGER NOT NULL,                      -- position among HASHED lines
      hash TEXT NOT NULL,
      PRIMARY KEY (session_uuid, seq)
    );
    CREATE INDEX IF NOT EXISTS idx_session_chain_state ON session_chain(state);
  `);
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
  private readonly pendingLeaves: [number, string][] = [];
  private leafCount: number;

  /**
   * `reset` when the caller is reading the file from byte 0 (a first
   * pass, or an offset that was reset): prior state is a different
   * reading of the same bytes. The cloud path, which receives batches
   * with no offset, always continues.
   */
  constructor(
    private readonly db: Database.Database,
    private readonly sessionUuid: string,
    opts: { reset: boolean } = { reset: false },
  ) {
    const existing = opts.reset ? null : getSessionChain(db, sessionUuid);
    if (existing) {
      const { session_uuid: _u, state: _s, updated_at: _t, ...data } = existing;
      const leaves = (db
        .prepare('SELECT hash FROM session_chain_leaves WHERE session_uuid = ? ORDER BY seq')
        .all(sessionUuid) as { hash: string }[]).map((r) => r.hash);
      this.state = new ChainState({ ...emptyChainState(), ...data }, leaves);
      this.leafCount = leaves.length;
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
    if (hash !== null) this.pendingLeaves.push([this.leafCount++, hash]);
    return hash;
  }

  get verdict(): ChainVerdict {
    return this.state.verdict;
  }

  /** Persist state and new leaves. Runs inside the caller's transaction when there is one. */
  flush() {
    const d = this.state.data;
    if (d.entries === 0 && this.pendingLeaves.length === 0) return;
    db_upsert(this.db, this.sessionUuid, this.state.verdict, d);
    const ins = this.db.prepare(
      'INSERT OR REPLACE INTO session_chain_leaves (session_uuid, seq, hash) VALUES (?, ?, ?)',
    );
    for (const [seq, hash] of this.pendingLeaves.splice(0)) ins.run(this.sessionUuid, seq, hash);
  }
}

function db_upsert(db: Database.Database, uuid: string, state: ChainVerdict, d: ChainStateData) {
  db.prepare(
    `INSERT INTO session_chain (
       session_uuid, state, entries, hashed, breaks, first_break, first_break_reason,
       last_hash, root_expected, root_computed, root_seq, hash_version, updated_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
     ON CONFLICT(session_uuid) DO UPDATE SET
       state = excluded.state, entries = excluded.entries, hashed = excluded.hashed,
       breaks = excluded.breaks, first_break = excluded.first_break,
       first_break_reason = excluded.first_break_reason, last_hash = excluded.last_hash,
       root_expected = excluded.root_expected, root_computed = excluded.root_computed,
       root_seq = excluded.root_seq, hash_version = excluded.hash_version,
       updated_at = excluded.updated_at`,
  ).run(
    uuid, state, d.entries, d.hashed, d.breaks, d.first_break, d.first_break_reason,
    d.last_hash, d.root_expected, d.root_computed, d.root_seq, d.hash_version,
  );
}
