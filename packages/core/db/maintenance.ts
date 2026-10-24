/**
 * Database upkeep shared by our worker and `make vacuum`: when it is quiet
 * enough to do heavy work, whether a VACUUM is worth what it costs, whether
 * the disk can take one, and who else has the file open.
 *
 * One copy of each rule. The worker's daily VACUUM used to carry its
 * threshold and its checkpoint inline; `make vacuum` would have been a
 * second copy that drifted from the first.
 */

import type Database from 'better-sqlite3';
import { readdirSync, readlinkSync, statSync, statfsSync, existsSync } from 'fs';
import path from 'path';
import { checkpointTruncate, freelistBytes, type CheckpointResult } from './pragmas';
import { UNFIREHOSE_DIR } from './data-dir';

export const GiB = 1024 ** 3;
const MiB = 1024 ** 2;

/**
 * Below this much free space under our database, doctor and the first-run
 * wizard warn. 7 GB on fox's box after a year, and a VACUUM needs room for
 * a second copy, so 10 GB is a few months of runway, not a crisis line.
 */
export const LOW_DISK_BYTES = 10 * GiB;
/** Under this SQLite is close to failing writes. */
export const CRITICAL_DISK_BYTES = 1 * GiB;

/**
 * Below this much reclaimable space a VACUUM costs far more than it returns:
 * it rewrites every page through our WAL, so a no-op VACUUM on a 3.6G
 * database bought ~0 bytes and left a 3.6G WAL behind (2026-08-14).
 */
export const VACUUM_MIN_FREELIST_BYTES = 256 * MiB;

// ---------------------------------------------------------------- idle

/** Quiet this long before a VACUUM: it holds our write lock for minutes on a large file. */
export const VACUUM_QUIET_MS = 15 * 60_000;
/** Quiet this long before a cold-storage batch: each holds the lock for milliseconds. */
export const COLD_MOVE_QUIET_MS = 2 * 60_000;

export interface IngestState {
  /** A full ingest pass is running right now. */
  inFlight: boolean;
  /** Epoch ms when a pass last read new bytes (core's ingestActivityAt()). 0 = never. */
  lastActivityAt: number;
  now?: number;
}

/**
 * Idle, for upkeep: no ingest in flight, and none has read new bytes for
 * `quietMs`. Says why not, so a skipped run can log a reason.
 */
export function ingestIdle(s: IngestState, quietMs: number): { idle: boolean; reason: string } {
  if (s.inFlight) return { idle: false, reason: 'ingest in flight' };
  const now = s.now ?? Date.now();
  const quietFor = now - s.lastActivityAt;
  if (s.lastActivityAt > 0 && quietFor < quietMs) {
    return { idle: false, reason: `ingest read new bytes ${Math.round(quietFor / 1000)}s ago (want ${Math.round(quietMs / 1000)}s quiet)` };
  }
  return { idle: true, reason: 'quiet' };
}

// ---------------------------------------------------------------- disk

export interface DiskSpace {
  path: string;
  freeBytes: number;
  totalBytes: number;
}

function nearestExisting(p: string): string {
  let cur = path.resolve(p);
  while (!existsSync(cur)) {
    const up = path.dirname(cur);
    if (up === cur) break;
    cur = up;
  }
  return cur;
}

/** Free space on the filesystem that holds `file` (or its nearest existing parent). Null when unreadable. */
export function diskSpaceAt(file: string): DiskSpace | null {
  const at = nearestExisting(path.dirname(file));
  try {
    const s = statfsSync(at);
    return { path: at, freeBytes: Number(s.bavail) * Number(s.bsize), totalBytes: Number(s.blocks) * Number(s.bsize) };
  } catch {
    return null;
  }
}

/**
 * Free space under our database file. An in-memory handle (tests, a
 * scratch db) has no file, so it answers for where our database would
 * live: `UNFIREHOSE_DB_PATH`, else our data dir.
 */
export function dbDiskSpace(db: Database.Database): DiskSpace | null {
  const file = db.name && db.name !== ':memory:'
    ? db.name
    : process.env.UNFIREHOSE_DB_PATH || path.join(UNFIREHOSE_DIR, 'unfirehose.db');
  return diskSpaceAt(file);
}

export type DiskLevel = 'ok' | 'low' | 'critical' | 'unknown';

export function diskLevel(freeBytes: number | null | undefined): DiskLevel {
  if (freeBytes == null) return 'unknown';
  if (freeBytes < CRITICAL_DISK_BYTES) return 'critical';
  if (freeBytes < LOW_DISK_BYTES) return 'low';
  return 'ok';
}

function fileSize(p: string): number {
  try { return statSync(p).size; } catch { return 0; }
}

// ---------------------------------------------------------------- holders

/**
 * Other processes with `file` (or its -wal / -shm) open, read from
 * /proc/<pid>/fd. Linux only; elsewhere, and for processes we may not
 * inspect, it returns what it can see, which may be nothing.
 */
export function processesHoldingFile(file: string, opts: { procRoot?: string; selfPid?: number } = {}): number[] {
  const procRoot = opts.procRoot ?? '/proc';
  const self = opts.selfPid ?? process.pid;
  const targets = new Set([file, `${file}-wal`, `${file}-shm`].map((p) => path.resolve(p)));
  const pids: number[] = [];
  let entries: string[];
  try { entries = readdirSync(procRoot); } catch { return []; }
  for (const e of entries) {
    const pid = Number(e);
    if (!Number.isInteger(pid) || pid === self) continue;
    let fds: string[];
    try { fds = readdirSync(path.join(procRoot, e, 'fd')); } catch { continue; }
    for (const fd of fds) {
      let link: string;
      try { link = readlinkSync(path.join(procRoot, e, 'fd', fd)); } catch { continue; }
      if (targets.has(link)) { pids.push(pid); break; }
    }
  }
  return pids.sort((a, b) => a - b);
}

// ---------------------------------------------------------------- vacuum

export interface VacuumPlan {
  run: boolean;
  reason: string;
  freelistBytes: number;
  dbBytes: number;
  walBytes: number;
  disk: DiskSpace | null;
}

/**
 * Should a VACUUM run now? Two gates: there is enough on our freelist to be
 * worth a rewrite (`minFreelistBytes`, 0 to skip), and the disk can take
 * one. A VACUUM builds a fresh copy and in WAL mode writes every live page
 * through our -wal, so it needs about our live size free again.
 */
export function planVacuum(db: Database.Database, opts: { minFreelistBytes?: number } = {}): VacuumPlan {
  const min = opts.minFreelistBytes ?? VACUUM_MIN_FREELIST_BYTES;
  const reclaimable = freelistBytes(db);
  const { page_count } = db.prepare('PRAGMA page_count').get() as { page_count: number };
  const { page_size } = db.prepare('PRAGMA page_size').get() as { page_size: number };
  const dbBytes = page_count * page_size;
  const onDisk = db.name && db.name !== ':memory:';
  const walBytes = onDisk ? fileSize(`${db.name}-wal`) : 0;
  const disk = onDisk ? diskSpaceAt(db.name) : null;
  const base = { freelistBytes: reclaimable, dbBytes, walBytes, disk };
  const mb = (b: number) => `${(b / MiB).toFixed(1)}MB`;

  if (reclaimable < min) {
    return { ...base, run: false, reason: `freelist ${mb(reclaimable)} below ${mb(min)} threshold` };
  }
  const needed = dbBytes - reclaimable + 256 * MiB;
  if (disk && disk.freeBytes < needed) {
    return { ...base, run: false, reason: `only ${mb(disk.freeBytes)} free at ${disk.path}; a VACUUM needs about ${mb(needed)}` };
  }
  return { ...base, run: true, reason: `freelist ${mb(reclaimable)} reclaimable` };
}

export interface VacuumResult {
  ran: boolean;
  reason: string;
  ms: number;
  dbBytesBefore: number;
  dbBytesAfter: number;
  checkpoint: CheckpointResult | null;
}

/**
 * Checkpoint, VACUUM if `planVacuum` says so, then checkpoint again: the
 * VACUUM just pushed our whole database through our WAL, so fold it back
 * now rather than leaving the file at its high-water mark until the next
 * hourly tick.
 */
export function vacuumIfWorthIt(db: Database.Database, opts: { minFreelistBytes?: number } = {}): VacuumResult {
  checkpointTruncate(db);
  const plan = planVacuum(db, opts);
  if (!plan.run) {
    return { ran: false, reason: plan.reason, ms: 0, dbBytesBefore: plan.dbBytes, dbBytesAfter: plan.dbBytes, checkpoint: null };
  }
  const t0 = Date.now();
  db.exec('VACUUM');
  const ms = Date.now() - t0;
  const checkpoint = checkpointTruncate(db);
  const { page_count } = db.prepare('PRAGMA page_count').get() as { page_count: number };
  const { page_size } = db.prepare('PRAGMA page_size').get() as { page_size: number };
  return { ran: true, reason: plan.reason, ms, dbBytesBefore: plan.dbBytes, dbBytesAfter: page_count * page_size, checkpoint };
}
