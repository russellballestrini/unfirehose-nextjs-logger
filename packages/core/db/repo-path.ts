/**
 * Where a project's working copy lives on disk.
 *
 * Seven API routes each carried their own copy of this, and every copy knew
 * only Claude Code's naming: read `sessions-index.json` from
 * `~/.claude/projects/<encoded>/`, else decode the encoded name by guessing
 * where the dashes were slashes. Both fail for a project that never had a
 * Claude directory, so `uncloseai:home-fox-git-uncloseai-cli` and any
 * harness-prefixed row answered "Could not resolve repo path" and the Code
 * tab showed nothing.
 *
 * The database has known the answer all along: ingest records `cwd` on every
 * session. Ask it first, and keep the filesystem guesses as the fallback for
 * a project that has a directory but no rows yet.
 */

import { statSync } from 'fs';
import type Database from 'better-sqlite3';
import { getDb } from './schema';
import { stripHarness } from '../project-rollup';

function isDir(p: string | null | undefined): p is string {
  if (!p) return false;
  try { return statSync(p).isDirectory(); } catch { return false; }
}

/**
 * Decode an encoded project name into a path, the way Claude Code's own
 * naming implies. `-home-fox-git-my-repo` is ambiguous — the dashes inside
 * the repo name look exactly like the dashes that were slashes — so each
 * candidate is checked against the filesystem rather than assumed.
 */
export function pathFromEncodedName(name: string): string | null {
  const { slug } = stripHarness(name);
  const parts = slug.replace(/^-+/, '').split('-');
  const gitIdx = parts.lastIndexOf('git');
  if (gitIdx < 0 || gitIdx >= parts.length - 1) return null;

  const prefix = '/' + parts.slice(0, gitIdx + 1).join('/');
  const rest = parts.slice(gitIdx + 1);

  const dashJoined = `${prefix}/${rest.join('-')}`;
  if (isDir(dashJoined)) return dashJoined;

  // A trailing TLD is a directory name with a dot in it, not another segment.
  if (rest.length >= 2) {
    const last = rest[rest.length - 1];
    if (['com', 'net', 'org', 'io', 'dev', 'ai', 'app'].includes(last)) {
      const dotted = `${prefix}/${rest.slice(0, -1).join('-')}.${last}`;
      if (isDir(dotted)) return dotted;
      const allDots = `${prefix}/${rest.join('.')}`;
      if (isDir(allDots)) return allDots;
    }
  }
  return null;
}

/**
 * Resolve a project name to a directory, or null when nothing on disk
 * matches. Never returns a path that does not exist.
 */
export function repoPathForProject(name: string, db?: Database.Database): string | null {
  const database = db ?? getDb();

  // 1. What ingest recorded for this exact row.
  try {
    const row = database.prepare(
      'SELECT COALESCE(path, last_cwd_seen) AS p FROM projects WHERE name = ?',
    ).get(name) as { p: string | null } | undefined;
    if (isDir(row?.p)) return row!.p!;
  } catch { /* fall through to the filesystem */ }

  // 2. The same repo under another harness. `projects` is scoped per harness
  //    slot by design, so one checkout can hold several rows; any of them
  //    knows the path.
  try {
    const { slug } = stripHarness(name);
    const bare = slug.replace(/^-+/, '');
    const rows = database.prepare(
      `SELECT COALESCE(p.path, p.last_cwd_seen) AS p FROM projects p
        WHERE p.name = ? OR p.name = ? OR p.name LIKE ?`,
    ).all(bare, `-${bare}`, `%:${bare}`) as Array<{ p: string | null }>;
    for (const r of rows) if (isDir(r.p)) return r.p!;
  } catch { /* fall through */ }

  // 3. No rows yet — decode the name.
  return pathFromEncodedName(name);
}
