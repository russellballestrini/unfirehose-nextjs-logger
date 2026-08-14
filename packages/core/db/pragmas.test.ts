import { describe, it, expect, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { mkdtempSync, rmSync, statSync, existsSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import {
  applyBasePragmas,
  checkpointTruncate,
  freelistBytes,
  WAL_SIZE_LIMIT_BYTES,
} from './pragmas';

const dirs: string[] = [];

function freshDb() {
  const dir = mkdtempSync(path.join(tmpdir(), 'unfirehose-pragmas-'));
  dirs.push(dir);
  const dbPath = path.join(dir, 'test.db');
  const db = new Database(dbPath);
  applyBasePragmas(db);
  return { db, dbPath };
}

afterEach(() => {
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});

describe('applyBasePragmas', () => {
  it('puts the database in WAL mode', () => {
    const { db } = freshDb();
    expect(db.pragma('journal_mode', { simple: true })).toBe('wal');
    db.close();
  });

  it('sets journal_size_limit — without it a WAL never shrinks back', () => {
    const { db } = freshDb();
    expect(db.pragma('journal_size_limit', { simple: true })).toBe(WAL_SIZE_LIMIT_BYTES);
    db.close();
  });

  it('keeps foreign keys on', () => {
    const { db } = freshDb();
    expect(db.pragma('foreign_keys', { simple: true })).toBe(1);
    db.close();
  });
});

describe('checkpointTruncate', () => {
  it('truncates the -wal file back to nothing after a large write', () => {
    const { db, dbPath } = freshDb();
    db.exec('CREATE TABLE t (id INTEGER PRIMARY KEY, blob TEXT)');
    const insert = db.prepare('INSERT INTO t (blob) VALUES (?)');
    const payload = 'x'.repeat(4096);
    const many = db.transaction(() => {
      for (let i = 0; i < 2000; i++) insert.run(payload);
    });
    many();

    const walPath = `${dbPath}-wal`;
    expect(existsSync(walPath)).toBe(true);
    const grown = statSync(walPath).size;
    expect(grown).toBeGreaterThan(0);

    const result = checkpointTruncate(db);
    expect(result.busy).toBe(false);

    // The point of TRUNCATE: the file itself shrinks, not just its reusable
    // space. A plain PASSIVE checkpoint would leave `grown` bytes on disk.
    const after = existsSync(walPath) ? statSync(walPath).size : 0;
    expect(after).toBeLessThan(grown);
    expect(after).toBe(0);

    // And we report that shrinkage, so a log line reflects real work.
    expect(result.walBytesBefore).toBe(grown);
    expect(result.walBytesAfter).toBe(0);
    expect(result.reclaimedBytes).toBe(grown);
    db.close();
  });

  // Regression: TRUNCATE returns log=0/checkpointed=0 on SUCCESS, because those
  // columns describe the resulting (now empty) WAL rather than work done.
  // Reporting them would print "0 pages" on every successful checkpoint, so
  // reclaimedBytes must come from the file, not from SQLite's counters.
  it('reports real bytes even though SQLite zeroes its page counters', () => {
    const { db } = freshDb();
    db.exec('CREATE TABLE t (id INTEGER PRIMARY KEY)');
    db.exec('INSERT INTO t (id) VALUES (1)');

    const raw = db.pragma('wal_checkpoint(PASSIVE)') as Array<{ checkpointed: number }>;
    expect(raw[0].checkpointed).toBeGreaterThan(0); // PASSIVE does report pages

    db.exec('INSERT INTO t (id) VALUES (2)');
    const result = checkpointTruncate(db);
    expect(result.busy).toBe(false);
    expect(result.walBytesBefore).toBeGreaterThan(0);
    expect(result.reclaimedBytes).toBeGreaterThan(0);
    db.close();
  });
});

describe('freelistBytes', () => {
  it('is ~zero on a fresh database', () => {
    const { db } = freshDb();
    db.exec('CREATE TABLE t (id INTEGER PRIMARY KEY)');
    expect(freelistBytes(db)).toBe(0);
    db.close();
  });

  it('grows after a delete, which is what makes a VACUUM worth running', () => {
    const { db } = freshDb();
    db.exec('CREATE TABLE t (id INTEGER PRIMARY KEY, blob TEXT)');
    const insert = db.prepare('INSERT INTO t (blob) VALUES (?)');
    const payload = 'y'.repeat(4096);
    db.transaction(() => {
      for (let i = 0; i < 2000; i++) insert.run(payload);
    })();

    expect(freelistBytes(db)).toBe(0);
    db.exec('DELETE FROM t');
    expect(freelistBytes(db)).toBeGreaterThan(0);

    // And a VACUUM is what returns those pages to the filesystem.
    db.exec('VACUUM');
    expect(freelistBytes(db)).toBe(0);
    db.close();
  });
});
