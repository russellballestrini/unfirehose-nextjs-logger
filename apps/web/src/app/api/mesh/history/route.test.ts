import { describe, it, expect, beforeEach, vi } from 'vitest';
import { createTestDb } from '@unturf/unfirehose/test/db-helper';

/**
 * The mesh time series, written and read.
 *
 * Storage here is tiered: fifteen-second rows for twenty-eight days, then a
 * smoothed fifteen-minute roll-up kept forever. A request reaching past
 * that boundary has to span both, or a chart of the last three months
 * simply stops at twenty-eight days with no indication that it did.
 *
 * The write side has its own failure worth pinning: a node's agent count is
 * a total across harnesses, and reading only the claude field persisted a
 * zero for a node running five uncloseai agents.
 */

const db = createTestDb();
vi.mock('@unturf/unfirehose/db/schema', async (original) => ({
  ...(await original<Record<string, unknown>>()),
  getDb: () => db,
}));

const { GET, POST } = await import('./route');

const post = (nodes: unknown[]) => POST({ json: async () => ({ nodes }) } as never);
const get = (query = '') =>
  GET({ nextUrl: { searchParams: new URLSearchParams(query) } } as never);

const node = (over: Record<string, unknown> = {}) => ({
  hostname: 'neoblanka', reachable: true, cpuCores: 32,
  loadAvg: [1.2, 0.9, 0.7], memTotalGB: 64, memUsedGB: 18.5,
  powerWatts: 142.5, powerSource: 'rapl', claudeProcesses: 2, ...over,
});

/** Rows written at a chosen age, for reading back across the tier boundary. */
function seedAt(hoursAgo: number, hostname: string) {
  const ts = new Date(Date.now() - hoursAgo * 3600_000).toISOString().replace('T', ' ').slice(0, 19);
  db.prepare(`
    INSERT INTO mesh_snapshots (timestamp, hostname, cpu_cores, load_avg_1, load_avg_5,
      load_avg_15, mem_total_gb, mem_used_gb, power_watts, gpu_power_watts, power_source,
      claude_processes, agent_processes)
    VALUES (?, ?, 32, 1, 1, 1, 64, 20, 140, 0, 'rapl', 1, 1)
  `).run(ts, hostname);
}

beforeEach(() => {
  db.prepare('DELETE FROM mesh_snapshots').run();
});

describe('POST /api/mesh/history', () => {
  it('refuses an empty payload rather than recording a poll that saw nothing', async () => {
    // An empty array and a mesh that is entirely down look identical in the
    // chart; only one of them is worth a row.
    const res = await post([]);
    expect(res.status).toBe(400);
  });

  it('records a reachable node', async () => {
    expect(await (await post([node()])).json()).toEqual({ ok: true, recorded: 1 });
    const row = db.prepare('SELECT hostname, power_watts, load_avg_1 FROM mesh_snapshots').get();
    expect(row).toMatchObject({ hostname: 'neoblanka', power_watts: 142.5, load_avg_1: 1.2 });
  });

  it('skips a node it could not reach, rather than writing zeros for it', async () => {
    // A zero-watt row is indistinguishable from a node that is powered on
    // and idle, and it drags every average through the floor.
    const res = await post([node(), node({ hostname: 'cammy', reachable: false })]);
    expect(await res.json()).toEqual({ ok: true, recorded: 1 });
    expect(db.prepare('SELECT COUNT(*) c FROM mesh_snapshots').get()).toEqual({ c: 1 });
  });

  it('counts every harness, not just claude', async () => {
    // A node running five uncloseai agents and no claude used to persist a
    // zero here, so its work never appeared on any chart.
    await post([node({ claudeProcesses: 0, harnessCounts: { uncloseai: 5 } })]);
    const row = db.prepare('SELECT agent_processes, harness_counts FROM mesh_snapshots').get() as
      { agent_processes: number; harness_counts: string };
    expect(row.agent_processes).toBe(5);
    expect(JSON.parse(row.harness_counts)).toEqual({ uncloseai: 5 });
  });

  it('falls back to the claude count when no breakdown was sent', async () => {
    await post([node({ claudeProcesses: 3 })]);
    expect(db.prepare('SELECT agent_processes a FROM mesh_snapshots').get()).toEqual({ a: 3 });
  });

  it('defaults a missing reading to zero rather than refusing the whole poll', async () => {
    // One probe that came back short must not cost us the sample.
    await post([{ hostname: 'sparse', reachable: true }]);
    expect(db.prepare('SELECT power_watts w, cpu_cores c FROM mesh_snapshots').get())
      .toEqual({ w: 0, c: 0 });
  });
});

describe('GET /api/mesh/history', () => {
  it('answers with an empty series rather than nothing at all', async () => {
    const body = await (await get()).json();
    expect(body.timeline).toEqual([]);
    expect(body.hostnames).toEqual([]);
  });

  it('returns a point per sample and names every host seen', async () => {
    seedAt(1, 'neoblanka');
    seedAt(2, 'cammy');
    const body = await (await get('hours=24')).json();
    expect(body.hostnames.sort()).toEqual(['cammy', 'neoblanka']);
    expect(body.timeline.length).toBeGreaterThan(0);
  });

  it('leaves out a sample older than the window asked for', async () => {
    seedAt(50, 'neoblanka');
    expect((await (await get('hours=24')).json()).hostnames).toEqual([]);
  });

  it('narrows to one host when asked', async () => {
    seedAt(1, 'neoblanka');
    seedAt(1, 'cammy');
    expect((await (await get('hours=24&hostname=cammy')).json()).hostnames).toEqual(['cammy']);
  });

  it('reaches into the cold tier for a window past twenty-eight days', async () => {
    // The hot tier is deleted as it is rolled up. A query that only read it
    // would show a chart that stops dead at the retention boundary.
    seedAt(1, 'neoblanka');
    const old = new Date(Date.now() - 40 * 86400_000).toISOString().replace('T', ' ').slice(0, 19);
    db.prepare(`
      INSERT INTO mesh_snapshots_15m (timestamp, hostname, cpu_cores, load_avg_1, load_avg_5,
        load_avg_15, mem_total_gb, mem_used_gb, power_watts, gpu_power_watts, power_source,
        claude_processes, agent_processes, sample_count)
      VALUES (?, 'ancient', 8, 1, 1, 1, 16, 8, 60, 0, 'tdp', 0, 0, 60)
    `).run(old);

    const body = await (await get(`hours=${24 * 60}`)).json();
    expect(body.hostnames.sort()).toEqual(['ancient', 'neoblanka']);
  });

  it('does not pay for the cold tier on an ordinary request', async () => {
    seedAt(1, 'neoblanka');
    const body = await (await get('hours=24')).json();
    expect(body.hostnames).toEqual(['neoblanka']);
  });
});
