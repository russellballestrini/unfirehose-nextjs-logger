// Seed our demo database for `make demo`.
//
//   npx tsx scripts/demo.ts                      seeds ~/.unfirehose-demo
//   UNFIREHOSE_DIR=/tmp/x npx tsx scripts/demo.ts   seeds /tmp/x (empty, or one we seeded)
//
// Writes only into a directory that is ours: one that does not exist yet,
// is empty, or carries the marker file a previous run left. Anything else —
// our real ~/.unfirehose above all — is refused before a byte is written.
// Re-running replaces the demo database and nothing else, so it is
// idempotent.
//
// While it runs, HOME points at <demo dir>/home, an empty home, so the
// project list's pass over ~/.claude/projects (and any other harness path)
// finds nothing real to mix into the demo. `make demo` starts the web app
// the same way.

import { existsSync, mkdirSync, readdirSync, rmSync, statSync, writeFileSync } from 'fs';
import { homedir } from 'os';
import path from 'path';
import { pathToFileURL } from 'url';

export const DEMO_MARKER = '.unfirehose-demo';
const DB_FILES = ['unfirehose.db', 'unfirehose.db-wal', 'unfirehose.db-shm'];

/**
 * Where to seed, or why not. Pure, so the refusals can be tested without a
 * filesystem: `listing` is the directory's entries, or null when it does not
 * exist.
 */
export function demoDirVerdict(
  target: string,
  home: string,
  listing: string[] | null,
): { ok: true; dir: string } | { ok: false; reason: string } {
  const dir = path.resolve(target);
  const real = path.resolve(home, '.unfirehose');
  const inside = (child: string, parent: string) => {
    const rel = path.relative(parent, child);
    return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
  };
  if (inside(dir, real)) return { ok: false, reason: `${dir} is our real data directory (or inside it)` };
  if (inside(path.resolve(home), dir)) return { ok: false, reason: `${dir} holds your home directory` };
  if (listing && listing.length > 0 && !listing.includes(DEMO_MARKER)) {
    return { ok: false, reason: `${dir} is not empty and was not made by make demo (no ${DEMO_MARKER} marker)` };
  }
  return { ok: true, dir };
}

async function main() {
  const realHome = homedir();
  const target = process.env.UNFIREHOSE_DIR || path.join(realHome, '.unfirehose-demo');
  const listing = existsSync(target)
    ? (statSync(target).isDirectory() ? readdirSync(target) : ['(a file)'])
    : null;
  const verdict = demoDirVerdict(target, realHome, listing);
  if (!verdict.ok) {
    console.error(`demo: refusing to seed: ${verdict.reason}`);
    process.exit(1);
  }
  const dir = verdict.dir;

  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, DEMO_MARKER), 'Seeded by `make demo` (scripts/demo.ts). Safe to delete.\n');
  for (const f of DB_FILES) rmSync(path.join(dir, f), { force: true });
  const fakeHome = path.join(dir, 'home');
  mkdirSync(fakeHome, { recursive: true });

  // Before anything that reads them at load time is imported.
  process.env.HOME = fakeHome;
  process.env.UNFIREHOSE_DIR = dir;
  process.env.UNFIREHOSE_DB_PATH = path.join(dir, 'unfirehose.db');
  process.env.UNFIREHOSE_HARNESSES = 'none';

  const { getDb } = await import('@unturf/unfirehose/db/schema');
  const { seedDemo, buildDemoPayloads } = await import('@unturf/unfirehose/demo-seed');

  const t0 = Date.now();
  const counts = seedDemo(getDb());
  await buildDemoPayloads();
  // A database with no price book starts a background sync with public
  // price feeds the moment a cost is computed. Demo models price at $0
  // without one, so we exit rather than wait on it, and drop the register
  // entry it opened: a sync we cut off never finished, and the register
  // must not say one is still running.
  getDb().prepare(`DELETE FROM pricing_sync_runs WHERE finished_at IS NULL AND trigger = 'bootstrap'`).run();
  // Fold the WAL back in, so what is on disk is one self-contained file.
  getDb().pragma('wal_checkpoint(TRUNCATE)');
  console.log(
    `demo: seeded ${path.join(dir, 'unfirehose.db')} in ${Date.now() - t0}ms: `
    + `${counts.projects} projects, ${counts.sessions} sessions, ${counts.messages} messages, `
    + `${counts.todos} todos, ${counts.alerts} alert, ${counts.meshSnapshots} mesh samples`,
  );
  process.exit(0);
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch((err) => {
    console.error('demo: seed failed:', err);
    process.exit(1);
  });
}
