/**
 * `make vacuum`: checkpoint, VACUUM, checkpoint, by hand.
 *
 * The same rules our worker's daily VACUUM follows (core's
 * db/maintenance: freelist gate, room on disk, WAL folded back after), with
 * two differences a person at a terminal wants: no freelist minimum unless
 * asked (MIN_MB=256), and a refusal while another process has our
 * database open. A VACUUM beside a running worker would wait on its locks
 * and then leave a WAL the size of our whole database that no checkpoint
 * can truncate while the worker reads it. FORCE=1 runs it anyway.
 *
 *   make vacuum
 *   make vacuum MIN_MB=256      only if at least 256 MB would come back
 *   make vacuum FORCE=1         beside a running stack, knowingly
 */

import Database from 'better-sqlite3';
import { existsSync, readFileSync } from 'fs';
import path from 'path';
import { pathToFileURL } from 'url';
import { UNFIREHOSE_DIR } from '@unturf/unfirehose/db/data-dir';
import { applyBasePragmas } from '@unturf/unfirehose/db/pragmas';
import { migrate } from '@unturf/unfirehose/db/migrate';
import { processesHoldingFile, planVacuum, vacuumIfWorthIt } from '@unturf/unfirehose/db/maintenance';

const MiB = 1024 ** 2;
const mb = (b: number) => `${(b / MiB).toFixed(1)} MB`;

export interface VacuumCliOptions {
  dbPath: string;
  force?: boolean;
  minFreelistBytes?: number;
  /** Who else holds the file; defaults to a /proc scan. */
  holders?: number[];
  log?: (line: string) => void;
}

function commandOf(pid: number): string {
  try { return readFileSync(`/proc/${pid}/cmdline`, 'utf8').split('\0').filter(Boolean).join(' ').slice(0, 120); } catch { return '?'; }
}

/** Returns the exit code. */
export function runVacuum(o: VacuumCliOptions): number {
  const log = o.log ?? console.log;
  if (!existsSync(o.dbPath)) {
    log(`no database at ${o.dbPath}; nothing to vacuum`);
    return 1;
  }
  const holders = o.holders ?? processesHoldingFile(o.dbPath);
  if (holders.length && !o.force) {
    log(`refusing: ${holders.length} other process(es) have ${o.dbPath} open:`);
    for (const pid of holders) log(`  ${pid}  ${commandOf(pid)}`);
    log('stop them first (make service-stop, or ctrl-c make dev), or run with FORCE=1.');
    log('our worker also vacuums on its own once a day while ingest is quiet.');
    return 2;
  }

  const db = new Database(o.dbPath);
  try {
    applyBasePragmas(db);
    migrate(db);
    const min = o.minFreelistBytes ?? 0;
    const plan = planVacuum(db, { minFreelistBytes: min });
    log(`${o.dbPath}: ${mb(plan.dbBytes)}, ${mb(plan.freelistBytes)} on our freelist, -wal ${mb(plan.walBytes)}${plan.disk ? `, ${mb(plan.disk.freeBytes)} free on disk` : ''}`);
    const r = vacuumIfWorthIt(db, { minFreelistBytes: min });
    if (!r.ran) {
      log(`skipped: ${r.reason}`);
      return 0;
    }
    log(`VACUUM ${mb(r.dbBytesBefore)} -> ${mb(r.dbBytesAfter)} in ${(r.ms / 1000).toFixed(1)} s`);
    if (r.checkpoint?.busy) log('WAL checkpoint was busy (a reader is open); our worker retries hourly.');
    else log(`-wal now ${mb(r.checkpoint?.walBytesAfter ?? 0)}`);
    return 0;
  } finally {
    db.close();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const min = parseInt(process.env.MIN_MB ?? '', 10);
  process.exit(runVacuum({
    dbPath: process.env.UNFIREHOSE_DB_PATH || path.join(UNFIREHOSE_DIR, 'unfirehose.db'),
    force: process.env.FORCE === '1',
    minFreelistBytes: Number.isFinite(min) && min > 0 ? min * MiB : 0,
  }));
}
