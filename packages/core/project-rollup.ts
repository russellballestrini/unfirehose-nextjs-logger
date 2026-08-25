// Roll ephemeral project rows up into the repo they belong to.
//
// Every harness identifies a project by encoded filesystem path, and agents
// that run inside scratch directories therefore mint a project row per
// workspace. One arborist bench mission produced 453 of them in a day:
//
//   uncloseai:home-fox-git-arborist-bench-missions-vault_challenge_2_mesh-
//     results-2026-08-25_0c293c9-fleet-workers-worker_008-workspace-
//     agent_worker_008_b_grszvv
//
// Those are real sessions doing real work, but they are not 453 projects.
// They are arborist. Listing them individually buries every actual repo;
// dropping them loses the signal that arborist was busy. So we fold: the
// activity counts, attributed to the repo that contains it.
//
// Folding is by NAME PREFIX, not by path. The ephemeral rows carry no `path`
// or `last_cwd_seen` — only the encoded name records where they lived.

/** Strip a harness prefix: `uncloseai:home-fox-git-x` -> `home-fox-git-x`. */
export function stripHarness(projectName: string): { harness: string | null; slug: string } {
  const i = projectName.indexOf(':');
  if (i === -1) return { harness: null, slug: projectName };
  return { harness: projectName.slice(0, i), slug: projectName.slice(i + 1) };
}

/** Encoded names sometimes carry a leading '-', sometimes not. Normalize. */
function normalizeSlug(slug: string): string {
  return slug.replace(/^-+/, '');
}

/**
 * Longest known repo whose encoded name prefixes this project, matched on a
 * '-' boundary so `home-fox-git-un` cannot swallow `home-fox-git-unfirehose`.
 *
 * Returns the repo's name exactly as it was supplied in `repoNames`, or null
 * when nothing contains this project.
 */
export function rollupTarget(projectName: string, repoNames: Iterable<string>): string | null {
  const { slug } = stripHarness(projectName);
  const target = normalizeSlug(slug);
  if (!target) return null;

  let best: string | null = null;
  let bestLen = -1;
  // Second-choice match: the repo name appears inside the project name rather
  // than at its head. Agent scratch dirs under /tmp look like
  // `tmp-claude-1000--home-fox-git-uncloseai-cli-<uuid>-scratchpad`, where the
  // repo is embedded mid-string. Only used when no prefix match exists, so a
  // genuine prefix always wins.
  let inner: string | null = null;
  let innerLen = -1;

  for (const repo of repoNames) {
    const r = normalizeSlug(stripHarness(repo).slug);
    if (!r || r.length > target.length) continue;

    if (target.startsWith(r)) {
      // Boundary check: exact match, or the next character starts a new segment.
      if (target.length !== r.length && target[r.length] !== '-') continue;
      if (r.length > bestLen) { bestLen = r.length; best = repo; }
      continue;
    }

    const at = target.indexOf(`-${r}-`);
    if (at !== -1 && r.length > innerLen) { innerLen = r.length; inner = repo; }
  }
  return best ?? inner;
}

export interface RollupInput {
  name: string;
  latestActivity: string;
  sessionCount: number;
  totalMessages: number;
}

export interface RollupResult<T extends RollupInput> {
  /** The surviving repo rows, each absorbing its children's activity. */
  rows: T[];
  /** project name -> repo name it was folded into. */
  foldedInto: Map<string, string>;
  /** Rows that were neither a repo nor foldable into one. */
  orphans: T[];
}

export interface RollupOptions {
  /**
   * What to do with a row that is not a repo and matches no repo.
   *
   * 'keep'  — list it anyway. Honest, but on this dataset it means 2,000+
   *           throwaway sandbox containers drowning ~100 real repos.
   * 'drop'  — leave it off the list. Its sessions still exist and are still
   *           queryable everywhere else; it simply is not a project.
   */
  unmatched?: 'keep' | 'drop';
  /**
   * Repos that may ABSORB others. Defaults to `repoNames`.
   *
   * Split from `repoNames` because a row can deserve a place on the list
   * without deserving to swallow its neighbours. `~/git` and `/tmp` are the
   * cases that forced this: both are tracked projects in their own right, and
   * both are parent directories of dozens of unrelated projects, so allowing
   * either to absorb by path or name prefix silently ate `~/git/contra`.
   */
  foldTargets?: Set<string>;
}

/**
 * Fold `all` into `repos`.
 *
 * A row whose name is itself a repo stays. A row that rolls up into a repo
 * contributes its session count, message count, and — the reason this exists —
 * its recency, so a repo sorts by the last time ANY harness worked in it.
 *
 * Rows that match no repo are kept as-is: better a stray entry than silently
 * losing work that happened.
 */
export function rollupProjects<T extends RollupInput>(
  all: T[],
  repoNames: Set<string>,
  merge: (repo: T, child: T) => void,
  opts: RollupOptions = {},
): RollupResult<T> {
  const keepUnmatched = (opts.unmatched ?? 'keep') === 'keep';
  const foldTargets = opts.foldTargets ?? repoNames;

  const byName = new Map<string, T>();
  for (const r of all) byName.set(r.name, r);

  const foldedInto = new Map<string, string>();
  const out: T[] = [];
  const orphans: T[] = [];

  const orphan = (row: T) => {
    orphans.push(row);
    if (keepUnmatched) out.push(row);
  };

  for (const row of all) {
    if (repoNames.has(row.name)) { out.push(row); continue; }

    const target = rollupTarget(row.name, foldTargets);
    if (!target || target === row.name) { orphan(row); continue; }

    const parent = byName.get(target);
    if (!parent) { orphan(row); continue; }

    foldedInto.set(row.name, target);
    merge(parent, row);
  }

  return { rows: out, foldedInto, orphans };
}

/**
 * Filesystem roots that never hold a project.
 *
 * `~/git` is project space: a directory under it is a project even without a
 * `.git` yet (`~/git/contra` had nine sessions and no git root). `/tmp` is not:
 * a directory under it is a scratch area belonging to whatever spawned it.
 * Both are "a tracked directory with many tracked children", so nothing about
 * their shape separates them — only what they mean. Hence a list.
 *
 * Anything under these folds into the repo its name identifies, or is left off
 * the project list entirely. Its sessions and messages are untouched.
 */
export const EPHEMERAL_PATH_ROOTS = [
  '/tmp',
  '/var/tmp',
  '/dev/shm',
  '/run',
];

export function isEphemeralPath(p: string | null | undefined): boolean {
  if (!p) return false;
  const s = p.replace(/\/+$/, '');
  return EPHEMERAL_PATH_ROOTS.some((root) => s === root || s.startsWith(`${root}/`));
}

/** Newest of two ISO timestamps, tolerating empty strings. */
export function newerOf(a: string, b: string): string {
  if (!a) return b;
  if (!b) return a;
  return a >= b ? a : b;
}
