import Database from 'better-sqlite3';
import path from 'path';
import { homedir } from 'os';
import { mkdirSync } from 'fs';
import { applyBasePragmas } from './pragmas';
import { migrate } from './migrate';

const UNFIREHOSE_DIR = path.join(homedir(), '.unfirehose');

// `UNFIREHOSE_DB_PATH` redirects the whole process at one file. Tests use it
// to get a scratch database, and it lets a second instance run against a copy
// without editing code.
const DB_PATH = process.env.UNFIREHOSE_DB_PATH
  || path.join(UNFIREHOSE_DIR, 'unfirehose.db');

// Exported for other modules that need the base directory
export { UNFIREHOSE_DIR, DB_PATH };

let _db: Database.Database | null = null;

/**
 * True inside a test runner.
 *
 * `VITEST` is set in every vitest worker, `NODE_ENV === 'test'` covers other
 * runners. Checked at call time rather than module load so a test that sets
 * it in a beforeAll still gets the guard.
 */
function isTestRuntime(): boolean {
  return Boolean(process.env.VITEST) || process.env.NODE_ENV === 'test';
}

export function getDb(): Database.Database {
  if (_db) return _db;

  // A test that forgets to mock this reads the LIVE database, and nothing
  // says so — it just quietly answers with real data. `GET /api/projects`
  // seeded one project, asserted a list of one, and got 96: the operator's
  // actual projects. So the suite's verdict tracked whatever happened to be
  // on that machine, which is worse than no suite, because it reports green
  // and means nothing. Failing loudly here turns a silent read of production
  // into a message naming the fix.
  //
  // Reads are the mild case. The same unmocked handle is what a POST route
  // would WRITE through.
  if (isTestRuntime() && !process.env.UNFIREHOSE_DB_PATH) {
    throw new Error(
      'getDb() reached the live database from a test. Mock it —\n'
      + "  vi.mock('@unturf/unfirehose/db/schema', () => ({ getDb: () => db }))\n"
      + 'with a db from createTestDb(), or set UNFIREHOSE_DB_PATH to a scratch\n'
      + 'file for a test that genuinely needs one on disk.',
    );
  }

  mkdirSync(path.dirname(DB_PATH), { recursive: true });
  _db = new Database(DB_PATH);
  applyBasePragmas(_db);
  // 256MB page cache keeps our covering indices in memory across requests —
  // /api/tokens does a full scan of messages and was cache-thrashing at 2MB.
  _db.pragma('cache_size = -262144');
  // 512MB mmap so SQLite uses zero-copy reads off the OS page cache instead
  // of read() syscalls. Helps the big sequential scans on `messages`.
  _db.pragma('mmap_size = 536870912');
  // SQLite normally spills GROUP BY temp B-trees to disk; pinning them to
  // memory removes a class of latency spike on /api/tokens.
  _db.pragma('temp_store = MEMORY');

  migrate(_db);
  return _db;
}

export function migrateTenantDb(db: Database.Database) {
  migrate(db);
}
