import type Database from 'better-sqlite3';
import { statSync } from 'fs';

/**
 * WAL ceiling. In WAL mode SQLite grows our -wal file to its high-water mark
 * and, by default, NEVER shrinks it back — a checkpoint makes our space
 * reusable but leaves our file at whatever size one big transaction needed.
 * `journal_size_limit` is what tells SQLite to truncate back down after a
 * checkpoint.
 *
 * Measured 2026-08-14: `~/.unfirehose/unfirehose.db` was 3.6G and its -wal was
 * ALSO 3.6G, doubling our footprint on a full disk. Our cause was our daily
 * VACUUM in apps/worker — VACUUM rewrites every page of our database, and in
 * WAL mode every one of those pages goes through our WAL, so one VACUUM sizes
 * our WAL to match our whole database. Without a limit that high-water mark is
 * permanent.
 *
 * 64MB is comfortably above our steady-state ingest transaction and far below
 * our database size, so normal writes never touch our ceiling and one outsized
 * transaction cannot leave a permanent scar.
 */
export const WAL_SIZE_LIMIT_BYTES = 64 * 1024 * 1024;

/**
 * Pragmas every unfirehose SQLite connection needs. Kept in one place because
 * this block was copy-pasted across schema/tenant/control and our two test
 * helpers, so a fix in one never reached our others — `journal_size_limit` was
 * missing from all five.
 */
export function applyBasePragmas(db: Database.Database): void {
  db.pragma('journal_mode = WAL');
  db.pragma('synchronous = NORMAL');
  db.pragma('foreign_keys = ON');
  db.pragma(`journal_size_limit = ${WAL_SIZE_LIMIT_BYTES}`);
}

export interface CheckpointResult {
  /** true when SQLite could not get our lock — other connections were reading. */
  busy: boolean;
  /** bytes our -wal file shrank by. Zero when it was already small. */
  reclaimedBytes: number;
  walBytesBefore: number;
  walBytesAfter: number;
}

/**
 * Fold our WAL back into our database and truncate our file.
 *
 * TRUNCATE is best-effort by design: it needs every other connection to be off
 * our WAL, and unfirehose runs web and worker as separate processes against one
 * file. A busy result is normal and not an error — `journal_size_limit` still
 * caps growth, so a missed checkpoint costs nothing but a later retry.
 *
 * We report bytes off our FILE rather than SQLite's page counters on purpose.
 * `wal_checkpoint(TRUNCATE)` returns `log=0, checkpointed=0` on SUCCESS — those
 * columns describe our resulting WAL, which truncation has just emptied, not
 * work performed. Verified against SQLite 2026-08-14: PASSIVE reported
 * `log=3, checkpointed=3` where TRUNCATE reported zeroes for the same write.
 * Logging those counters would print "0 pages" on every successful run.
 */
export function checkpointTruncate(db: Database.Database): CheckpointResult {
  const walPath = `${db.name}-wal`;
  const walSize = (): number => {
    try {
      return statSync(walPath).size;
    } catch {
      return 0; // no -wal file: nothing outstanding
    }
  };

  const before = walSize();
  const rows = db.pragma('wal_checkpoint(TRUNCATE)') as Array<{ busy: number }>;
  const busy = (rows?.[0]?.busy ?? 1) === 1;
  const after = walSize();

  return {
    busy,
    reclaimedBytes: Math.max(0, before - after),
    walBytesBefore: before,
    walBytesAfter: after,
  };
}

/**
 * Bytes sitting in our freelist — pages our database already owns but no longer
 * uses. This is what a VACUUM would actually reclaim, and it is the only honest
 * way to decide whether running one is worth its cost.
 */
export function freelistBytes(db: Database.Database): number {
  const { freelist_count } = db.prepare('PRAGMA freelist_count').get() as {
    freelist_count: number;
  };
  const { page_size } = db.prepare('PRAGMA page_size').get() as {
    page_size: number;
  };
  return freelist_count * page_size;
}
