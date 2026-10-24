/**
 * Our worker's database upkeep, run while ingest is idle: today's size
 * snapshot, the retention window's move of old block text into cold
 * storage, and the daily VACUUM. The rules (what idle means, whether a
 * VACUUM is worth it, how text moves) live in core and are shared with
 * `make vacuum`; this file only decides when.
 *
 * One tick every MAINTENANCE_TICK_MS. Each piece is gated on its own quiet
 * period from core: a cold batch holds the write lock for milliseconds and
 * runs after two quiet minutes, a VACUUM rewrites the file and waits for
 * fifteen.
 */

import type Database from 'better-sqlite3';
import { ingestIdle, vacuumIfWorthIt, VACUUM_QUIET_MS, COLD_MOVE_QUIET_MS, type IngestState } from '@unturf/unfirehose/db/maintenance';
import { freezeBatch, getRetentionDays } from '@unturf/unfirehose/db/block-cold';
import { recordSizeSnapshot, sizeSnapshotDue } from '@unturf/unfirehose/db/db-health';

export const MAINTENANCE_TICK_MS = 60_000;
export const VACUUM_INTERVAL_MS = 24 * 60 * 60 * 1000;
/** A fresh worker's first VACUUM check comes this long after boot, as it always did. */
export const VACUUM_FIRST_CHECK_MS = 60 * 60 * 1000;
/** Time one tick may spend moving cold text before yielding to ingest. */
export const COLD_TICK_BUDGET_MS = 1000;
export const LAST_VACUUM_KEY = 'db_last_vacuum_check_at';

export interface TickReport {
  snapshot?: { ms: number; dbBytes: number };
  cold?: { blocks: number; rawBytes: number; storedBytes: number; caughtUp: boolean };
  vacuum?: ReturnType<typeof vacuumIfWorthIt>;
  skipped: string[];
}

function lastVacuumCheck(db: Database.Database, bootAt: number): number {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(LAST_VACUUM_KEY) as { value: string } | undefined;
  const t = row ? Date.parse(row.value) : NaN;
  // Never checked: behave as if the last check was a day less an hour before boot.
  return Number.isFinite(t) ? t : bootAt - VACUUM_INTERVAL_MS + VACUUM_FIRST_CHECK_MS;
}

/**
 * One upkeep pass. Pure apart from the database: the caller passes ingest
 * state and the clock, so a test drives it without timers.
 */
export function maintenanceTick(
  db: Database.Database,
  ingest: IngestState,
  opts: { now?: number; bootAt?: number; coldBudgetMs?: number } = {},
): TickReport {
  const now = opts.now ?? Date.now();
  const report: TickReport = { skipped: [] };

  const quick = ingestIdle({ ...ingest, now }, COLD_MOVE_QUIET_MS);
  if (!quick.idle) {
    report.skipped.push(`all: ${quick.reason}`);
    return report;
  }

  if (sizeSnapshotDue(db, now)) {
    const t0 = Date.now();
    const snap = recordSizeSnapshot(db, { now });
    report.snapshot = { ms: Date.now() - t0, dbBytes: snap.dbBytes };
  }

  const days = getRetentionDays(db);
  if (days != null) {
    const budget = opts.coldBudgetMs ?? COLD_TICK_BUDGET_MS;
    const t0 = Date.now();
    const sum = { blocks: 0, rawBytes: 0, storedBytes: 0, caughtUp: false };
    do {
      const r = freezeBatch(db, { days, now });
      sum.blocks += r.blocks; sum.rawBytes += r.rawBytes; sum.storedBytes += r.storedBytes;
      sum.caughtUp = r.caughtUp;
    } while (!sum.caughtUp && Date.now() - t0 < budget);
    if (sum.blocks > 0 || !sum.caughtUp) report.cold = sum;
  }

  if (now - lastVacuumCheck(db, opts.bootAt ?? now) >= VACUUM_INTERVAL_MS) {
    const slow = ingestIdle({ ...ingest, now }, VACUUM_QUIET_MS);
    if (!slow.idle) {
      // Not a day lost: the next quiet tick tries again.
      report.skipped.push(`vacuum: ${slow.reason}`);
    } else {
      report.vacuum = vacuumIfWorthIt(db);
      db.prepare(
        `INSERT INTO settings (key, value, updated_at) VALUES (?, ?, datetime('now'))
         ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
      ).run(LAST_VACUUM_KEY, new Date(now).toISOString());
    }
  }
  return report;
}

const mb = (b: number) => (b / 1048576).toFixed(1);

/** One log line per thing done or deferred; nothing for an idle tick that had nothing to do. */
export function describeTick(r: TickReport): string[] {
  const out: string[] = [];
  if (r.snapshot) out.push(`db size snapshot: ${mb(r.snapshot.dbBytes)}MB measured in ${r.snapshot.ms}ms`);
  if (r.cold) out.push(`retention: moved ${r.cold.blocks} block(s), ${mb(r.cold.rawBytes)}MB of text into ${mb(r.cold.storedBytes)}MB cold${r.cold.caughtUp ? ', caught up' : ', more next tick'}`);
  if (r.vacuum) {
    out.push(r.vacuum.ran
      ? `VACUUM ${mb(r.vacuum.dbBytesBefore)} → ${mb(r.vacuum.dbBytesAfter)}MB in ${r.vacuum.ms}ms (${r.vacuum.reason})`
      : `VACUUM skipped — ${r.vacuum.reason}`);
  }
  return out;
}
