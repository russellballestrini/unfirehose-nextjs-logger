import { NextResponse } from 'next/server';
import { getDb, UNFIREHOSE_DIR } from '@unturf/unfirehose/db/schema';
import { statSync } from 'fs';
import { join } from 'path';

/* eslint-disable @typescript-eslint/no-explicit-any */

export const dynamic = 'force-dynamic';

function fmtBytes(n: number): string {
  if (n >= 1073741824) return `${(n / 1073741824).toFixed(2)} GB`;
  if (n >= 1048576) return `${(n / 1048576).toFixed(2)} MB`;
  if (n >= 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${n} B`;
}

export async function GET() {
  try {
    const db = getDb();

    // Overall DB pragmas
    const pageSize: number = (db.prepare('PRAGMA page_size').get() as any).page_size;
    const pageCount: number = (db.prepare('PRAGMA page_count').get() as any).page_count;
    const freelistCount: number = (db.prepare('PRAGMA freelist_count').get() as any).freelist_count;
    const cacheSize: number = (db.prepare('PRAGMA cache_size').get() as any).cache_size;
    const journalMode: string = (db.prepare('PRAGMA journal_mode').get() as any).journal_mode;
    const walCheckpoint = journalMode === 'wal'
      ? db.prepare('PRAGMA wal_checkpoint').get() as any
      : null;

    const totalBytes = pageSize * pageCount;
    const usedBytes = pageSize * (pageCount - freelistCount);
    const freeBytes = pageSize * freelistCount;

    // File size on disk
    let fileSize: number | null = null;
    try {
      fileSize = statSync(join(UNFIREHOSE_DIR, 'unfirehose.db')).size;
    } catch { /* ok */ }

    // All tables and indexes from sqlite_master
    const objects = db.prepare(
      `SELECT name, type, tbl_name, sql FROM sqlite_master WHERE type IN ('table','index') ORDER BY type, name`
    ).all() as { name: string; type: string; tbl_name: string; sql: string | null }[];

    // dbstat: per-table/index page and payload info
    const dbstatRows = db.prepare(
      `SELECT name, sum(payload) as payload, sum(pgsize) as pgsize, count(*) as pages FROM dbstat GROUP BY name`
    ).all() as { name: string; payload: number; pgsize: number; pages: number }[];
    const statByName = Object.fromEntries(dbstatRows.map(r => [r.name, r]));

    // Row counts per table
    const tables = objects.filter(o => o.type === 'table');
    const tableStats = tables.map(t => {
      let rowCount: number | null = null;
      try {
        rowCount = (db.prepare(`SELECT COUNT(*) as n FROM "${t.name}"`).get() as any).n;
      } catch { /* virtual or system table */ }
      const stat = statByName[t.name];
      return {
        name: t.name,
        rowCount,
        pages: stat?.pages ?? null,
        payloadBytes: stat?.payload ?? null,
        totalBytes: stat?.pgsize ?? null,
      };
    });

    const indexes = objects.filter(o => o.type === 'index');
    const indexStats = indexes.map(i => {
      const stat = statByName[i.name];
      return {
        name: i.name,
        table: i.tbl_name,
        auto: i.sql === null, // auto-created by UNIQUE/PK constraint
        pages: stat?.pages ?? null,
        payloadBytes: stat?.payload ?? null,
        totalBytes: stat?.pgsize ?? null,
      };
    });

    return NextResponse.json({
      pageSize,
      pageCount,
      freelistCount,
      cacheSize,
      journalMode,
      walCheckpoint,
      totalBytes,
      usedBytes,
      freeBytes,
      fileSize,
      // formatted
      totalBytesHuman: fmtBytes(totalBytes),
      usedBytesHuman: fmtBytes(usedBytes),
      freeBytesHuman: fmtBytes(freeBytes),
      fileSizeHuman: fileSize !== null ? fmtBytes(fileSize) : null,
      tables: tableStats.sort((a, b) => (b.totalBytes ?? 0) - (a.totalBytes ?? 0)),
      indexes: indexStats.sort((a, b) => (b.totalBytes ?? 0) - (a.totalBytes ?? 0)),
    });
  } catch (err: any) {
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}
