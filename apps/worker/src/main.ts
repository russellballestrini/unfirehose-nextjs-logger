import { startWatcher, stopWatcher } from '@unfirehose/core/db/watcher';
import { ingestAll, getDbStats } from '@unfirehose/core/db/ingest';

const POLL_INTERVAL_MS = 60_000;

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

  // Graceful shutdown
  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.on(signal, () => {
      console.log(`[worker] ${signal} received, shutting down`);
      clearInterval(interval);
      stopWatcher();
      process.exit(0);
    });
  }

  console.log(`[worker] polling every ${POLL_INTERVAL_MS / 1000}s, ctrl+c to stop`);
}

main().catch((err) => {
  console.error('[worker] fatal:', err);
  process.exit(1);
});
