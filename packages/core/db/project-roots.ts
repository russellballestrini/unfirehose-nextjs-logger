/**
 * The directories of projects we already ingest: where a harness that
 * writes inside each repository (Aider, `repoFile` in the registry) is
 * looked for. Never a crawl of the home directory: a repo shows up here
 * only after some harness we read has worked in it, which is what makes it
 * one the person demonstrably works in.
 *
 * Both ingest and detection (the onboarding route, `make doctor`) ask, so
 * the query lives once. It takes any better-sqlite3 handle and imports no
 * native module, so the doctor can call it on a read-only handle of its own.
 */
import { existsSync } from 'fs';
import path from 'path';
import { homedir } from 'os';

interface Queryable { prepare(sql: string): { all(...args: unknown[]): unknown[] } }

/**
 * The nearest directory at or above `dir` holding a `.git`, stopping below
 * the home directory and the filesystem root. Aider writes its log in the
 * git root even when started in a subdirectory.
 */
function gitRootOf(dir: string, home: string): string | null {
  let d = dir;
  for (let i = 0; i < 32; i++) {
    if (existsSync(path.join(d, '.git'))) return d;
    const up = path.dirname(d);
    if (up === d || up === home || d === home) return null;
    d = up;
  }
  return null;
}

/**
 * Every directory a project row names (`path`, `last_cwd_seen`), plus the
 * git root above it when it is a subdirectory of one, deduplicated, existing
 * only. Sorted, so a pass visits them in a stable order.
 */
export function knownProjectRoots(db: Queryable, home = homedir()): string[] {
  let rows: Array<{ p: string | null }> = [];
  try {
    rows = db.prepare(
      `SELECT path AS p FROM projects WHERE path IS NOT NULL AND path != ''
       UNION SELECT last_cwd_seen FROM projects WHERE last_cwd_seen IS NOT NULL AND last_cwd_seen != ''`,
    ).all() as Array<{ p: string | null }>;
  } catch { return []; }
  const out = new Set<string>();
  for (const { p } of rows) {
    if (!p || !path.isAbsolute(p) || !existsSync(p)) continue;
    const dir = path.resolve(p);
    out.add(dir);
    const root = gitRootOf(dir, home);
    if (root) out.add(root);
  }
  return [...out].sort();
}
