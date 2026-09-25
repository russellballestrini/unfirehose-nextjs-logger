/**
 * Journals a fleet writes outside any home directory.
 *
 * A fleet worker runs with HOME bound into its run directory —
 * `<mission>/results/<run>/fleet/workers/worker_00N/home` — so its
 * harnesses journal under `<that home>/.uncloseai/unfirehose` and
 * `<that home>/.arborist/unfirehose`, where the homedir scan never
 * looks. On one laptop that was 3,433 worker homes and 20,808 journals
 * (690 MB) the dashboard had never seen (2026-09-16). This finds them
 * three ways, none of them requiring configuration on a normal box:
 *
 *   1. `UNFIREHOSE_FLEET_ROOTS` — `:`/`,`-separated mission roots; each
 *      is globbed for `<mission>/results/<run>/fleet/workers/<worker>/home`. Defaults to
 *      arborist's bench missions dir when it exists.
 *   2. `~/.uncloseai/firehose-roots.json` — the journal roots uncloseai-cli
 *      itself remembers from live processes (its /firehose discovery),
 *      so a fleet under a private HOME anywhere is found the moment a
 *      worker has run.
 *   3. every dot-dir sibling of a found root's home, so `.arborist`
 *      comes with `.uncloseai`.
 *
 * These roots are ingested each pass but never fs-watched: thousands of
 * recursive watchers would exhaust inotify, and the poll finds them.
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'fs';
import { homedir } from 'os';
import path from 'path';

export interface FleetHarness {
  name: string;
  root: string;
  home: string;
}

const EXCLUDED = new Set(['unfirehose', 'claude', 'fetch']);

function isDir(p: string): boolean {
  try { return statSync(p).isDirectory(); } catch { return false; }
}

function listDirs(p: string): string[] {
  try { return readdirSync(p).map((e) => path.join(p, e)).filter(isDir); } catch { return []; }
}

/**
 * Every seat home under a mission root that exists:
 *
 *   `<root>/<mission>/results/<run>/fleet/workers/<worker>/home` — this host's seats
 *   `<root>/<mission>/results/<run>/fleet/telemetry/replicated/<member>/home` — other
 *     hosts' seats, their harness logs replicated over the mesh byte-exact and
 *     reassembled with the same inside layout, so they ingest like local homes.
 *
 * A run without either directory contributes nothing.
 */
export function workerHomesUnder(root: string): string[] {
  const homes: string[] = [];
  for (const mission of listDirs(root)) {
    for (const run of listDirs(path.join(mission, 'results'))) {
      const seats = [
        ...listDirs(path.join(run, 'fleet', 'workers')),
        ...listDirs(path.join(run, 'fleet', 'telemetry', 'replicated')),
      ];
      for (const seat of seats) {
        const home = path.join(seat, 'home');
        if (isDir(home)) homes.push(home);
      }
    }
  }
  return homes;
}

/** The harness journal roots under one home: `<home>/.<name>/unfirehose`. */
export function harnessRootsInHome(home: string): FleetHarness[] {
  const out: FleetHarness[] = [];
  let entries: string[] = [];
  try { entries = readdirSync(home); } catch { return out; }
  for (const entry of entries) {
    if (!entry.startsWith('.')) continue;
    const name = entry.slice(1);
    if (!name || EXCLUDED.has(name)) continue;
    const root = path.join(home, entry, 'unfirehose');
    if (isDir(root)) out.push({ name, root, home });
  }
  return out;
}

export function fleetRootsFromEnv(env = process.env): string[] {
  const raw = env.UNFIREHOSE_FLEET_ROOTS;
  if (raw !== undefined) {
    return raw.split(/[:,]/).map((s) => s.trim()).filter(Boolean).map((s) => s.replace(/^~/, homedir()));
  }
  const dflt = path.join(homedir(), 'git', 'arborist', 'bench', 'missions');
  return existsSync(dflt) ? [dflt] : [];
}

/** Roots uncloseai-cli remembered from live processes: `{ "<root>": <ts> }`. */
export function rememberedRoots(file = path.join(homedir(), '.uncloseai', 'firehose-roots.json')): string[] {
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>;
    return Object.keys(parsed).filter((k) => k.endsWith('/unfirehose'));
  } catch { return []; }
}

/**
 * Every fleet harness root on this box, deduplicated, homes outside
 * the user's own home only (that one the homedir scan already covers).
 */
export function discoverFleetHarnesses(env = process.env, rootsFile?: string): FleetHarness[] {
  const ownHome = homedir();
  const homes = new Set<string>();
  for (const root of fleetRootsFromEnv(env)) for (const h of workerHomesUnder(root)) homes.add(h);
  for (const root of rememberedRoots(rootsFile)) {
    // <home>/.<name>/unfirehose → <home>
    const home = path.dirname(path.dirname(root));
    if (isDir(home)) homes.add(home);
  }
  homes.delete(ownHome);
  const out: FleetHarness[] = [];
  const seen = new Set<string>();
  for (const home of [...homes].sort()) {
    for (const h of harnessRootsInHome(home)) {
      if (seen.has(h.root)) continue;
      seen.add(h.root);
      out.push(h);
    }
  }
  return out;
}
