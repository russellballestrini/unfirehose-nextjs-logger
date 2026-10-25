/**
 * How big our database is, what it is made of, and how fast it grows.
 *
 * Size by table comes from SQLite's `dbstat` virtual table, which
 * better-sqlite3 compiles in. It reads every page of the file, so on a
 * 7 GB database it is seconds of work: our worker records it once a day in
 * `db_size_snapshots` (one row per UTC day), and Settings reads the newest
 * row plus a handful of pragmas, never dbstat itself. Without dbstat the
 * snapshot carries row counts and the file's page total only.
 *
 * Growth per week is the slope of live bytes (pages in use, freelist left
 * out) across up to 28 days of snapshots, so a VACUUM, which changes the
 * file and not the data, does not read as shrinkage.
 */

import type Database from 'better-sqlite3';
import { statSync } from 'fs';
import { coldStats, recountColdStats, getRetentionDays, MIN_RETENTION_DAYS, RETENTION_CHOICES, type ColdStats } from './block-cold';
import { dbDiskSpace, diskLevel, LOW_DISK_BYTES, type DiskSpace, type DiskLevel } from './maintenance';

const DAY_MS = 86_400_000;
const GROWTH_WINDOW_DAYS = 28;

export interface TableSize {
  name: string;
  /** Bytes of the table's own b-tree; null without dbstat. */
  bytes: number | null;
  /** Bytes of every index on it; null without dbstat. */
  indexBytes: number | null;
  rows: number | null;
}

export interface SizeSnapshot {
  day: string;
  takenAt: string;
  dbBytes: number;
  freelistBytes: number;
  walBytes: number;
  method: 'dbstat' | 'pages';
  tables: TableSize[];
}

function pragmaNum(db: Database.Database, name: string): number {
  const row = db.prepare(`PRAGMA ${name}`).get() as Record<string, number>;
  return Number(row[name] ?? Object.values(row)[0] ?? 0);
}

function walBytes(db: Database.Database): number {
  if (!db.name || db.name === ':memory:') return 0;
  try { return statSync(`${db.name}-wal`).size; } catch { return 0; }
}

export function hasDbstat(db: Database.Database): boolean {
  try {
    db.prepare("SELECT 1 FROM dbstat WHERE name = 'sqlite_schema' LIMIT 1").get();
    return true;
  } catch {
    return false;
  }
}

/** Every table's size and rows, largest first. Heavy: reads the whole file when dbstat exists. */
export function measureTables(db: Database.Database): { method: 'dbstat' | 'pages'; tables: TableSize[] } {
  const objects = db.prepare(
    "SELECT name, type, tbl_name FROM sqlite_master WHERE type IN ('table', 'index')",
  ).all() as { name: string; type: string; tbl_name: string }[];
  // Automatic indexes (sqlite_autoindex_*) count toward their table; SQLite's own tables are left out.
  const tables = objects.filter((o) => o.type === 'table' && !o.name.startsWith('sqlite_'));
  const tableOf = new Map(objects.map((o) => [o.name, o.tbl_name]));

  const method = hasDbstat(db) ? 'dbstat' : 'pages';
  const own = new Map<string, number>();
  const idx = new Map<string, number>();
  if (method === 'dbstat') {
    const rows = db.prepare('SELECT name, pgsize FROM dbstat WHERE aggregate = TRUE').all() as { name: string; pgsize: number }[];
    for (const r of rows) {
      const t = tableOf.get(r.name);
      if (!t) continue;
      if (t === r.name) own.set(t, (own.get(t) ?? 0) + r.pgsize);
      else idx.set(t, (idx.get(t) ?? 0) + r.pgsize);
    }
  }

  const out: TableSize[] = tables.map((t) => {
    let rows: number | null = null;
    try { rows = (db.prepare(`SELECT COUNT(*) AS n FROM "${t.name.replace(/"/g, '""')}"`).get() as { n: number }).n; } catch { /* virtual */ }
    return {
      name: t.name,
      bytes: method === 'dbstat' ? own.get(t.name) ?? 0 : null,
      indexBytes: method === 'dbstat' ? idx.get(t.name) ?? 0 : null,
      rows,
    };
  });
  out.sort((a, b) => ((b.bytes ?? 0) + (b.indexBytes ?? 0)) - ((a.bytes ?? 0) + (a.indexBytes ?? 0)) || (b.rows ?? 0) - (a.rows ?? 0));
  return { method, tables: out };
}

const utcDay = (ms: number) => new Date(ms).toISOString().slice(0, 10);

/** True when today (UTC) has no snapshot yet. */
export function sizeSnapshotDue(db: Database.Database, now: number = Date.now()): boolean {
  return !db.prepare('SELECT 1 FROM db_size_snapshots WHERE day = ?').get(utcDay(now));
}

/** Measure and store today's snapshot, replacing one already taken today. Also re-totals our cold table exactly. */
export function recordSizeSnapshot(db: Database.Database, opts: { now?: number } = {}): SizeSnapshot {
  const now = opts.now ?? Date.now();
  const pageSize = pragmaNum(db, 'page_size');
  const { method, tables } = measureTables(db);
  const snap: SizeSnapshot = {
    day: utcDay(now),
    takenAt: new Date(now).toISOString(),
    dbBytes: pragmaNum(db, 'page_count') * pageSize,
    freelistBytes: pragmaNum(db, 'freelist_count') * pageSize,
    walBytes: walBytes(db),
    method,
    tables,
  };
  db.prepare(`
    INSERT INTO db_size_snapshots (day, taken_at, db_bytes, freelist_bytes, wal_bytes, method, tables_json)
    VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(day) DO UPDATE SET taken_at = excluded.taken_at, db_bytes = excluded.db_bytes,
      freelist_bytes = excluded.freelist_bytes, wal_bytes = excluded.wal_bytes,
      method = excluded.method, tables_json = excluded.tables_json
  `).run(snap.day, snap.takenAt, snap.dbBytes, snap.freelistBytes, snap.walBytes, snap.method, JSON.stringify(snap.tables));
  recountColdStats(db);
  return snap;
}

export interface HistoryPoint { day: string; dbBytes: number; liveBytes: number }

/**
 * Bytes per week of live data, the least-squares slope over the last
 * `GROWTH_WINDOW_DAYS`. Null until two snapshots at least a day apart exist.
 */
export function growthPerWeek(history: HistoryPoint[]): number | null {
  if (history.length < 2) return null;
  const end = Date.parse(history[history.length - 1].day);
  const pts = history.filter((h) => end - Date.parse(h.day) <= GROWTH_WINDOW_DAYS * DAY_MS);
  if (pts.length < 2) return null;
  const xs = pts.map((p) => (Date.parse(p.day) - end) / DAY_MS);
  if (Math.max(...xs) - Math.min(...xs) < 1) return null;
  const mx = xs.reduce((a, b) => a + b, 0) / xs.length;
  const my = pts.reduce((a, p) => a + p.liveBytes, 0) / pts.length;
  let num = 0, den = 0;
  pts.forEach((p, i) => { num += (xs[i] - mx) * (p.liveBytes - my); den += (xs[i] - mx) ** 2; });
  return den > 0 ? Math.round((num / den) * 7) : null;
}

export interface DbHealth {
  path: string;
  pageSize: number;
  dbBytes: number;
  freelistBytes: number;
  walBytes: number;
  disk: DiskSpace | null;
  diskLevel: DiskLevel;
  lowDiskBytes: number;
  dbstat: boolean;
  /** Newest snapshot, the source of size by table. Null before the worker's first one. */
  snapshot: SizeSnapshot | null;
  history: HistoryPoint[];
  growthPerWeekBytes: number | null;
  cold: ColdStats;
  retention: { days: number | null; choices: readonly number[]; minDays: number };
}

/** What Settings shows. Cheap: pragmas, a stat, and the snapshot table; never dbstat. */
export function getDbHealth(db: Database.Database, opts: { historyDays?: number } = {}): DbHealth {
  const pageSize = pragmaNum(db, 'page_size');
  const disk = dbDiskSpace(db);
  const rows = db.prepare(`
    SELECT day, taken_at, db_bytes, freelist_bytes, wal_bytes, method, tables_json
      FROM db_size_snapshots ORDER BY day DESC LIMIT ?
  `).all(opts.historyDays ?? 90) as Array<{ day: string; taken_at: string; db_bytes: number; freelist_bytes: number; wal_bytes: number; method: 'dbstat' | 'pages'; tables_json: string | null }>;
  const history = rows.map((r) => ({ day: r.day, dbBytes: r.db_bytes, liveBytes: r.db_bytes - r.freelist_bytes })).reverse();
  const newest = rows[0];
  let tables: TableSize[] = [];
  try { tables = newest?.tables_json ? JSON.parse(newest.tables_json) : []; } catch { tables = []; }

  return {
    path: db.name,
    pageSize,
    dbBytes: pragmaNum(db, 'page_count') * pageSize,
    freelistBytes: pragmaNum(db, 'freelist_count') * pageSize,
    walBytes: walBytes(db),
    disk,
    diskLevel: diskLevel(disk?.freeBytes),
    lowDiskBytes: LOW_DISK_BYTES,
    dbstat: hasDbstat(db),
    snapshot: newest ? {
      day: newest.day, takenAt: newest.taken_at, dbBytes: newest.db_bytes, freelistBytes: newest.freelist_bytes,
      walBytes: newest.wal_bytes, method: newest.method, tables,
    } : null,
    history,
    growthPerWeekBytes: growthPerWeek(history),
    cold: coldStats(db),
    retention: { days: getRetentionDays(db), choices: RETENTION_CHOICES, minDays: MIN_RETENTION_DAYS },
  };
}
