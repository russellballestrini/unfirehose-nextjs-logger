/**
 * Deciding which rows in `projects` are actually projects.
 *
 * Our `projects` table holds a row for every directory any harness has ever
 * run in: git roots, agent scratch directories, fleet-worker workspaces,
 * `/tmp`, `~/git`. Rendered raw that is 2,166 entries where about a hundred
 * are real. These rules cut it down, and every one of them exists because a
 * specific wrong list shipped:
 *
 *  - a repo is a git root, not merely a row with a path — 1,352 rows carry a
 *    path and are scratch directories inside a repo;
 *  - `~/git` and `/tmp` are tracked projects AND the parents of dozens of
 *    unrelated ones, so they keep a row but may not swallow anybody;
 *  - a directory can be real work without being a git root (`~/git/contra`
 *    has nine sessions and no `.git` yet), so nesting is what disqualifies,
 *    not the absence of a commit;
 *  - a scratch path that names its own repo folds there rather than being
 *    promoted beside it.
 *
 * This lived inside a 275-line function that also ran two SQL aggregates and
 * a filesystem walk, so none of it could be tested without a database. It is
 * pure: rows in, sets out.
 */

import { rollupTarget, isEphemeralPath, isWorkspacePath, countPathChildren } from './project-rollup';

export interface ClassifyRow {
  name: string;
  path: string | null;
  is_repo: number;
}

export interface Classification {
  /** Names that get a row of their own. */
  repoNames: Set<string>;
  /** Directories that hold many unrelated projects. They keep a row; they absorb nobody. */
  containers: Set<string>;
  /** Scratch space: never a project, never a parent of one, never kept. */
  ephemeral: Set<string>;
  /** Who a folded row is allowed to fold into — repos, minus containers. */
  foldTargets: Set<string>;
}

/** Trailing slashes make two spellings of one directory look like two. */
export const cleanPath = (s: string) => s.replace(/\/+$/, '');

/** How many other tracked paths sit directly inside this one. */
const CONTAINER_MIN_CHILDREN = 2;

export function classifyProjectRows(rows: ClassifyRow[], fsNames: Set<string>): Classification {
  // A directory on disk under ~/.claude is a project by definition: some
  // harness kept a transcript there.
  const repoNames = new Set<string>(fsNames);
  for (const r of rows) if (r.is_repo) repoNames.add(r.name);

  // A fleet worker's directory is where one run of one agent happened. It is
  // treated exactly like /tmp — folded into whatever owns the directory
  // above it, or left off. Its sessions and messages are untouched and stay
  // queryable everywhere else.
  const ephemeral = new Set<string>();
  for (const r of rows) {
    if (isEphemeralPath(r.path) || isWorkspacePath(r.path)) ephemeral.add(r.name);
  }
  for (const n of ephemeral) repoNames.delete(n);

  const pathed = rows.filter((r) => r.path);
  const allPaths = pathed.map((r) => cleanPath(r.path as string));
  const childCount = countPathChildren(allPaths);

  const containers = new Set<string>();
  for (const r of pathed) {
    if (ephemeral.has(r.name) || r.is_repo) continue;   // a git root is never a container
    if ((childCount.get(cleanPath(r.path as string)) ?? 0) >= CONTAINER_MIN_CHILDREN) {
      containers.add(r.name);
    }
  }

  const containerPaths = new Set(
    pathed.filter((r) => containers.has(r.name)).map((r) => cleanPath(r.path as string)),
  );

  // Promotion. Candidates are judged against the repos we already trust,
  // never against each other.
  const baseFoldTargets = new Set([...repoNames].filter((n) => !containers.has(n)));
  for (const r of pathed) {
    if (repoNames.has(r.name) || ephemeral.has(r.name)) continue;
    const self = cleanPath(r.path as string);
    // Sitting inside another tracked path disqualifies — unless that path is
    // a container, which contains everybody and means nothing.
    const nested = allPaths.some(
      (q) => q.length < self.length && self.startsWith(`${q}/`) && !containerPaths.has(q),
    );
    if (nested) continue;
    // Living directly under a container is not enough on its own. A
    // /tmp/claude-1000--home-fox-git-uncloseai-cli-<uuid>-scratchpad sits
    // under /tmp exactly as ~/git/contra sits under ~/git, but it names the
    // repo it belongs to and folds there instead of standing beside it.
    if (rollupTarget(r.name, baseFoldTargets)) continue;
    repoNames.add(r.name);
  }

  return {
    repoNames,
    containers,
    ephemeral,
    foldTargets: new Set([...repoNames].filter((n) => !containers.has(n))),
  };
}
