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
// Watchdog cadence + thresholds. The worker is meant to run for days; if the
// ingest loop silently wedges (stuck flag, dropped timer, an event loop that
// blocked then recovered) we want it to self-heal, not wait for a human.
const WATCHDOG_TICK_MS = 5 * 60_000;       // check liveness every 5 min
const INGEST_STALL_MS = 10 * 60_000;       // >10 min with no completed ingest = suspect
const INGEST_HANG_MS = 30 * 60_000;        // in-flight this long = abandoned; force-restart it
const NEXT_BASE_URL = process.env.UNFIREHOSE_NEXT_URL ?? 'http://localhost:3000';

// ── Autoheal ─────────────────────────────────────────────────────────────────
// A background timer that throws or rejects becomes an uncaughtException /
// unhandledRejection, which Node turns into process exit — and `tsx watch` only
// respawns on file changes, not on crash. That is exactly how ingest went dark
// for 2.5 days (worker child died 2026-07-13T01:11Z, never came back). Log and
// keep running so one transient fault can't take the worker down for days.
process.on('uncaughtException', (err) => {
  console.error('[worker] uncaughtException (continuing):', err);
});
process.on('unhandledRejection', (reason) => {
  console.error('[worker] unhandledRejection (continuing):', reason);
});

// Heartbeat + single-flight guard for ingest. setInterval fires regardless of
// whether the prior run finished; without a guard a slow run would stack. The
// watchdog reads lastIngestAt to tell a healthy idle worker from a wedged one.
let lastIngestAt = Date.now();
let ingestInFlight = false;

async function runIngestOnce(reason: string): Promise<void> {
  if (ingestInFlight) return;
  ingestInFlight = true;
  try {
    await ingestAll();
    const s = getDbStats();
    console.log(`[worker] ingest (${reason}): ${s.projects}p ${s.sessions}s ${s.messages}m`);
  } catch (err) {
    console.error(`[worker] ingest (${reason}) failed:`, err);
  } finally {
    lastIngestAt = Date.now();
    ingestInFlight = false;
  }
}

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

  // Initial full ingest. Runs through runIngestOnce so a startup failure logs
  // and lets the watchdog retry, rather than exiting the process.
  await runIngestOnce('startup');

  // Start file watchers for real-time ingestion
  startWatcher();
  console.log('[worker] file watchers active');

  // Periodic full ingest as safety net (single-flight via runIngestOnce).
  const interval = setInterval(() => { void runIngestOnce('periodic'); }, POLL_INTERVAL_MS);

  // Watchdog: if no ingest has completed within INGEST_STALL_MS the loop is
  // wedged — force a recovery run instead of waiting for a restart. A run that
  // is legitimately still in flight is left alone until INGEST_HANG_MS, past
  // which it's treated as abandoned and the guard is cleared so a fresh run can
  // start.
  const watchdog = setInterval(() => {
    const idle = Date.now() - lastIngestAt;
    if (idle <= INGEST_STALL_MS) return;
    if (ingestInFlight && idle < INGEST_HANG_MS) {
      console.warn(`[worker] ingest in flight ${Math.round(idle / 1000)}s (slow, not yet wedged)`);
      return;
    }
    console.warn(`[worker] ingest idle ${Math.round(idle / 1000)}s — forcing recovery ingest`);
    ingestInFlight = false; // clear a stuck/abandoned guard before retrying
    void runIngestOnce('watchdog');
  }, WATCHDOG_TICK_MS);

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
      clearInterval(watchdog);
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
