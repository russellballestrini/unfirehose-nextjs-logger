import { startWatcher, stopWatcher } from '@unturf/unfirehose/db/watcher';
import { ingestAll, getDbStats } from '@unturf/unfirehose/db/ingest';
import { getDb } from '@unturf/unfirehose/db/schema';
import { discoverNodes } from '@unturf/unfirehose/mesh';
import { rollupDrain } from './mesh-rollup';

const POLL_INTERVAL_MS = 60_000;
const MESH_POLL_INTERVAL_MS = 15_000;
// Cold-tier rollup tick — one minute is plenty since each 15s sample only
// ages past the 28-day boundary once. With multiple hosts the per-tick drain
// (capped at 16) catches up quickly without locking the DB for long.
const ROLLUP_TICK_MS = 60_000;
// Daily VACUUM to reclaim pages freed by the snake-eats-tail delete after a
// run of rollups. Cheap enough on this DB shape but locks briefly — schedule
// at off-hours by offsetting the first run.
const VACUUM_INTERVAL_MS = 24 * 60 * 60 * 1000;
const NEXT_BASE_URL = process.env.UNFIREHOSE_NEXT_URL ?? 'http://localhost:3000';

// Deterministic per-host phase offset within [0, MESH_POLL_INTERVAL_MS) so that
// hundreds of nodes don't stampede the network and SSH targets at the same tick.
// Same host → same offset every restart → snapshots land at predictable instants.
function phaseOffsetMs(host: string, intervalMs: number): number {
  let h = 0;
  for (let i = 0; i < host.length; i++) h = ((h << 5) - h + host.charCodeAt(i)) | 0;
  return Math.abs(h) % intervalMs;
}

async function probeAndPersistNode(host: string): Promise<void> {
  // Per-node probe + persist. Hits /api/mesh?host=X (not /api/mesh/node!) so
  // we reuse the same flat MeshNode shape /api/mesh/history POST expects —
  // /api/mesh/node returns a different nested shape meant for the UI detail
  // view. Single host = only that SSH target touched.
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 20_000);
  try {
    const res = await fetch(
      `${NEXT_BASE_URL}/api/mesh?host=${encodeURIComponent(host)}`,
      { signal: ctrl.signal },
    );
    if (!res.ok) return;
    const data = await res.json() as { nodes?: Array<{ reachable?: boolean }> };
    const nodes = Array.isArray(data?.nodes) ? data.nodes : [];
    if (nodes.length === 0 || !nodes[0]?.reachable) return;
    await fetch(`${NEXT_BASE_URL}/api/mesh/history`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ nodes }),
      signal: ctrl.signal,
    });
  } catch {
    // Next not ready, network blip, abort timeout — next interval will retry
  } finally {
    clearTimeout(t);
  }
}

function startStaggeredMeshSampler(): Array<NodeJS.Timeout> {
  // Snapshot the node list at startup; if hosts change at runtime, the worker
  // will pick them up on restart (acceptable for a periodically-restarted dev
  // worker and a Salt-managed prod worker).
  const hosts = discoverNodes();
  if (hosts.length === 0) return [];
  const timers: Array<NodeJS.Timeout> = [];
  const span = MESH_POLL_INTERVAL_MS;
  for (const host of hosts) {
    const offset = phaseOffsetMs(host, span);
    const t = setTimeout(() => {
      probeAndPersistNode(host);
      const t2 = setInterval(() => { probeAndPersistNode(host); }, span);
      timers.push(t2);
    }, offset);
    timers.push(t);
  }
  console.log(`[worker] mesh sampler: ${hosts.length} nodes staggered across ${span / 1000}s window`);
  return timers;
}

async function main() {
  console.log('[worker] starting ingestion worker');

  // Initial full ingest
  const result = await ingestAll();
  const stats = getDbStats();
  console.log('[worker] initial ingest:', result);
  console.log('[worker] db stats:', stats);

  // Start file watchers for real-time ingestion
  startWatcher();
  console.log('[worker] file watchers active');

  // Periodic full ingest as safety net
  const interval = setInterval(async () => {
    try {
      await ingestAll();
      const s = getDbStats();
      console.log(`[worker] periodic ingest: ${s.projects}p ${s.sessions}s ${s.messages}m`);
    } catch (err) {
      console.error('[worker] periodic ingest failed:', err);
    }
  }, POLL_INTERVAL_MS);

  // Headless mesh sampler — keeps GPU watts / utilization rolling without a
  // browser tab being open. Per-node phase offsets prevent a stampede when the
  // fleet grows. First batch of timers starts after Next has time to come up.
  let meshTimers: Array<NodeJS.Timeout> = [];
  setTimeout(() => { meshTimers = startStaggeredMeshSampler(); }, 5_000);

  // Cold-tier rollup tick. Each minute, drain up to 16 eligible 15-min
  // buckets from mesh_snapshots → mesh_snapshots_15m using the gaussian-
  // smoothed compress + snake-eats-tail delete (rollupDrain). Self-balances
  // across hosts: the oldest unrolled bucket across the fleet wins each
  // iteration, so no per-host scheduling logic needed.
  const rollupInterval = setInterval(() => {
    try {
      const n = rollupDrain(getDb());
      if (n > 0) console.log(`[worker] mesh rollup: folded ${n} bucket(s) into 15m tier`);
    } catch (err) {
      console.error('[worker] rollup failed:', err);
    }
  }, ROLLUP_TICK_MS);

  // Daily VACUUM to reclaim pages freed by the rollup-delete. Offset the
  // first run by 1 hour so a fresh worker doesn't VACUUM the moment ingest
  // is busiest.
  const vacuumKickoff = setTimeout(() => {
    const runVacuum = () => {
      try {
        const t0 = Date.now();
        getDb().exec('VACUUM');
        console.log(`[worker] daily VACUUM complete in ${Date.now() - t0}ms`);
      } catch (err) {
        console.error('[worker] VACUUM failed:', err);
      }
    };
    runVacuum();
    setInterval(runVacuum, VACUUM_INTERVAL_MS);
  }, 60 * 60 * 1000);

  // Graceful shutdown
  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.on(signal, () => {
      console.log(`[worker] ${signal} received, shutting down`);
      clearInterval(interval);
      clearInterval(rollupInterval);
      clearTimeout(vacuumKickoff);
      for (const t of meshTimers) {
        clearTimeout(t);
        clearInterval(t);
      }
      stopWatcher();
      process.exit(0);
    });
  }

  console.log(`[worker] polling every ${POLL_INTERVAL_MS / 1000}s, mesh every ${MESH_POLL_INTERVAL_MS / 1000}s (per-node staggered), rollup every ${ROLLUP_TICK_MS / 1000}s, ctrl+c to stop`);
}

main().catch((err) => {
  console.error('[worker] fatal:', err);
  process.exit(1);
});
