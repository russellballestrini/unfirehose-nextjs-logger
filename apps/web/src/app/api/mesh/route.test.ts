import { describe, it, expect, beforeEach, vi } from 'vitest';

/**
 * The mesh summary: every node at once, and the totals across them.
 *
 * Probing a node is an ssh round trip, so this route is mostly about not
 * doing that — every node is probed in parallel rather than in turn, and a
 * result is served from cache while a refresh runs behind it. A page that
 * waited for the slowest node would take as long as the sleepiest machine
 * on the mesh.
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
});
vi.mock('@/lib/local-stats', () => ({ getLocalStats: () => local() }));

/** What each remote host answers with, or an error. */
let remotes: Record<string, Record<string, unknown> | Error>;
let probeOrder: string[];
let inFlight: number;
let maxInFlight: number;

vi.mock('child_process', () => ({
  execSync: () => 'neoblanka\n',
  execFile: (_c: string, args: string[], _o: unknown, cb: (e: Error | null, out: string) => void) => {
    const host = args.find(a => remotes[a] !== undefined) ?? '';
    probeOrder.push(host);
    inFlight++; maxInFlight = Math.max(maxInFlight, inFlight);
    setTimeout(() => {
      inFlight--;
      const r = remotes[host];
      if (r instanceof Error) cb(r, '');
      else cb(null, 'ok');
    }, 10);
    return { on() {}, kill() {} };
  },
}));

const { GET } = await import('./route');
const get = (query = '') =>
  GET({ nextUrl: { searchParams: new URLSearchParams(query) } } as never);

beforeEach(() => {
  nodes = ['localhost'];
  remotes = {}; probeOrder = []; inFlight = 0; maxInFlight = 0;
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
