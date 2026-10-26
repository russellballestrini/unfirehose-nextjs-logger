import { describe, it, expect, beforeEach } from 'vitest';
import { createTestDb } from '../test/db-helper';
import { insertMeshSnapshots, readMeshFacts } from './mesh-snapshots';
import type { MeshNode } from '../mesh-probe';

/**
 * Writing mesh samples.
 *
 * This was the body of a route the worker POSTed to so the web server would
 * write a row into a database the worker already had open. Now both call it.
 */

const db = createTestDb();
const node = (over: Partial<MeshNode> & Record<string, unknown> = {}): MeshNode => ({
  hostname: 'cammy', reachable: true, cpuCores: 8, loadAvg: [1.5, 1.2, 0.9], memTotalGB: 32, memUsedGB: 10,
  powerWatts: 45, gpuPowerWatts: 0, powerSource: 'rapl', claudeProcesses: 1,
  ...over,
} as MeshNode);
const rows = () => db.prepare('SELECT * FROM mesh_snapshots ORDER BY id').all() as Array<Record<string, unknown>>;
beforeEach(() => { db.prepare('DELETE FROM mesh_snapshots').run(); db.prepare('DELETE FROM mesh_node_facts').run(); });

describe('insertMeshSnapshots', () => {
  it('writes one row per reachable node and says how many', () => {
    expect(insertMeshSnapshots(db, [node(), node({ hostname: 'blanka' })])).toBe(2);
    expect(rows().map((r) => r.hostname)).toEqual(['cammy', 'blanka']);
  });

  it('skips a node that did not answer, rather than writing zeros for it', () => {
    // A row of zeros for a down node reads as an idle machine forever after.
    expect(insertMeshSnapshots(db, [node({ hostname: 'gone', reachable: false })])).toBe(0);
    expect(rows()).toHaveLength(0);
  });

  it('carries the load triple and the power source through', () => {
    insertMeshSnapshots(db, [node()]);
    expect(rows()[0]).toMatchObject({ load_avg_1: 1.5, load_avg_5: 1.2, load_avg_15: 0.9, power_source: 'rapl', cpu_cores: 8 });
  });

  it('stores the energy counters beside the watts, as JSON and a number', () => {
    insertMeshSnapshots(db, [node({ cpuEnergy: [{ uj: 1100, max: 262143328850 }], gpuEnergyMj: 131346 })]);
    expect(rows()[0]).toMatchObject({ cpu_energy_json: '[{"uj":1100,"max":262143328850}]', gpu_energy_mj: 131346 });
    insertMeshSnapshots(db, [node({ hostname: 'nocounters' })]);
    expect(rows()[1]).toMatchObject({ cpu_energy_json: null, gpu_energy_mj: null });
  });

  it('counts agents across every harness, not only claude', () => {
    // A node with five uncloseai-cli agents and no claude used to persist
    // zero agents.
    insertMeshSnapshots(db, [node({ claudeProcesses: 0, harnessCounts: { 'uncloseai-cli': 5, aider: 2 } })]);
    const r = rows()[0];
    expect(r.agent_processes).toBe(7);
    expect(JSON.parse(String(r.harness_counts))).toEqual({ 'uncloseai-cli': 5, aider: 2 });
  });

  it('falls back to the claude count when no breakdown was reported', () => {
    insertMeshSnapshots(db, [node({ claudeProcesses: 3 })]);
    expect(rows()[0]).toMatchObject({ agent_processes: 3, harness_counts: null });
  });

  it('leaves GPU columns null, not zero, on a node with no GPU', () => {
    // Zero would chart as "a GPU doing nothing"; null charts as nothing.
    insertMeshSnapshots(db, [node()]);
    expect(rows()[0]).toMatchObject({ gpu_util: null, gpu_mem_used_mb: null, gpu_mem_total_mb: null });
  });

  it('writes all or nothing', () => {
    // One transaction: a bad node in the middle must not leave half a batch.
    const bad = node({ hostname: null as unknown as string });
    expect(() => insertMeshSnapshots(db, [node(), bad, node({ hostname: 'blanka' })])).toThrow();
    expect(rows()).toHaveLength(0);
  });
});

describe('mesh node facts', () => {
  it('keeps what a probe knew that a row cannot carry, one row per node, replaced by each sample', () => {
    insertMeshSnapshots(db, [node({ cpuModel: 'Xeon E5-2690', cpuTdpWatts: 135, spinningDisks: 2, ssdCount: 1, uptimeSeconds: 100 })]);
    insertMeshSnapshots(db, [node({ cpuModel: 'Xeon E5-2690', cpuTdpWatts: 135, spinningDisks: 3, ssdCount: 1, uptimeSeconds: 115 })]);
    const facts = readMeshFacts(db);
    expect([...facts.keys()]).toEqual(['cammy']);
    const f = facts.get('cammy')!;
    expect(f.facts).toEqual({ cpuModel: 'Xeon E5-2690', cpuTdpWatts: 135, spinningDisks: 3, ssdCount: 1 });
    expect(f.uptimeSeconds).toBe(115);
    expect(Math.abs(f.observedAt - Date.now())).toBeLessThan(5_000);
  });

  it('leaves earlier facts alone when a probe learned none, and writes none for a node that did not answer', () => {
    insertMeshSnapshots(db, [node({ cpuModel: 'Ryzen 9' })]);
    insertMeshSnapshots(db, [node(), node({ hostname: 'gone', reachable: false, cpuModel: 'x' })]);
    const facts = readMeshFacts(db);
    expect(facts.get('cammy')!.facts.cpuModel).toBe('Ryzen 9');
    expect(facts.has('gone')).toBe(false);
  });

  it('skips a row it cannot parse', () => {
    db.prepare("INSERT INTO mesh_node_facts (hostname, facts) VALUES ('torn', '{')").run();
    expect(readMeshFacts(db).has('torn')).toBe(false);
  });
});
