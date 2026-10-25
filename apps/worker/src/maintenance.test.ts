import { describe, it, expect, beforeEach } from 'vitest';
import type Database from 'better-sqlite3';
import { createTestDb, seedProject, seedSession, seedMessage } from '@unturf/unfirehose/test/db-helper';
import { setRetentionDays } from '@unturf/unfirehose/db/block-cold';
import { maintenanceTick, describeTick, VACUUM_INTERVAL_MS, VACUUM_FIRST_CHECK_MS, LAST_VACUUM_KEY } from './maintenance';

const NOW = Date.parse('2026-10-23T03:00:00Z');
const MIN = 60_000;
const DAY = 86_400_000;
const quiet = { inFlight: false, lastActivityAt: NOW - 60 * MIN };

let db: Database.Database;
beforeEach(() => {
  db = createTestDb();
  const s = seedSession(db, seedProject(db));
  for (let i = 0; i < 30; i++) {
    const m = seedMessage(db, s, { timestamp: new Date(NOW - (120 + i) * DAY).toISOString() });
    db.prepare("INSERT INTO content_blocks (message_id, position, block_type, text_content) VALUES (?, 0, 'text', ?)").run(m, `old ${i} `.repeat(60));
  }
});

const cold = () => (db.prepare('SELECT COUNT(*) AS n FROM content_blocks WHERE cold = 1').get() as { n: number }).n;

describe('maintenanceTick', () => {
  it('does nothing while ingest is busy or freshly active', () => {
    setRetentionDays(db, 90);
    expect(maintenanceTick(db, { inFlight: true, lastActivityAt: 0 }, { now: NOW }).skipped[0]).toContain('in flight');
    expect(maintenanceTick(db, { inFlight: false, lastActivityAt: NOW - 30_000 }, { now: NOW }).skipped[0]).toContain('30s ago');
    expect(cold()).toBe(0);
    expect((db.prepare('SELECT COUNT(*) AS n FROM db_size_snapshots').get() as { n: number }).n).toBe(0);
  });

  it('when quiet: snapshots today once, and with no window moves nothing', () => {
    const r = maintenanceTick(db, quiet, { now: NOW, bootAt: NOW });
    expect(r.snapshot?.dbBytes).toBeGreaterThan(0);
    expect(r.cold).toBeUndefined();
    expect(cold()).toBe(0);
    expect(maintenanceTick(db, quiet, { now: NOW + MIN, bootAt: NOW }).snapshot).toBeUndefined();
  });

  it('moves old text into cold storage under a window', () => {
    setRetentionDays(db, 90);
    const r = maintenanceTick(db, quiet, { now: NOW, bootAt: NOW });
    expect(r.cold).toMatchObject({ blocks: 30, caughtUp: true });
    expect(cold()).toBe(30);
    expect(describeTick(r).some((l) => l.startsWith('retention: moved 30 block(s)'))).toBe(true);
  });

  it('checks VACUUM an hour after first boot, then daily, deferring while ingest is not quiet enough', () => {
    const bootAt = NOW;
    expect(maintenanceTick(db, quiet, { now: bootAt + 10 * MIN, bootAt }).vacuum).toBeUndefined();
    const notQuietEnough = { inFlight: false, lastActivityAt: bootAt + VACUUM_FIRST_CHECK_MS - 5 * MIN };
    const deferred = maintenanceTick(db, notQuietEnough, { now: bootAt + VACUUM_FIRST_CHECK_MS, bootAt });
    expect(deferred.vacuum).toBeUndefined();
    expect(deferred.skipped.some((s) => s.startsWith('vacuum:'))).toBe(true);

    const ran = maintenanceTick(db, quiet, { now: bootAt + VACUUM_FIRST_CHECK_MS + MIN, bootAt });
    // An in-memory test database has no freelist worth a rewrite.
    expect(ran.vacuum).toMatchObject({ ran: false });
    expect(describeTick(ran).some((l) => l.startsWith('VACUUM skipped'))).toBe(true);
    expect(db.prepare('SELECT value FROM settings WHERE key = ?').get(LAST_VACUUM_KEY)).toBeTruthy();
    expect(maintenanceTick(db, quiet, { now: bootAt + VACUUM_FIRST_CHECK_MS + 2 * MIN, bootAt }).vacuum).toBeUndefined();
    expect(maintenanceTick(db, quiet, { now: bootAt + VACUUM_FIRST_CHECK_MS + MIN + VACUUM_INTERVAL_MS, bootAt }).vacuum).toBeDefined();
  });
});
