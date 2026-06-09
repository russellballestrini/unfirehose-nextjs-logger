import { startWatcher, stopWatcher } from '@unturf/unfirehose/db/watcher';
import { ingestAll, getDbStats } from '@unturf/unfirehose/db/ingest';
import { discoverNodes } from '@unturf/unfirehose/mesh';

const POLL_INTERVAL_MS = 60_000;
const MESH_POLL_INTERVAL_MS = 15_000;
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
  // Per-node probe + persist. Hits the single-node endpoint so each iteration
  // only touches one SSH target, spread across the polling interval.
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 20_000);
  try {
    const res = await fetch(
      `${NEXT_BASE_URL}/api/mesh/node?host=${encodeURIComponent(host)}`,
      { signal: ctrl.signal },
    );
    if (!res.ok) return;
    const node = await res.json() as { reachable?: boolean };
    if (!node?.reachable) return;
    await fetch(`${NEXT_BASE_URL}/api/mesh/history`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ nodes: [node] }),
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

  // Graceful shutdown
  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.on(signal, () => {
      console.log(`[worker] ${signal} received, shutting down`);
      clearInterval(interval);
      for (const t of meshTimers) {
        clearTimeout(t);
        clearInterval(t);
      }
      stopWatcher();
      process.exit(0);
    });
  }

  console.log(`[worker] polling every ${POLL_INTERVAL_MS / 1000}s, mesh every ${MESH_POLL_INTERVAL_MS / 1000}s (per-node staggered), ctrl+c to stop`);
}

main().catch((err) => {
  console.error('[worker] fatal:', err);
  process.exit(1);
});
