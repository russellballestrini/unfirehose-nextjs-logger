import { describe, it, expect, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { mkdtempSync, mkdirSync, symlinkSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import { applyBasePragmas } from './pragmas';
import { migrate } from './migrate';
import {
  ingestIdle, diskLevel, LOW_DISK_BYTES, CRITICAL_DISK_BYTES, GiB, diskSpaceAt,
  processesHoldingFile, planVacuum, vacuumIfWorthIt,
} from './maintenance';

const dirs: string[] = [];
const scratch = () => { const d = mkdtempSync(path.join(tmpdir(), 'ufh-maint-')); dirs.push(d); return d; };
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

describe('ingestIdle', () => {
  const now = 1_000_000_000;
  it('is busy while a pass runs', () => {
    expect(ingestIdle({ inFlight: true, lastActivityAt: 0, now }, 60_000).idle).toBe(false);
  });
  it('waits out the quiet period after new bytes', () => {
    const r = ingestIdle({ inFlight: false, lastActivityAt: now - 30_000, now }, 60_000);
    expect(r.idle).toBe(false);
    expect(r.reason).toContain('30s ago');
    expect(ingestIdle({ inFlight: false, lastActivityAt: now - 61_000, now }, 60_000).idle).toBe(true);
  });
  it('counts a worker that has read nothing yet as quiet', () => {
    expect(ingestIdle({ inFlight: false, lastActivityAt: 0, now }, 60_000).idle).toBe(true);
  });
});

describe('disk', () => {
  it('levels: critical under 1 GiB, low under 10 GiB', () => {
    expect(LOW_DISK_BYTES).toBe(10 * GiB);
    expect(diskLevel(0.5 * GiB)).toBe('critical');
    expect(diskLevel(CRITICAL_DISK_BYTES)).toBe('low');
    expect(diskLevel(9.9 * GiB)).toBe('low');
    expect(diskLevel(10 * GiB)).toBe('ok');
    expect(diskLevel(null)).toBe('unknown');
  });
  it('reads free space under a path that does not exist yet', () => {
    const d = scratch();
    const s = diskSpaceAt(path.join(d, 'not', 'yet', 'unfirehose.db'));
    expect(s?.path).toBe(d);
    expect(s!.freeBytes).toBeGreaterThan(0);
    expect(s!.totalBytes).toBeGreaterThanOrEqual(s!.freeBytes);
  });
});

describe('processesHoldingFile', () => {
  it('finds pids whose fds point at the db, its -wal or -shm, and leaves itself out', () => {
    const proc = scratch();
    const db = '/data/unfirehose.db';
    const fake = (pid: number, targets: string[]) => {
      mkdirSync(path.join(proc, String(pid), 'fd'), { recursive: true });
      targets.forEach((t, i) => symlinkSync(t, path.join(proc, String(pid), 'fd', String(i))));
    };
    fake(100, ['/dev/null', db]);
    fake(200, [`${db}-wal`]);
    fake(300, ['/data/other.db']);
    fake(400, [db]);
    mkdirSync(path.join(proc, 'self'));
    expect(processesHoldingFile(db, { procRoot: proc, selfPid: 400 })).toEqual([100, 200]);
  });
  it('returns nothing without a /proc', () => {
    expect(processesHoldingFile('/x.db', { procRoot: '/definitely/not/here' })).toEqual([]);
  });
});

describe('vacuum', () => {
  function fileDb() {
    const file = path.join(scratch(), 'v.db');
    const db = new Database(file);
    applyBasePragmas(db);
    migrate(db);
    return db;
  }

  it('skips when the freelist is under the threshold', () => {
    const db = fileDb();
    const r = vacuumIfWorthIt(db);
    expect(r.ran).toBe(false);
    expect(r.reason).toContain('below');
    db.close();
  });

  it('reclaims a freelist and folds the WAL back', () => {
    const db = fileDb();
    db.exec('CREATE TABLE junk (b BLOB)');
    const ins = db.prepare('INSERT INTO junk VALUES (randomblob(4096))');
    db.transaction(() => { for (let i = 0; i < 500; i++) ins.run(); })();
    db.exec('DELETE FROM junk');
    db.pragma('wal_checkpoint(TRUNCATE)');
    expect(planVacuum(db, { minFreelistBytes: 0 }).freelistBytes).toBeGreaterThan(1_000_000);
    const r = vacuumIfWorthIt(db, { minFreelistBytes: 1 });
    expect(r.ran).toBe(true);
    expect(r.dbBytesAfter).toBeLessThan(r.dbBytesBefore);
    expect(r.checkpoint?.busy).toBe(false);
    expect(planVacuum(db, { minFreelistBytes: 0 }).freelistBytes).toBe(0);
    db.close();
  });

  it('reports an in-memory database without a disk', () => {
    const db = new Database(':memory:');
    expect(planVacuum(db, { minFreelistBytes: 0 }).disk).toBeNull();
    db.close();
  });
});
