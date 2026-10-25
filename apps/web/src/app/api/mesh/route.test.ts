import { describe, it, expect, beforeEach, beforeAll, vi } from 'vitest';
import { tmpdir } from 'os';
import { join } from 'path';
import { createTestDb } from '@unturf/unfirehose/test/db-helper';

/** The fields these tests read off a node in our mesh payload. */
type MeshRow = { hostname: string; reachable: boolean };

/**
 * The mesh summary: every node at once, and the totals across them.
 *
 * Probing a node is an ssh round trip, so this route is mostly about not
 * doing that. The worker's sampler already asks every node every fifteen
 * seconds and writes what it hears to mesh_snapshots; the route serves the
 * newest row per node and ssh-es on the request thread only when no row is
 * fresh — the worker is down, or `?live=1` asked for it. A page that waited
 * for the slowest node would take as long as the sleepiest machine on the
 * mesh, and did: 4.7 s, measured 2026-10-14.
 *
 * The totals are the other half, and they count only what answered: adding
 * a node we could not reach means adding zeros, which reads as a machine
 * that is on and idle rather than one that is asleep.
 */

let nodes: string[];
vi.mock('@unturf/unfirehose/mesh', () => ({ discoverNodes: () => nodes }));

const local = () => ({
  hostname: 'neoblanka', reachable: true, cpuCores: 32, memTotalGB: 64, memUsedGB: 18,
  powerWatts: 140, gpuPowerWatts: 0, claudeProcesses: 2, harnessCounts: { claude: 2 },
  // Facts a snapshot row does not carry.
  cpuModel: 'EPYC 7443', cpuYear: 2021, uptimeSeconds: 86_400, gpuModel: 'RTX 3090', gpuMemTotalMB: 24_576,
});
vi.mock('@/lib/local-stats', () => ({ getLocalStats: () => local() }));

// A real in-memory database with the real schema, so a worker row is seeded
// the way the sampler writes it.
const db = createTestDb();
// ssh-mux reads UNFIREHOSE_DIR from the same module for its control sockets;
// a probe from a test must not reach into ~/.unfirehose.
vi.mock('@unturf/unfirehose/db/schema', () => ({
  getDb: () => db,
  UNFIREHOSE_DIR: join(tmpdir(), 'unfirehose-mesh-route-test'),
}));

/** What each remote host answers with, or an error. */
let remotes: Record<string, Record<string, unknown> | Error>;
let probeOrder: string[];
let inFlight: number;
let maxInFlight: number;
/** ssh round trips that have returned. */
let completed: number;
/** ssh's own exit 255: the box never answered, so no other speaker is tried. */
const down = () => Object.assign(new Error('Unreachable'), { code: 255 });

vi.mock('child_process', () => ({
  execSync: () => 'neoblanka\n',
  execFile: (_c: string, args: string[], _o: unknown, cb: (e: Error | null, out: string) => void) => {
    const host = args.find(a => remotes[a] !== undefined) ?? '';
    probeOrder.push(host);
    inFlight++; maxInFlight = Math.max(maxInFlight, inFlight);
    setTimeout(() => {
      inFlight--; completed++;
      const r = remotes[host];
      if (r instanceof Error) cb(r, '');
      else cb(null, 'ok');
    }, 10);
    return { on() {}, kill() {} };
  },
}));

let GET: Awaited<typeof import('./route')>['GET'];
({ GET } = await import('./route'));
const get = (query = '') =>
  GET({ nextUrl: { searchParams: new URLSearchParams(query) } } as never);

/** A row the sampler wrote for `hostname`, `ageSec` ago. */
function seedSnapshot(hostname: string, ageSec: number, over: Record<string, unknown> = {}) {
  const ts = new Date(Date.now() - ageSec * 1000).toISOString().replace('T', ' ').slice(0, 19);
  db.prepare(`
    INSERT INTO mesh_snapshots (timestamp, hostname, cpu_cores, load_avg_1, load_avg_5, load_avg_15,
      mem_total_gb, mem_used_gb, power_watts, gpu_power_watts, power_source, claude_processes,
      agent_processes, harness_counts)
    VALUES (@ts, @hostname, @cpu_cores, @load_avg_1, @load_avg_5, @load_avg_15, @mem_total_gb,
      @mem_used_gb, @power_watts, @gpu_power_watts, @power_source, @claude_processes,
      @agent_processes, @harness_counts)
  `).run({
    ts, hostname, cpu_cores: 8, load_avg_1: 1.5, load_avg_5: 1.2, load_avg_15: 0.9,
    mem_total_gb: 32, mem_used_gb: 10, power_watts: 45, gpu_power_watts: 0, power_source: 'rapl',
    claude_processes: 1, agent_processes: 1, harness_counts: '{"claude":1}', ...over,
  });
}

/** What the sampler stored about `hostname` with its last row, `ageSec` ago. */
function seedFacts(hostname: string, facts: Record<string, unknown>, opts: { uptime?: number; alias?: string; ageSec?: number } = {}) {
  const ts = new Date(Date.now() - (opts.ageSec ?? 0) * 1000).toISOString().replace('T', ' ').slice(0, 19);
  db.prepare(`INSERT INTO mesh_node_facts (hostname, facts, uptime_seconds, ssh_alias, observed_at) VALUES (?, ?, ?, ?, ?)`)
    .run(hostname, JSON.stringify(facts), opts.uptime ?? null, opts.alias ?? null, ts);
}

const settle = () => new Promise(r => setTimeout(r, 30));

beforeEach(() => {
  nodes = ['localhost'];
  remotes = {}; probeOrder = []; inFlight = 0; maxInFlight = 0; completed = 0;
  db.prepare('DELETE FROM mesh_snapshots').run();
  db.prepare('DELETE FROM mesh_node_facts').run();
});

describe('GET /api/mesh', () => {
  it('refuses a host that is not a hostname', async () => {
    // It goes into an ssh command line.
    const res = await get('host=cammy; rm -rf /');
    expect(res.status).toBe(400);
  });

  it('probes one node when asked for one, and skips the summary', async () => {
    // The worker uses this to stagger per-node samples; a summary of one
    // node would be mistaken for a summary of the mesh.
    const body = await (await get('host=localhost')).json();
    expect(body.nodes).toHaveLength(1);
    expect(body.summary).toBeUndefined();
  });

  it('adds up only the nodes that answered', async () => {
    const body = await (await get('')).json();
    expect(body.summary).toMatchObject({
      totalNodes: 1, reachableNodes: 1, totalCores: 32, totalPowerWatts: 140,
    });
  });

  it('counts every harness, and keeps the claude count meaning what it did', async () => {
    // totalClaudes is claude-only for callers that predate the other
    // fifteen harnesses; totalAgents is what a page should show.
    const body = await (await get('')).json();
    expect(body.summary).toMatchObject({
      totalClaudes: 2, totalAgents: 2, totalHarnessCounts: { claude: 2 },
    });
  });

  it('names this machine, so a page can tell which node it is on', async () => {
    expect((await (await get('')).json()).localHostname).toBe('neoblanka');
  });

  it('serves a second request from cache rather than probing again', async () => {
    // Every probe is an ssh round trip per node.
    await get('');
    const first = probeOrder.length;
    await get('');
    expect(probeOrder.length).toBe(first);
  });
});

describe('GET /api/mesh from the worker\'s snapshots', () => {
  // A route module that has never probed: no cache, no facts, no learned
  // hostnames. What a web process looks like right after it starts.
  beforeAll(async () => {
    vi.resetModules();
    ({ GET } = await import('./route'));
  });

  it('answers from snapshots at once, and probes nothing behind the answer', async () => {
    nodes = ['localhost', 'cammy.foxhop.net'];
    remotes = { 'cammy.foxhop.net': down() };
    seedSnapshot('neoblanka', 3);
    seedSnapshot('cammy.foxhop.net', 12, { cpu_cores: 16, load_avg_1: 2.5 });

    const res = await get('');
    expect(completed).toBe(0);
    expect(res.headers.get('X-Mesh-Source')).toBe('snapshots');
    const body = await res.json();
    expect(body.nodes.find((n: MeshRow) => n.hostname === 'cammy.foxhop.net')).toMatchObject({
      reachable: true, cpuCores: 16, loadAvg: [2.5, 1.2, 0.9], memTotalGB: 32,
    });
    expect(body.summary).toMatchObject({ totalNodes: 2, reachableNodes: 2, totalCores: 24 });

    // The facts used to come from a full probe this route ran behind its
    // answer, every five minutes. The sampler stores them now.
    await settle();
    expect(probeOrder).toEqual([]);
  });

  it('lays the facts the sampler stored under its rows, from the first request a fresh process serves', async () => {
    // This module has never probed: what a web process looks like right
    // after it starts. CPU model, disks and TDP used to be missing for a poll.
    nodes = ['localhost', 'cammy.foxhop.net'];
    seedSnapshot('neoblanka', 3);
    seedSnapshot('cammy.foxhop.net', 20);
    seedFacts('neoblanka', { cpuModel: 'EPYC 7443', cpuYear: 2021, cpuTdpWatts: 200, spinningDisks: 2, ssdCount: 1, gpuModel: 'RTX 3090', gpuMemTotalMB: 24_576 }, { uptime: 86_400, ageSec: 60 });

    const res = await get('');
    const body = await res.json();
    expect(probeOrder).toEqual([]);
    expect(res.headers.get('X-Mesh-Source')).toBe('snapshots');
    // The answer rests on its oldest sample, and says so.
    const age = Date.now() - Date.parse(res.headers.get('X-Computed-At')!);
    expect(age).toBeGreaterThanOrEqual(19_000);
    expect(age).toBeLessThan(23_000);
    // What moves comes from the row; what does not comes from the stored
    // facts — and uptime kept counting since they were read.
    const me = body.nodes.find((n: MeshRow) => n.hostname === 'neoblanka');
    expect(me).toMatchObject({ cpuModel: 'EPYC 7443', cpuYear: 2021, cpuTdpWatts: 200, spinningDisks: 2, ssdCount: 1, cpuCores: 8, memTotalGB: 32, memUsedGB: 10 });
    expect(me.uptimeSeconds).toBeGreaterThanOrEqual(86_460);
    // A sample that missed nvidia-smi keeps the card and its capacity — a
    // page decides the node has a GPU by them — but not a reading it lacks.
    expect(me).toMatchObject({ gpuModel: 'RTX 3090', gpuMemTotalMB: 24_576 });
    expect(me.gpuUtil).toBeUndefined();
  });

  it('finds a box whose alias differs from the name it answers with, by the alias the sampler stored', async () => {
    // ryu: Host ai-3060.foxhop.net answers as ryu. Before any live probe in
    // this process, only the stored alias ties the two together.
    nodes = ['localhost', 'ai-3060.foxhop.net'];
    seedSnapshot('neoblanka', 3);
    seedSnapshot('ryu', 5);
    seedFacts('ryu', { cpuModel: 'i5-8400' }, { alias: 'ai-3060.foxhop.net' });
    const body = await (await get('')).json();
    expect(body.nodes.map((n: MeshRow) => [n.hostname, n.reachable])).toEqual([['neoblanka', true], ['ryu', true]]);
    expect(body.nodes[1].cpuModel).toBe('i5-8400');
  });

  it('lists nodes in ssh config order, whichever of them sampled first', async () => {
    // Order used to follow the timestamp scan: whichever host's sample was
    // oldest inside the window came first, and the sampler's phases rotate
    // against the window, so the fleet page re-shuffled its cards on every
    // reload. Seeded here oldest-first in reverse config order.
    nodes = ['localhost', 'cammy.foxhop.net', 'guile.foxhop.net', 'blanka.foxhop.net'];
    seedSnapshot('ghost.foxhop.net', 40);
    seedSnapshot('blanka.foxhop.net', 30);
    seedSnapshot('guile.foxhop.net', 20);
    seedSnapshot('cammy.foxhop.net', 10);
    seedSnapshot('neoblanka', 3);

    const body = await (await get('')).json();
    expect(body.nodes.map((n: MeshRow) => n.hostname)).toEqual([
      'neoblanka', 'cammy.foxhop.net', 'guile.foxhop.net', 'blanka.foxhop.net',
      // Still sampled, no longer configured: after the fleet, not shuffled into it.
      'ghost.foxhop.net',
    ]);
  });

  it('marks a node whose newest sample is old, rather than ssh-ing to it inline', async () => {
    nodes = ['localhost', 'cammy.foxhop.net', 'guile.foxhop.net'];
    seedSnapshot('neoblanka', 3);
    seedSnapshot('cammy.foxhop.net', 400);

    const body = await (await get('')).json();
    expect(probeOrder).toEqual([]);
    // The way a failed probe reports it, with when it was last heard from.
    const cammy = body.nodes.find((n: MeshRow) => n.hostname === 'cammy.foxhop.net');
    expect(cammy.reachable).toBe(false);
    expect(cammy.error).toMatch(/^Last sample .* ago$/);
    const guile = body.nodes.find((n: MeshRow) => n.hostname === 'guile.foxhop.net');
    expect(guile).toMatchObject({ reachable: false, error: 'No sample yet' });
    // Counted as present, not as answering: zeros would read as idle.
    expect(body.summary).toMatchObject({ totalNodes: 3, reachableNodes: 1, totalCores: 8 });
  });

  it('falls back to the inline probe when no snapshot is fresh', async () => {
    // The worker is down: every row is old. The old path answers.
    seedSnapshot('neoblanka', 400);
    const res = await get('');
    expect(['cache', 'live']).toContain(res.headers.get('X-Mesh-Source'));
    expect((await res.json()).nodes[0].cpuCores).toBe(32);
  });

  it('live=1 probes every node now, snapshots or not', async () => {
    nodes = ['localhost', 'cammy.foxhop.net'];
    remotes = { 'cammy.foxhop.net': down() };
    seedSnapshot('neoblanka', 3);
    seedSnapshot('cammy.foxhop.net', 3);

    const res = await get('live=1');
    expect(res.headers.get('X-Mesh-Source')).toBe('live');
    expect(probeOrder).toContain('cammy.foxhop.net');
    const body = await res.json();
    expect(body.nodes.find((n: MeshRow) => n.hostname === 'neoblanka').cpuCores).toBe(32);
    expect(body.nodes.find((n: MeshRow) => n.hostname === 'cammy.foxhop.net').reachable).toBe(false);
  });
});
