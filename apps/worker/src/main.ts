import { startWatcher, stopWatcher } from '@unturf/unfirehose/db/watcher';
import { ingestAll, getDbStats } from '@unturf/unfirehose/db/ingest';

const POLL_INTERVAL_MS = 60_000;
const MESH_POLL_INTERVAL_MS = 30_000;
const NEXT_BASE_URL = process.env.UNFIREHOSE_NEXT_URL ?? 'http://localhost:3000';

async function pollMeshOnce(): Promise<void> {
  // Probe live state via Next's /api/mesh (SSH + nvidia-smi), then persist via
  // /api/mesh/history POST. Keeps the snapshot timeline filling even when no
  // browser tab is open — was previously gated on a client-side SWR poll.
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 20_000);
  try {
    const meshRes = await fetch(`${NEXT_BASE_URL}/api/mesh`, { signal: ctrl.signal });
    if (!meshRes.ok) return;
    const mesh = await meshRes.json();
    const nodes = Array.isArray(mesh?.nodes) ? mesh.nodes : [];
    if (nodes.length === 0) return;
    await fetch(`${NEXT_BASE_URL}/api/mesh/history`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ nodes }),
      signal: ctrl.signal,
    });
  } catch {
    // Next not ready, network blip, abort timeout — try again next tick
  } finally {
    clearTimeout(t);
  }
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
  // browser tab being open. First tick after a short delay so Next has come up.
  setTimeout(() => { pollMeshOnce(); }, 5_000);
  const meshInterval = setInterval(() => { pollMeshOnce(); }, MESH_POLL_INTERVAL_MS);

  // Graceful shutdown
  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.on(signal, () => {
      console.log(`[worker] ${signal} received, shutting down`);
      clearInterval(interval);
      clearInterval(meshInterval);
      stopWatcher();
      process.exit(0);
    });
  }

  console.log(`[worker] polling every ${POLL_INTERVAL_MS / 1000}s, mesh every ${MESH_POLL_INTERVAL_MS / 1000}s, ctrl+c to stop`);
}

main().catch((err) => {
  console.error('[worker] fatal:', err);
  process.exit(1);
});
