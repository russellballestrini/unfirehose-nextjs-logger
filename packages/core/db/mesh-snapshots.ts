/**
 * Append mesh samples.
 *
 * This was the body of POST /api/mesh/history, which existed so the worker
 * could hand the web server a row to write into a database the worker
 * already had open. It lives here now; the route and the worker both call
 * it, and the worker writes directly.
 *
 * Append-only. The worker's rollup tick folds 15s rows past the 28-day
 * boundary into mesh_snapshots_15m and deletes the source rows in the same
 * transaction; nothing here prunes.
 */
import type Database from 'better-sqlite3';
import type { MeshNode } from '../mesh-probe';

/**
 * Fields a snapshot row does not carry and a probe does. Kept per node in
 * mesh_node_facts, so a snapshot-served mesh has them from its first
 * request: they used to live only in the web process's memory, filled by a
 * background probe, and every node lacked its CPU model, disks and TDP for
 * a poll after each restart.
 */
export const MESH_FACT_FIELDS = [
  'cpuModel', 'cpuTdpWatts', 'cpuYear', 'arch', 'os', 'osRelease', 'userland', 'kind',
  'vms', 'containers', 'containersRunning', 'model', 'spinningDisks', 'ssdCount',
  'memCapGB', 'swapUsedGB', 'swapTotalGB', 'gpuModel', 'gpuMemTotalMB',
] as const satisfies readonly (keyof MeshNode)[];

export type MeshFacts = Partial<Pick<MeshNode, (typeof MESH_FACT_FIELDS)[number]>>;

export interface StoredMeshFacts {
  facts: MeshFacts;
  /** Uptime as of `observedAt`; add the time since to get it now. */
  uptimeSeconds: number | null;
  /** Epoch ms. */
  observedAt: number;
  /** The ssh config Host the sampler reached it by, when that differs from its name. */
  sshAlias: string | null;
}

function factsOf(n: MeshNode): MeshFacts {
  const out: Record<string, unknown> = {};
  for (const k of MESH_FACT_FIELDS) if (n[k] !== undefined) out[k] = n[k];
  return out as MeshFacts;
}

/**
 * Insert one row per reachable node. Returns how many were written.
 * `aliases[i]`, when given, is the ssh config Host nodes[i] was probed by.
 */
export function insertMeshSnapshots(db: Database.Database, nodes: MeshNode[], aliases: (string | undefined)[] = []): number {
  const insert = db.prepare(`
    INSERT INTO mesh_snapshots (hostname, cpu_cores, load_avg_1, load_avg_5, load_avg_15,
      mem_total_gb, mem_used_gb, power_watts, gpu_power_watts, gpu_util, gpu_mem_used_mb, gpu_mem_total_mb, power_source, claude_processes,
      agent_processes, harness_counts)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const upsertFacts = db.prepare(`
    INSERT INTO mesh_node_facts (hostname, facts, uptime_seconds, ssh_alias, observed_at)
    VALUES (?, ?, ?, ?, datetime('now'))
    ON CONFLICT(hostname) DO UPDATE SET
      facts = excluded.facts, uptime_seconds = excluded.uptime_seconds,
      ssh_alias = COALESCE(excluded.ssh_alias, mesh_node_facts.ssh_alias), observed_at = excluded.observed_at
  `);
  let written = 0;
  const tx = db.transaction(() => {
    (nodes as Array<MeshNode & Record<string, any>>).forEach((n, i) => {
      if (!n.reachable) return;
      // Total across harnesses, and the breakdown. A node with five
      // uncloseai-cli agents and no claude used to persist a zero here.
      const counts = n.harnessCounts as Record<string, number> | undefined;
      const agents = counts ? Object.values(counts).reduce((a, b) => a + b, 0) : 0;
      insert.run(
        n.hostname,
        n.cpuCores ?? 0,
        n.loadAvg?.[0] ?? 0,
        n.loadAvg?.[1] ?? 0,
        n.loadAvg?.[2] ?? 0,
        n.memTotalGB ?? 0,
        n.memUsedGB ?? 0,
        n.powerWatts ?? 0,
        n.gpuPowerWatts ?? 0,
        n.gpuUtil ?? null,
        n.gpuMemUsedMB ?? null,
        n.gpuMemTotalMB ?? null,
        n.powerSource ?? 'estimate',
        n.claudeProcesses ?? 0,
        agents || (n.claudeProcesses ?? 0),
        counts ? JSON.stringify(counts) : null,
      );
      // A probe that learned nothing static (a bare userland, a node mid
      // boot) keeps what an earlier one learned.
      const facts = factsOf(n);
      if (Object.keys(facts).length > 0) upsertFacts.run(n.hostname, JSON.stringify(facts), n.uptimeSeconds ?? null, aliases[i] ?? null);
      written++;
    });
  });
  tx();
  return written;
}

/** Every node's stored facts, by hostname. A row that does not parse is skipped. */
export function readMeshFacts(db: Database.Database): Map<string, StoredMeshFacts> {
  const rows = db.prepare('SELECT hostname, facts, uptime_seconds, ssh_alias, observed_at FROM mesh_node_facts').all() as
    { hostname: string; facts: string; uptime_seconds: number | null; ssh_alias: string | null; observed_at: string }[];
  const out = new Map<string, StoredMeshFacts>();
  for (const r of rows) {
    try {
      out.set(r.hostname, {
        facts: JSON.parse(r.facts),
        uptimeSeconds: r.uptime_seconds,
        observedAt: Date.parse(r.observed_at.replace(' ', 'T') + 'Z'),
        sshAlias: r.ssh_alias,
      });
    } catch { /* a torn row reads as no facts */ }
  }
  return out;
}
