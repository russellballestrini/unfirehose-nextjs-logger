/**
 * The project list, built away from the request that shows it.
 *
 * A rebuild is two aggregates over a 1.6M-row messages table, a filesystem
 * pass over ~96 project directories, and then the path and name folds —
 * about 5 seconds. Node is single-threaded, so running that inside the web
 * process does not merely make THIS request slow: it starves every other
 * request on the server while it runs, which is most of why the dashboard
 * felt slow everywhere at once.
 *
 * The worker builds it and stores it; the page reads what was left.
 */

import { readdir, readFile, stat } from 'fs/promises';
import type Database from 'better-sqlite3';
import { claudePaths } from './claude-paths';
import { decodeProjectName, resolveProjectPath } from './project-name';
import { getDb } from './db/schema';
import { getSetting, setSetting } from './db/ingest';
import {
  rollupProjects, rollupTarget, newerOf,
  isEphemeralPath, isWorkspacePath, ancestorByPath, countPathChildren,
} from './project-rollup';
import type { ProjectInfo, SessionsIndex } from './types';

/* eslint-disable @typescript-eslint/no-explicit-any */

export const PROJECT_LIST_KEY = 'project_list';
export const PROJECT_LIST_AT = 'project_list_at';

async function loadOneFsProject(dir: string, knownPath?: string): Promise<ProjectInfo | null> {
  try {
    const dirStat = await stat(claudePaths.projectDir(dir)).catch(() => null);
    if (!dirStat?.isDirectory()) return null;

    let sessionCount = 0;
    let totalMessages = 0;
    let projectPath = '';

    try {
      const indexRaw = await readFile(claudePaths.sessionsIndex(dir), 'utf-8');
      const index: SessionsIndex = JSON.parse(indexRaw);
      sessionCount = index.entries.length;
      totalMessages = index.entries.reduce((s, e) => s + (e.messageCount ?? 0), 0);
      projectPath = index.originalPath ?? '';
    } catch {
      try {
        const files = await readdir(claudePaths.projectDir(dir));
        sessionCount = files.filter((f) => f.endsWith('.jsonl')).length;
      } catch { /* empty */ }
    }

    // resolveProjectPath falls back to a filesystem DFS that probes every
    // segment split of the encoded name. Across ~95 projects that alone cost
    // ~19s of the response. The database already records where each project
    // lives, so only probe when it genuinely does not know.
    if (!projectPath) projectPath = knownPath ?? '';
    if (!projectPath) {
      projectPath = (await resolveProjectPath(dir)) ?? '';
    }

    return {
      name: dir,
      displayName: decodeProjectName(dir),
      path: projectPath,
      sessionCount,
      totalMessages,
      // Deliberately empty. sessions-index.json is stale; the DB supplies this.
      latestActivity: '',
      hasMemory: false,
      harnesses: [],
      foldedCount: 0,
    };
  } catch {
    return null;
  }
}

interface DbRow {
  name: string;
  path: string | null;
  root_commit_hash: string | null;
  is_repo: number;
  sessions: number;
  messages: number;
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
  cache_write_tokens: number;
  latest: string | null;
  harnesses: string | null;
}

type TokenTotals = { input: number; output: number; cacheRead: number; cacheWrite: number };

const zeroTokens = (): TokenTotals => ({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });

const tokensOf = (r: DbRow): TokenTotals => ({
  input: r.input_tokens ?? 0,
  output: r.output_tokens ?? 0,
  cacheRead: r.cache_read_tokens ?? 0,
  cacheWrite: r.cache_write_tokens ?? 0,
});

/* eslint-disable-next-line @typescript-eslint/no-explicit-any */
function addTokens(target: any, r: DbRow) {
  target.tokens = target.tokens ?? zeroTokens();
  const t = tokensOf(r);
  target.tokens.input += t.input;
  target.tokens.output += t.output;
  target.tokens.cacheRead += t.cacheRead;
  target.tokens.cacheWrite += t.cacheWrite;
}

export async function buildProjectList(): Promise<ProjectInfo[]> {
  {
    try {
    const [fsDirs, dbRows] = await Promise.all([
      readdir(claudePaths.projects).catch(() => [] as string[]),
      Promise.resolve().then(() => {
        const db = getDb();
        // Two independent single-scan aggregates, joined at the end.
        //
        // Joining projects -> sessions -> messages directly and grouping made
        // SQLite materialize one row per message (1.4M) before collapsing to
        // ~6.5k projects, and COUNT(DISTINCT s.id) over that took 22s. Each
        // side is grouped on its own first, so neither scan is multiplied by
        // the other.
        return db.prepare(`
          WITH sess AS (
            SELECT project_id,
                   COUNT(*)                       AS sessions,
                   MAX(COALESCE(last_message_at, updated_at, created_at)) AS latest,
                   GROUP_CONCAT(DISTINCT harness) AS harnesses
              FROM sessions
             GROUP BY project_id
          ),
          msg AS (
            -- MAX(m.timestamp) alongside the count, because
            -- sessions.last_message_at lags: 12,548 of 48,034 sessions carry a
            -- value older than their own newest message. Ordering on the
            -- session column alone leaves a project sitting still while its
            -- messages keep arriving.
            SELECT s.project_id,
                   COUNT(*)          AS messages,
                   -- Free on a scan we already pay for. Cache is counted
                   -- because it is most of what any project moves.
                   SUM(m.input_tokens)          AS input_tokens,
                   SUM(m.output_tokens)         AS output_tokens,
                   SUM(m.cache_read_tokens)     AS cache_read_tokens,
                   SUM(m.cache_creation_tokens) AS cache_write_tokens,
                   MAX(m.timestamp)  AS latest_msg
              FROM messages m
              JOIN sessions s ON s.id = m.session_id
             GROUP BY s.project_id
          )
          SELECT p.name                            AS name,
                 COALESCE(p.path, p.last_cwd_seen) AS path,
                 COALESCE(p.root_commit_hash, '')  AS root_commit_hash,
                 -- A repo is a git root. Having a path proves nothing: 1,352
                 -- rows carry one and are agent scratch directories inside a
                 -- repo, not repos themselves.
                 CASE WHEN COALESCE(p.root_commit_hash,'') != ''
                      THEN 1 ELSE 0 END            AS is_repo,
                 sess.sessions                     AS sessions,
                 COALESCE(msg.messages, 0)         AS messages,
                 COALESCE(msg.input_tokens, 0)     AS input_tokens,
                 COALESCE(msg.output_tokens, 0)    AS output_tokens,
                 COALESCE(msg.cache_read_tokens, 0)  AS cache_read_tokens,
                 COALESCE(msg.cache_write_tokens, 0) AS cache_write_tokens,
                 MAX(COALESCE(msg.latest_msg, ''), COALESCE(sess.latest, '')) AS latest,
                 sess.harnesses                    AS harnesses
            FROM projects p
            JOIN sess ON sess.project_id = p.id
            LEFT JOIN msg ON msg.project_id = p.id
        `).all() as DbRow[];
      }),
    ]);

    const pathByName = new Map<string, string>();
    for (const r of dbRows) {
      if (r.path) pathByName.set(r.name, r.path);
    }
    const fsProjects = (await Promise.all(
      fsDirs.map((d) => loadOneFsProject(d, pathByName.get(d))),
    )).filter(Boolean) as ProjectInfo[];

    // A "repo" is somewhere real work lives: it has a Claude directory, or the
    // database resolved it to a git root or a filesystem path. Everything else
    // is an agent scratch workspace and folds into whichever repo contains it.
    const repoNames = new Set<string>(fsProjects.map((p) => p.name));
    for (const r of dbRows) {
      if (r.is_repo) repoNames.add(r.name);
    }

    // Container directories. `~/git` and `/tmp` are tracked projects — agents
    // do run with those as cwd — but they are also the parent of dozens of
    // unrelated projects. Letting them absorb by path or name prefix ate
    // ~/git/contra into "fox-git" and turned /tmp into a 5,648-session
    // "project". A real repo that happens to contain scratch dirs (arborist
    // holds its bench workspaces) is exempt: it has a git root.
    const clean = (s: string) => s.replace(/\/+$/, '');
    const pathed = dbRows.filter((r) => r.path);
    const allPaths = pathed.map((r) => clean(r.path as string));
    const childCount = countPathChildren(allPaths);
    // Scratch space: never a project, never a parent of one, and never kept as
    // a row. It folds into the repo its name identifies, or it is dropped.
    const ephemeral = new Set<string>();
    for (const r of dbRows) {
      // A fleet worker's directory is where one run of one agent happened, not
      // a project. Treated exactly like /tmp: it folds into whatever owns the
      // directory above it, or it is left off the list. Its sessions and
      // messages are untouched and still queryable everywhere else.
      if (isEphemeralPath(r.path) || isWorkspacePath(r.path)) ephemeral.add(r.name);
    }
    for (const n of ephemeral) repoNames.delete(n);

    const containers = new Set<string>();
    for (const r of pathed) {
      if (ephemeral.has(r.name)) continue;
      if (r.is_repo) continue;                       // a git root is never a container
      const self = clean(r.path as string);
      if ((childCount.get(self) ?? 0) >= 2) containers.add(r.name);
    }

    // A project can be a real working directory without being a git root —
    // ~/git/contra has nine uncloseai sessions and no .git yet. It counts as
    // top-level when nothing except a container contains it. Agent scratch
    // dirs fail this because their repo's path is an ancestor
    // (/home/fox/git/arborist/bench/... lives under /home/fox/git/arborist).
    const containerPaths = new Set(
      pathed.filter((r) => containers.has(r.name)).map((r) => clean(r.path as string)),
    );
    // Promotion candidates are judged against the repos we already trust,
    // never against each other.
    const baseFoldTargets = new Set([...repoNames].filter((n) => !containers.has(n)));
    for (const r of pathed) {
      if (repoNames.has(r.name) || ephemeral.has(r.name)) continue;
      const self = clean(r.path as string);
      const nested = allPaths.some(
        (q) => q.length < self.length && self.startsWith(`${q}/`) && !containerPaths.has(q),
      );
      if (nested) continue;
      // Living directly under a container is not enough on its own. A
      // /tmp/claude-1000--home-fox-git-uncloseai-cli-<uuid>-scratchpad sits
      // under /tmp exactly like ~/git/contra sits under ~/git, but it names
      // the repo it belongs to and should fold there instead of being
      // promoted beside it.
      if (rollupTarget(r.name, baseFoldTargets)) continue;
      repoNames.add(r.name);
    }

    // Containers keep their own row but may not swallow anyone.
    const foldTargets = new Set([...repoNames].filter((n) => !containers.has(n)));

    // Identity fold. `projects` is scoped per harness slot by design, so one
    // repo can hold several rows — `-home-fox-git-uncloseai-cli`,
    // `arborist:-home-fox-git-uncloseai-cli` and
    // `uncloseai:home-fox-git-uncloseai-cli` all carry root commit 527c965.
    // That separation is right for ingestion and wrong for a project list,
    // where it renders as the same repo listed three times. Rows sharing a
    // root commit collapse onto one canonical name, preferring the row that
    // has a Claude directory, then the shortest (harness-prefixed names are
    // strictly longer than the bare one).
    const canonicalByHash = new Map<string, string>();
    for (const r of dbRows) {
      if (!r.root_commit_hash) continue;
      const cur = canonicalByHash.get(r.root_commit_hash);
      if (!cur) { canonicalByHash.set(r.root_commit_hash, r.name); continue; }
      const curIsFs = fsProjects.some((p) => p.name === cur);
      const newIsFs = fsProjects.some((p) => p.name === r.name);
      if ((newIsFs && !curIsFs) || (newIsFs === curIsFs && r.name.length < cur.length)) {
        canonicalByHash.set(r.root_commit_hash, r.name);
      }
    }
    const canonicalName = (r: { name: string; root_commit_hash: string | null }) =>
      (r.root_commit_hash && canonicalByHash.get(r.root_commit_hash)) || r.name;

    const byName = new Map<string, ProjectInfo>();
    for (const p of fsProjects) byName.set(p.name, p);

    // Several DB rows can now land on one canonical name, so their counts SUM
    // rather than max. Tracked separately from the filesystem numbers so the
    // two sources never double-count each other.
    const dbSeen = new Set<string>();
    for (const r of dbRows) {
      const key = canonicalName(r);
      const harnesses = (r.harnesses ?? '').split(',').filter(Boolean);
      const existing = byName.get(key);
      if (existing) {
        // First DB row for this project replaces the stale filesystem counts;
        // later rows (other harness slots on the same repo) add to them.
        if (dbSeen.has(key)) {
          existing.sessionCount += r.sessions;
          existing.totalMessages += r.messages;
          addTokens(existing, r);
        } else {
          existing.sessionCount = r.sessions;
          existing.totalMessages = r.messages;
          existing.tokens = zeroTokens();
          addTokens(existing, r);
          dbSeen.add(key);
        }
        existing.latestActivity = newerOf(existing.latestActivity, r.latest ?? '');
        existing.harnesses = Array.from(new Set([...(existing.harnesses ?? []), ...harnesses]));
        if (!existing.path && r.path) existing.path = r.path;
      } else {
        dbSeen.add(key);
        byName.set(key, {
          name: key,
          displayName: decodeProjectName(key),
          path: r.path ?? '',
          sessionCount: r.sessions,
          totalMessages: r.messages,
          tokens: tokensOf(r),
          latestActivity: r.latest ?? '',
          hasMemory: false,
          harnesses,
          foldedCount: 0,
        });
      }
    }

    // Path fold, before the name fold. A fleet worker's encoded name carries a
    // run id and a uuid that its repo's name never contains, so `rollupTarget`
    // can never place it; its path can. Folding here keeps a worker's sessions
    // and tokens on the repo that owns the directory, instead of dropping them
    // with the row.
    const foldablePaths = dbRows
      .filter((r) => r.path && !ephemeral.has(r.name) && repoNames.has(canonicalName(r)))
      .map((r) => ({ name: canonicalName(r), path: clean(r.path as string) }));
    const pathFold = new Map<string, string>();
    for (const r of dbRows) {
      if (!ephemeral.has(r.name) || !r.path) continue;
      const parent = ancestorByPath(clean(r.path), foldablePaths);
      if (parent && parent !== r.name) pathFold.set(r.name, parent);
    }

    const merged = Array.from(byName.values());
    // unmatched:'drop' — a row that is neither a git root nor inside one is an
    // ephemeral container (unsandbox `sandbox-*`, `uncloseai:tmp-*`), not a
    // project. Keeping them turned this list into 2,166 entries where ~100 are
    // real. Their sessions are untouched and still queryable everywhere else.
    const mergeInto = (repo: ProjectInfo, child: ProjectInfo) => {
      repo.latestActivity = newerOf(repo.latestActivity, child.latestActivity);
      repo.sessionCount += child.sessionCount;
      repo.totalMessages += child.totalMessages;
      if (child.tokens) {
        repo.tokens = repo.tokens ?? zeroTokens();
        repo.tokens.input += child.tokens.input;
        repo.tokens.output += child.tokens.output;
        repo.tokens.cacheRead += child.tokens.cacheRead;
        repo.tokens.cacheWrite += child.tokens.cacheWrite;
      }
      repo.foldedCount = (repo.foldedCount ?? 0) + 1 + (child.foldedCount ?? 0);
      repo.harnesses = Array.from(new Set([...(repo.harnesses ?? []), ...(child.harnesses ?? [])]));
    };

    let pathFolded = 0;
    const afterPathFold: ProjectInfo[] = [];
    for (const row of merged) {
      const parentName = pathFold.get(row.name);
      const parent = parentName ? byName.get(parentName) : undefined;
      if (parent && parent !== row) { mergeInto(parent, row); pathFolded++; continue; }
      afterPathFold.push(row);
    }

    const { rows, orphans } = rollupProjects(afterPathFold, repoNames, (repo, child) => {
      repo.latestActivity = newerOf(repo.latestActivity, child.latestActivity);
      repo.sessionCount += child.sessionCount;
      repo.totalMessages += child.totalMessages;
      if (child.tokens) {
        repo.tokens = repo.tokens ?? zeroTokens();
        repo.tokens.input += child.tokens.input;
        repo.tokens.output += child.tokens.output;
        repo.tokens.cacheRead += child.tokens.cacheRead;
        repo.tokens.cacheWrite += child.tokens.cacheWrite;
      }
      repo.foldedCount = (repo.foldedCount ?? 0) + 1 + (child.foldedCount ?? 0);
      repo.harnesses = Array.from(new Set([...(repo.harnesses ?? []), ...(child.harnesses ?? [])]));
    }, { unmatched: 'drop', foldTargets });

    if (orphans.length || pathFolded) {
      console.log(`[projects] ${pathFolded} workspace row(s) folded by path, ${orphans.length} ephemeral row(s) dropped (no containing repo)`);
    }

    rows.sort((a, b) => b.latestActivity.localeCompare(a.latestActivity));

    return rows;
    } catch (err) {
      throw err instanceof Error ? err : new Error(String(err));
    }
  }
}


/** Build and store. The worker calls this. */
export async function refreshProjectList(db: Database.Database = getDb()): Promise<ProjectInfo[]> {
  const rows = await buildProjectList();
  setSetting(PROJECT_LIST_KEY, JSON.stringify(rows));
  setSetting(PROJECT_LIST_AT, new Date().toISOString());
  void db;
  return rows;
}

/** The stored list when it is fresh enough, else null. */
export function readProjectList(maxAgeMs = 5 * 60_000): { rows: ProjectInfo[]; at: string } | null {
  const raw = getSetting(PROJECT_LIST_KEY);
  const at = getSetting(PROJECT_LIST_AT);
  if (!raw || !at) return null;
  if (Date.now() - Date.parse(at) > maxAgeMs) return null;
  try {
    return { rows: JSON.parse(raw), at };
  } catch {
    return null;
  }
}
