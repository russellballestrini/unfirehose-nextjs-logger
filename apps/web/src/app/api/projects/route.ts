import { readdir, readFile, stat } from 'fs/promises';
import { claudePaths } from '@unturf/unfirehose/claude-paths';
import { decodeProjectName, resolveProjectPath } from '@unturf/unfirehose/project-name';
import { getDb } from '@unturf/unfirehose/db/schema';
import { rollupProjects, rollupTarget, newerOf, isEphemeralPath } from '@unturf/unfirehose/project-rollup';
import { NextResponse } from 'next/server';
import type { ProjectInfo, SessionsIndex } from '@unturf/unfirehose/types';
import { Timing } from '@/lib/timing';

// In-memory cache — 30s TTL
let cache: { data: ProjectInfo[]; ts: number } | null = null;
const CACHE_TTL = 30_000;

// This route used to build its whole answer from readdir(~/.claude/projects).
// That made the list Claude-Code-only: uncloseai, fetch and agnt sessions land
// in SQLite under harness-scoped names with no directory of their own, so they
// could never appear here and could never reorder the page. Measured
// 2026-08-25: 461 projects active in 24h, 456 of them invisible to this route.
//
// It also sorted on `sessions-index.json`, which Claude Code stopped updating —
// every project's index was frozen at 2026-06-09/11, two and a half months
// stale. The page only looked correct because the client shadowed that field
// with DB-backed activity.
//
// The database sees every harness, so it is the source of truth now. The
// filesystem is still read, because a project can have a directory before it
// has ingested rows, but it no longer bounds what we can show.

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
  latest: string | null;
  harnesses: string | null;
}

export async function GET() {
  const t = new Timing();
  if (cache && Date.now() - cache.ts < CACHE_TTL) {
    t.mark('cache');
    return NextResponse.json(cache.data, { headers: { 'Server-Timing': t.header() } });
  }

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
                 MAX(COALESCE(msg.latest_msg, ''), COALESCE(sess.latest, '')) AS latest,
                 sess.harnesses                    AS harnesses
            FROM projects p
            JOIN sess ON sess.project_id = p.id
            LEFT JOIN msg ON msg.project_id = p.id
        `).all() as DbRow[];
      }),
    ]);
    t.mark('load');

    const pathByName = new Map<string, string>();
    for (const r of dbRows) {
      if (r.path) pathByName.set(r.name, r.path);
    }
    const fsProjects = (await Promise.all(
      fsDirs.map((d) => loadOneFsProject(d, pathByName.get(d))),
    )).filter(Boolean) as ProjectInfo[];
    t.mark('load_fs');

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
    const childCount = new Map<string, number>();
    for (const p of allPaths) {
      for (const q of allPaths) {
        if (q.length < p.length && p.startsWith(`${q}/`)) {
          childCount.set(q, (childCount.get(q) ?? 0) + 1);
        }
      }
    }
    // Scratch space: never a project, never a parent of one, and never kept as
    // a row. It folds into the repo its name identifies, or it is dropped.
    const ephemeral = new Set<string>();
    for (const r of dbRows) {
      if (isEphemeralPath(r.path)) ephemeral.add(r.name);
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
        } else {
          existing.sessionCount = r.sessions;
          existing.totalMessages = r.messages;
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
          latestActivity: r.latest ?? '',
          hasMemory: false,
          harnesses,
          foldedCount: 0,
        });
      }
    }

    const merged = Array.from(byName.values());
    // unmatched:'drop' — a row that is neither a git root nor inside one is an
    // ephemeral container (unsandbox `sandbox-*`, `uncloseai:tmp-*`), not a
    // project. Keeping them turned this list into 2,166 entries where ~100 are
    // real. Their sessions are untouched and still queryable everywhere else.
    const { rows, orphans } = rollupProjects(merged, repoNames, (repo, child) => {
      repo.latestActivity = newerOf(repo.latestActivity, child.latestActivity);
      repo.sessionCount += child.sessionCount;
      repo.totalMessages += child.totalMessages;
      repo.foldedCount = (repo.foldedCount ?? 0) + 1 + (child.foldedCount ?? 0);
      repo.harnesses = Array.from(new Set([...(repo.harnesses ?? []), ...(child.harnesses ?? [])]));
    }, { unmatched: 'drop', foldTargets });
    t.mark('rollup');

    if (orphans.length) {
      console.log(`[projects] ${orphans.length} ephemeral project row(s) dropped (no containing repo)`);
    }

    rows.sort((a, b) => b.latestActivity.localeCompare(a.latestActivity));
    t.mark('sort');

    cache = { data: rows, ts: Date.now() };
    return NextResponse.json(rows, { headers: { 'Server-Timing': t.header() } });
  } catch (err) {
    return NextResponse.json(
      { error: 'Failed to list projects', detail: String(err) },
      { status: 500 }
    );
  }
}
