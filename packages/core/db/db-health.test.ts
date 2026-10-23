import { describe, it, expect } from 'vitest';
import { createTestDb, seedProject, seedSession, seedMessage } from '../test/db-helper';
import { getDbHealth, recordSizeSnapshot, sizeSnapshotDue, growthPerWeek, measureTables, hasDbstat } from './db-health';
import { setRetentionDays } from './block-cold';

const NOW = Date.parse('2026-10-23T12:00:00Z');
const GB = 1024 ** 3;

describe('measureTables', () => {
  it('sizes every table with dbstat, indexes folded into their table', () => {
    const db = createTestDb();
    expect(hasDbstat(db)).toBe(true);
    const s = seedSession(db, seedProject(db));
    for (let i = 0; i < 50; i++) seedMessage(db, s, { uuid: `u${i}` });
    const { method, tables } = measureTables(db);
    expect(method).toBe('dbstat');
    const messages = tables.find((t) => t.name === 'messages')!;
    expect(messages.rows).toBe(50);
    expect(messages.bytes).toBeGreaterThan(0);
    expect(messages.indexBytes).toBeGreaterThan(0);
    expect(tables.some((t) => t.name.startsWith('sqlite_'))).toBe(false);
    expect(tables.find((t) => t.name === 'content_blocks_cold')).toBeTruthy();
  });
});

describe('snapshots', () => {
  it('records one row per UTC day and says when one is due', () => {
    const db = createTestDb();
    expect(sizeSnapshotDue(db, NOW)).toBe(true);
    const snap = recordSizeSnapshot(db, { now: NOW });
    expect(snap.day).toBe('2026-10-23');
    expect(snap.dbBytes).toBeGreaterThan(0);
    expect(sizeSnapshotDue(db, NOW)).toBe(false);
    recordSizeSnapshot(db, { now: NOW + 1000 });
    expect((db.prepare('SELECT COUNT(*) AS n FROM db_size_snapshots').get() as { n: number }).n).toBe(1);
    expect(sizeSnapshotDue(db, NOW + 86_400_000)).toBe(true);
  });

  it('reports health from the newest snapshot without running dbstat', () => {
    const db = createTestDb();
    setRetentionDays(db, 90);
    expect(getDbHealth(db).snapshot).toBeNull();
    recordSizeSnapshot(db, { now: NOW });
    const h = getDbHealth(db);
    expect(h.snapshot?.tables.length).toBeGreaterThan(10);
    expect(h.retention).toMatchObject({ days: 90, minDays: 30 });
    expect(h.cold).toEqual({ blocks: 0, rawBytes: 0, storedBytes: 0 });
    expect(h.history).toHaveLength(1);
    expect(h.growthPerWeekBytes).toBeNull();
    // In memory: answered for where our database would live.
    expect(h.disk?.freeBytes).toBeGreaterThan(0);
    expect(['ok', 'low', 'critical']).toContain(h.diskLevel);
  });
});

describe('growthPerWeek', () => {
  const pt = (day: string, liveGb: number) => ({ day, dbBytes: liveGb * GB, liveBytes: liveGb * GB });
  it('is null until two days of history exist', () => {
    expect(growthPerWeek([])).toBeNull();
    expect(growthPerWeek([pt('2026-10-23', 7)])).toBeNull();
  });
  it('is the slope of live bytes, per week', () => {
    const h = [pt('2026-10-09', 6), pt('2026-10-16', 6.5), pt('2026-10-23', 7)];
    expect(growthPerWeek(h)).toBe(Math.round(0.5 * GB));
  });
  it('looks back 28 days only', () => {
    const h = [pt('2026-01-01', 1), pt('2026-10-16', 7), pt('2026-10-23', 7)];
    expect(growthPerWeek(h)).toBe(0);
  });
});
