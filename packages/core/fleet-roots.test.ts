import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import { discoverFleetHarnesses, fleetRootsFromEnv, harnessRootsInHome, rememberedRoots, workerHomesUnder } from './fleet-roots';

/**
 * A fleet worker journals under a HOME bound into its run directory,
 * where the homedir scan never looks. This lays out two runs of one
 * mission with three workers, one of them without a home, and checks
 * that every harness root under every worker home is found once.
 */
const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

function missions(): string {
  const root = mkdtempSync(path.join(tmpdir(), 'fleet-'));
  dirs.push(root);
  for (const run of ['2026-09-14_abc', '2026-09-15_def']) {
    for (const worker of ['worker_000', 'worker_001']) {
      const home = path.join(root, 'software_factory', 'results', run, 'fleet', 'workers', worker, 'home');
      mkdirSync(path.join(home, '.uncloseai', 'unfirehose', 'home-user-proj'), { recursive: true });
      mkdirSync(path.join(home, '.arborist', 'unfirehose'), { recursive: true });
      mkdirSync(path.join(home, '.ssh'), { recursive: true });                 // no unfirehose: not a harness
      mkdirSync(path.join(home, '.unfirehose'), { recursive: true });          // excluded by name
      writeFileSync(path.join(home, '.uncloseai', 'unfirehose', 'home-user-proj', `${worker}-${run}.jsonl`), '{}\n');
    }
    mkdirSync(path.join(root, 'software_factory', 'results', run, 'fleet', 'workers', 'worker_002'), { recursive: true });
  }
  return root;
}

describe('fleet worker homes', () => {
  it('finds every worker home under a mission root, and nothing else', () => {
    const root = missions();
    const homes = workerHomesUnder(root);
    expect(homes).toHaveLength(4);
    expect(homes.every((h) => h.endsWith('/home'))).toBe(true);
    expect(workerHomesUnder(path.join(root, 'nope'))).toEqual([]);
  });

  it('finds other hosts\u2019 seat homes replicated over the mesh, laid out like a local worker home', () => {
    const root = missions();
    const run = path.join(root, 'software_factory', 'results', '2026-09-15_def', 'fleet');
    const home = path.join(run, 'telemetry', 'replicated', 'member_b', 'home');
    mkdirSync(path.join(home, '.uncloseai', 'unfirehose', 'home-user-proj'), { recursive: true });
    mkdirSync(path.join(home, '.uncloseai', 'telemetry'), { recursive: true });
    mkdirSync(path.join(run, 'telemetry', 'replicated', 'member_c'), { recursive: true });   // no home yet: nothing
    writeFileSync(path.join(run, 'telemetry', 'replicated', 'stray.jsonl'), '{}\n');         // a file, not a member
    const homes = workerHomesUnder(root);
    expect(homes).toHaveLength(5);
    expect(homes).toContain(home);
    expect(harnessRootsInHome(home)).toEqual([
      { name: 'uncloseai', root: path.join(home, '.uncloseai', 'unfirehose'), home },
    ]);
    // Found by the same discovery, zero configuration beyond the mission root.
    const found = discoverFleetHarnesses({ UNFIREHOSE_FLEET_ROOTS: root } as NodeJS.ProcessEnv, path.join(root, 'none.json'));
    expect(found.map((h) => h.home)).toContain(home);
  });

  it('lists the harness roots in a home: dot-dirs with an unfirehose child, minus the excluded names', () => {
    const root = missions();
    const [home] = workerHomesUnder(root);
    const found = harnessRootsInHome(home).map((h) => h.name).sort();
    expect(found).toEqual(['arborist', 'uncloseai']);
    expect(harnessRootsInHome(path.join(root, 'nope'))).toEqual([]);
  });

  it('reads mission roots from the environment, ~ expanded, or the arborist default', () => {
    expect(fleetRootsFromEnv({ UNFIREHOSE_FLEET_ROOTS: '/a:/b, ~/c' } as never))
      .toEqual(['/a', '/b', path.join(process.env.HOME!, 'c')]);
    expect(fleetRootsFromEnv({ UNFIREHOSE_FLEET_ROOTS: '' } as never)).toEqual([]);
  });

  it('reads the roots uncloseai-cli remembered from live processes', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'roots-'));
    dirs.push(root);
    const file = path.join(root, 'firehose-roots.json');
    writeFileSync(file, JSON.stringify({ '/x/home/.uncloseai/unfirehose': 1, '/y/not-a-root': 2 }));
    expect(rememberedRoots(file)).toEqual(['/x/home/.uncloseai/unfirehose']);
    expect(rememberedRoots(path.join(root, 'missing.json'))).toEqual([]);
  });

  it('discovers every root once across both sources, skipping the user’s own home', () => {
    const root = missions();
    // A remembered root that duplicates one from the glob, and one that is new.
    const extra = path.join(root, 'elsewhere', 'home');
    mkdirSync(path.join(extra, '.uncloseai', 'unfirehose'), { recursive: true });
    const [dupHome] = workerHomesUnder(root);
    const rootsFile = path.join(root, 'roots.json');
    writeFileSync(rootsFile, JSON.stringify({
      [path.join(dupHome, '.uncloseai', 'unfirehose')]: 1,
      [path.join(extra, '.uncloseai', 'unfirehose')]: 2,
      [path.join(process.env.HOME!, '.uncloseai', 'unfirehose')]: 3,     // own home: the homedir scan's job
    }));
    const found = discoverFleetHarnesses({ UNFIREHOSE_FLEET_ROOTS: root } as never, rootsFile);
    expect(found).toHaveLength(9);                                  // 4 homes × 2 harnesses + 1 remembered
    expect(new Set(found.map((f) => f.root)).size).toBe(9);
    expect(found.map((f) => f.name).filter((n) => n === 'uncloseai')).toHaveLength(5);
    expect(found.some((f) => f.root.startsWith(process.env.HOME! + '/.uncloseai'))).toBe(false);
  });
});
