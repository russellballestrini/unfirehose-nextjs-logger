// Project identity, resolution and merging.
// Extracted from ingest.ts; ingest.ts re-exports the public functions.
import { existsSync, readFileSync, statSync } from 'fs';
import type { Stats } from 'fs';
import { execFileSync } from 'child_process';
import path from 'path';
import type { getDb } from './schema';
import { stmt } from './ingest-cache';

// Project identity — see docs/architecture/project-identity.md.
// A project's stable identity is (root_commit_hash, origin_url), not its filesystem path.
// This survives renames (~/git/foo → ~/git/bar) and migrations across machines.

type GitIdentity = {
  rootHash: string;       // git rev-list --max-parents=0 HEAD, sorted+joined if multi-root
  originUrl: string | null;
  remotes: string[];      // all remote URLs, sorted
};

// The cache used to be emptied at the top of every ingest pass, so every
// pass re-spawned git for every project: 95 trees, 5 s per pass measured
// 2026-09-17. Repos move on the order of hours, not seconds: an entry lives
// this long, and a pass only drops what has aged out.
//
// Then the spawns themselves. A fork from this process costs what its
// resident set costs to map — ~100 ms at 1 GB (measured 2026-09-17, against
// 4 ms from a small one) with the event loop held for all of it — and every
// tree's entry aged out at the same moment, so two spawns a tree came due
// as one 19 s block every ten minutes. Now:
//   * the root commit is read by git once a day per tree — it cannot change
//     without a history rewrite;
//   * the remotes are read from the repository's config file, in-process,
//     each time the entry is refreshed. What `git config` would add from a
//     global or system file is not a remote of this repository.
const GIT_IDENTITY_TTL_MS = 10 * 60_000;
const GIT_ROOT_HASH_TTL_MS = 24 * 60 * 60_000;
const _gitIdentityCache = new Map<string, { at: number; value: GitIdentity | null }>();
const _gitRootHashCache = new Map<string, { at: number; value: string | null }>();

/**
 * The repository config file for a working tree: `.git/config` for a
 * checkout; for a worktree, whose `.git` is a file naming its gitdir, the
 * config of the common directory that gitdir points back to.
 */
export function gitConfigPath(cwd: string): string | null {
  const dotGit = path.join(cwd, '.git');
  let st: Stats | null;
  try { st = statSync(dotGit); } catch { return null; }
  if (st.isDirectory()) return path.join(dotGit, 'config');
  let gitdir: string;
  try {
    const m = readFileSync(dotGit, 'utf8').match(/^gitdir:\s*(.+)$/m);
    if (!m) return null;
    gitdir = path.resolve(cwd, m[1].trim());
  } catch { return null; }
  try {
    const common = readFileSync(path.join(gitdir, 'commondir'), 'utf8').trim();
    return path.join(path.resolve(gitdir, common), 'config');
  } catch {
    return path.join(gitdir, 'config');
  }
}

/** Every remote URL in a repository's config, sorted, and origin's. No process spawned. */
export function readGitRemotes(cwd: string): { remotes: string[]; originUrl: string | null } {
  const remotes: string[] = [];
  let originUrl: string | null = null;
  const file = gitConfigPath(cwd);
  if (!file) return { remotes, originUrl };
  let text: string;
  try { text = readFileSync(file, 'utf8'); } catch { return { remotes, originUrl }; }
  let remote: string | null = null;
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (line.startsWith('[')) {
      const m = line.match(/^\[remote\s+"((?:[^"\\]|\\.)*)"\]$/);
      remote = m ? m[1].replace(/\\(.)/g, '$1') : null;
      continue;
    }
    if (remote === null) continue;
    const kv = line.match(/^url\s*=\s*(.+?)\s*$/);
    if (!kv) continue;
    remotes.push(kv[1]);
    if (remote === 'origin') originUrl = kv[1];
  }
  remotes.sort();
  return { remotes, originUrl };
}

function gitRootHash(cwd: string): string | null {
  const hit = _gitRootHashCache.get(cwd);
  if (hit && Date.now() - hit.at < GIT_ROOT_HASH_TTL_MS) return hit.value;
  let value: string | null = null;
  try {
    const out = execFileSync('git', ['-C', cwd, 'rev-list', '--max-parents=0', 'HEAD'],
      { encoding: 'utf8', timeout: 2000, stdio: ['ignore', 'pipe', 'ignore'] });
    const hashes = out.trim().split('\n').filter(Boolean).sort();
    if (hashes.length > 0) value = hashes.join(',');  // multi-root repos get a stable composite
  } catch { /* not a repository, or no commit yet */ }
  _gitRootHashCache.set(cwd, { at: Date.now(), value });
  return value;
}

function gitIdentity(cwd: string | undefined): GitIdentity | null {
  if (!cwd) return null;
  const hit = _gitIdentityCache.get(cwd);
  if (hit && Date.now() - hit.at < GIT_IDENTITY_TTL_MS) return hit.value;

  const miss = (): null => { _gitIdentityCache.set(cwd, { at: Date.now(), value: null }); return null; };

  // Skip if path doesn't exist or isn't a git working tree
  if (!existsSync(cwd) || !existsSync(path.join(cwd, '.git'))) return miss();

  const rootHash = gitRootHash(cwd);
  if (rootHash === null) return miss();

  const { remotes, originUrl } = readGitRemotes(cwd);
  const identity: GitIdentity = { rootHash, originUrl, remotes };
  _gitIdentityCache.set(cwd, { at: Date.now(), value: identity });
  return identity;
}

/** Drop identities older than the TTL. Fresh ones are reused across passes. */
export function clearGitIdentityCache(): void {
  const now = Date.now();
  for (const [cwd, hit] of _gitIdentityCache) {
    if (now - hit.at >= GIT_IDENTITY_TTL_MS) _gitIdentityCache.delete(cwd);
  }
}

export function harnessPrefixOf(name: string): string {
  const colon = name.indexOf(':');
  return colon >= 0 ? name.slice(0, colon) : '';
}

export function getOrCreateProject(
  db: ReturnType<typeof getDb>,
  name: string,
  displayName: string,
  projectPath?: string
): number {
  const prefix = harnessPrefixOf(name);
  const identity = gitIdentity(projectPath);

  // 1. Direct name match (most common path)
  const direct = stmt(db, 'SELECT id, path, root_commit_hash, origin_url FROM projects WHERE name = ?')
    .get(name) as { id: number; path: string; root_commit_hash: string | null; origin_url: string | null } | undefined;
  if (direct) {
    // Opportunistic backfill: populate identity fields when missing or update last_cwd_seen.
    if (identity) {
      db.prepare(`
        UPDATE projects SET
          root_commit_hash = COALESCE(root_commit_hash, ?),
          origin_url       = COALESCE(origin_url, ?),
          remotes_json     = COALESCE(remotes_json, ?),
          last_cwd_seen    = ?,
          path             = CASE WHEN path IS NULL OR path = '' THEN ? ELSE path END
        WHERE id = ?
      `).run(identity.rootHash, identity.originUrl, JSON.stringify(identity.remotes), projectPath ?? null, projectPath ?? '', direct.id);
    } else if (projectPath && (!direct.path || direct.path === '')) {
      db.prepare('UPDATE projects SET path = ?, last_cwd_seen = ? WHERE id = ?')
        .run(projectPath, projectPath, direct.id);
    }
    return direct.id;
  }

  // 2. Alias match — this encoded name has been merged into an existing project before
  const alias = db
    .prepare('SELECT project_id FROM project_aliases WHERE encoded_name = ?')
    .get(name) as { project_id: number } | undefined;
  if (alias) {
    db.prepare("UPDATE project_aliases SET last_seen = datetime('now') WHERE encoded_name = ?").run(name);
    return alias.project_id;
  }

  // 3. Identity match — same git repo seen under a different encoded name (the rename case).
  //    Match within the same harness prefix so 'arborist:foo' and 'uncloseai:foo' stay separate.
  if (identity) {
    const candidates = db.prepare(`
      SELECT id, name, remotes_json, origin_url FROM projects
      WHERE root_commit_hash = ?
        AND (CASE
          WHEN ? = '' THEN instr(name, ':') = 0
          ELSE name LIKE ? || ':%'
        END)
    `).all(identity.rootHash, prefix, prefix) as Array<{
      id: number; name: string; remotes_json: string | null; origin_url: string | null;
    }>;

    let matched: { id: number; name: string } | undefined;
    for (const c of candidates) {
      // Origin URL match: equal, or any remote in either side overlaps.
      const cRemotes: string[] = c.remotes_json ? safeParseArray(c.remotes_json) : [];
      const overlap = identity.remotes.some((r) => cRemotes.includes(r));
      const originMatch =
        (identity.originUrl && c.origin_url && identity.originUrl === c.origin_url) ||
        overlap ||
        (identity.remotes.length === 0 && cRemotes.length === 0);  // both local-only
      if (originMatch) { matched = c; break; }
    }

    if (matched) {
      // Register the new encoded name as an alias of the matched project.
      db.prepare(`
        INSERT OR IGNORE INTO project_aliases (project_id, encoded_name, cwd, harness_prefix)
        VALUES (?, ?, ?, ?)
      `).run(matched.id, name, projectPath ?? null, prefix);
      db.prepare(`UPDATE projects SET last_cwd_seen = ? WHERE id = ?`)
        .run(projectPath ?? null, matched.id);
      return matched.id;
    }
  }

  // 4. No match — create a new project row + self-alias.
  const result = db.prepare(`
    INSERT INTO projects (name, display_name, path, root_commit_hash, origin_url, remotes_json, last_cwd_seen)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(
    name,
    displayName,
    projectPath ?? '',
    identity?.rootHash ?? null,
    identity?.originUrl ?? null,
    identity ? JSON.stringify(identity.remotes) : null,
    projectPath ?? null
  );
  const newId = result.lastInsertRowid as number;

  db.prepare(`
    INSERT OR IGNORE INTO project_aliases (project_id, encoded_name, cwd, harness_prefix)
    VALUES (?, ?, ?, ?)
  `).run(newId, name, projectPath ?? null, prefix);

  return newId;
}

function safeParseArray(s: string): string[] {
  try { const v = JSON.parse(s); return Array.isArray(v) ? v.map(String) : []; }
  catch { return []; }
}

/**
 * Merge `loserId` into `winnerId`:
 *   - usage_minutes summed on overlapping minutes, otherwise re-pointed
 *   - sessions, todos, agent_deployments, project_aliases re-pointed
 *   - project_visibility for loser dropped (winner's settings win)
 *   - alerts.project_name and agent_actions.project_name rewritten to winner's name
 *   - loser's encoded name registered as an alias of winner
 *   - loser row deleted
 *
 * Idempotent; safe to call repeatedly. No-op if loserId === winnerId.
 */
export function mergeProjects(
  db: ReturnType<typeof getDb>,
  loserId: number,
  winnerId: number
): boolean {
  if (loserId === winnerId) return false;

  const loser = db.prepare('SELECT id, name FROM projects WHERE id = ?').get(loserId) as
    { id: number; name: string } | undefined;
  const winner = db.prepare('SELECT id, name FROM projects WHERE id = ?').get(winnerId) as
    { id: number; name: string } | undefined;
  if (!loser || !winner) return false;

  const loserPrefix = harnessPrefixOf(loser.name);

  const tx = db.transaction(() => {
    // 1. Sessions: re-point
    db.prepare('UPDATE sessions SET project_id = ? WHERE project_id = ?').run(winnerId, loserId);

    // 2. Todos: re-point
    db.prepare('UPDATE todos SET project_id = ? WHERE project_id = ?').run(winnerId, loserId);

    // 3. Agent deployments: re-point
    db.prepare('UPDATE agent_deployments SET project_id = ? WHERE project_id = ?')
      .run(winnerId, loserId);

    // 4. usage_minutes: sum on overlapping minutes, re-point the rest.
    //    The (minute, project_id) pair is logically unique per the ON CONFLICT in writes.
    db.prepare(`
      UPDATE usage_minutes AS w
      SET input_tokens          = w.input_tokens          + l.input_tokens,
          output_tokens         = w.output_tokens         + l.output_tokens,
          cache_read_tokens     = w.cache_read_tokens     + l.cache_read_tokens,
          cache_creation_tokens = w.cache_creation_tokens + l.cache_creation_tokens,
          message_count         = w.message_count         + l.message_count
      FROM (SELECT * FROM usage_minutes WHERE project_id = ?) AS l
      WHERE w.project_id = ? AND w.minute = l.minute
    `).run(loserId, winnerId);

    db.prepare(`
      UPDATE usage_minutes SET project_id = ?
       WHERE project_id = ?
         AND minute NOT IN (SELECT minute FROM usage_minutes WHERE project_id = ?)
    `).run(winnerId, loserId, winnerId);

    db.prepare('DELETE FROM usage_minutes WHERE project_id = ?').run(loserId);

    // 5. project_visibility — winner's settings take precedence; drop loser's row
    db.prepare('DELETE FROM project_visibility WHERE project_id = ?').run(loserId);

    // 6. project_aliases — re-point everything the loser owned to the winner
    db.prepare('UPDATE project_aliases SET project_id = ? WHERE project_id = ?')
      .run(winnerId, loserId);

    // 7. Loser's own encoded name becomes an alias of the winner (so future ingest of
    //    the same encoded dir routes to the winner, not a recreated loser).
    db.prepare(`
      INSERT OR IGNORE INTO project_aliases (project_id, encoded_name, harness_prefix)
      VALUES (?, ?, ?)
    `).run(winnerId, loser.name, loserPrefix);

    // 8. String-named tables that key on projects.name
    db.prepare('UPDATE alerts SET project_name = ? WHERE project_name = ?')
      .run(winner.name, loser.name);
    db.prepare('UPDATE agent_actions SET project_name = ? WHERE project_name = ?')
      .run(winner.name, loser.name);

    // 9. Drop the loser row
    db.prepare('DELETE FROM projects WHERE id = ?').run(loserId);
  });
  tx();
  return true;
}

/**
 * Find groups of project rows that share git identity within one harness slot,
 * and merge each group into its most-recently-active member.
 *
 * Identity match = (root_commit_hash, origin_url) within the same `prefix:` namespace.
 * Origin-URL match = exact equality; null vs null counts as match (both local-only repos
 * with the same root hash are by construction the same repo).
 *
 * Returns the number of merges performed.
 */
export function autoMergeIdenticalProjects(db: ReturnType<typeof getDb>): number {
  type Group = { prefix: string; root: string; origin: string; ids: string };
  const groups = db.prepare(`
    SELECT
      CASE WHEN instr(name, ':') = 0 THEN '' ELSE substr(name, 1, instr(name, ':') - 1) END AS prefix,
      root_commit_hash AS root,
      COALESCE(origin_url, '') AS origin,
      GROUP_CONCAT(id) AS ids
    FROM projects
    WHERE root_commit_hash IS NOT NULL
    GROUP BY prefix, root_commit_hash, COALESCE(origin_url, '')
    HAVING COUNT(*) > 1
  `).all() as Group[];

  let mergedCount = 0;
  for (const g of groups) {
    const ids = g.ids.split(',').map(Number);
    // Winner = project with most recent session activity
    const ranked = db.prepare(`
      SELECT p.id AS id,
             COALESCE(MAX(s.updated_at), p.first_seen, '1970-01-01') AS last_act
      FROM projects p
      LEFT JOIN sessions s ON s.project_id = p.id
      WHERE p.id IN (${ids.map(() => '?').join(',')})
      GROUP BY p.id
      ORDER BY last_act DESC, p.id DESC
    `).all(...ids) as Array<{ id: number; last_act: string }>;

    if (ranked.length < 2) continue;
    const winnerId = ranked[0].id;
    for (const loser of ranked.slice(1)) {
      if (mergeProjects(db, loser.id, winnerId)) mergedCount++;
    }
  }
  return mergedCount;
}
