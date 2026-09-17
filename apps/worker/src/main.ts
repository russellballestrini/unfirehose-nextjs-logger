import { startWatcher, stopWatcher } from '@unturf/unfirehose/db/watcher';
import { ingestAll, getDbStats } from '@unturf/unfirehose/db/ingest';
import { getDb } from '@unturf/unfirehose/db/schema';
import { checkpointTruncate, freelistBytes } from '@unturf/unfirehose/db/pragmas';
import { rollupDrain } from './mesh-rollup';
import { startSampler } from './sampler-supervisor';
import { syncPricing, syncPricingIfStale, hydratePricing, syncIfUnpriced } from '@unturf/unfirehose/pricing-sync';
import { scanRateLimits } from '@unturf/unfirehose/db/rate-limit-scan';
import { pollAllStatusTargets, rollupStatusPolls } from '@unturf/unfirehose/status-pages';
import { refreshScrobblePayload } from '@unturf/unfirehose/scrobble';
import { refreshProjectList } from '@unturf/unfirehose/projects-list';
import { refreshDashboard, WARM_SHORT_RANGES, WARM_LONG_RANGES } from '@unturf/unfirehose/dashboard';

const POLL_INTERVAL_MS = 60_000;
// Cold-tier rollup tick — one minute is plenty since each 15s sample only
// ages past the 28-day boundary once. With multiple hosts the per-tick drain
// (capped at 16) catches up quickly without locking the DB for long.
const ROLLUP_TICK_MS = 60_000;
// Daily VACUUM to reclaim pages freed by the snake-eats-tail delete after a
// run of rollups. Locks briefly and rewrites our whole database — schedule at
// off-hours by offsetting our first run, and gate it on our freelist so it only
// runs when there is something to reclaim.
const VACUUM_INTERVAL_MS = 24 * 60 * 60 * 1000;
// Below this much reclaimable space a VACUUM costs far more than it returns:
// it rewrites every page through our WAL, so a no-op VACUUM on a 3.6G database
// buys ~0 bytes and leaves a 3.6G WAL behind.
const VACUUM_MIN_FREELIST_BYTES = 256 * 1024 * 1024;
// Hourly WAL checkpoint so `journal_size_limit` is actually applied — SQLite
// truncates our -wal on checkpoint, never on write.
const CHECKPOINT_INTERVAL_MS = 60 * 60 * 1000;

// Model prices move on the order of weeks — as far as we know. Daily keeps us
// current without leaning on any oracle. The ledger only opens a row when a
// price actually moves, so a tighter cadence costs fetches, not storage; if
// pricing_sync_runs.changed shows the market is more fickle than that, lower
// this via UNFIREHOSE_PRICE_SYNC_MINUTES and start drawing the charts.
const PRICE_SYNC_INTERVAL_MS = (() => {
  const m = parseInt(process.env.UNFIREHOSE_PRICE_SYNC_MINUTES ?? '', 10);
  return Number.isFinite(m) && m >= 5 ? m * 60_000 : 24 * 60 * 60 * 1000;
})();
// How often to look for a logged model no oracle prices yet, and the least
// time between the syncs that check triggers.
const UNPRICED_CHECK_INTERVAL_MS = 5 * 60_000;
const UNPRICED_SYNC_MIN_INTERVAL_MS = 60 * 60_000;
// Watchdog cadence + thresholds. The worker is meant to run for days; if the
// ingest loop silently wedges (stuck flag, dropped timer, an event loop that
// blocked then recovered) we want it to self-heal, not wait for a human.
// Stored-payload cadences. Every route serves whatever is stored, however
// old (readX(Infinity)) — staleness is the only cost of a longer interval,
// never a rebuild on a request. Measured 2026-09-17 on a 6.6 GB database:
// dashboard 24h 0.7 s, 7d 1.2 s, 28d 4.6 s; project list 4.0 s; scrobble
// 14.7 s. All at 60 s / 60 s / 5 min that was 13 s of every minute on one
// thread. The short ranges stay live; the long tail moves to minutes.
const DASHBOARD_REFRESH_MS = 60_000;             // 24h + 7d: what a dashboard opens on
const DASHBOARD_LONG_REFRESH_MS = 5 * 60_000;    // 28d: a month does not move in a minute
const PROJECT_LIST_REFRESH_MS = 3 * 60_000;      // ~4 s of aggregates
const SCROBBLE_REFRESH_MS = 15 * 60_000;         // ~15 s, two full scans of messages
// Each tick above rebuilds only when a message has landed since the stored
// payload was built (see payloadCurrent). These bound how old a payload may
// grow while nothing lands: a range slides with the clock and mesh energy
// samples arrive without a message, so a quiet hour still rebuilds this
// often. Measured 2026-09-17: the three dashboards and the project list were
// ~5 s of every minute on a worker with nothing to ingest.
const DASHBOARD_MAX_QUIET_MS = 5 * 60_000;
const DASHBOARD_LONG_MAX_QUIET_MS = 15 * 60_000;
const PROJECT_LIST_MAX_QUIET_MS = 10 * 60_000;
const SCROBBLE_MAX_QUIET_MS = 60 * 60_000;
const STATUS_POLL_INTERVAL_MS = 60_000;      // vendor status feeds — once a minute is polite
const STATUS_ROLLUP_INTERVAL_MS = 60 * 60_000;
const WATCHDOG_TICK_MS = 5 * 60_000;       // check liveness every 5 min
const INGEST_STALL_MS = 10 * 60_000;       // >10 min with no completed ingest = suspect
const INGEST_HANG_MS = 30 * 60_000;        // in-flight this long = abandoned; force-restart it

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
  const t0 = Date.now();
  try {
    const r = await ingestAll();
    const s = getDbStats();
    // The duration is the number that matters: a quiet pass was 26 s on
    // 2026-09-17 and nobody could see it, because this line said only what
    // the database held afterwards.
    console.log(`[worker] ingest (${reason}): ${s.projects}p ${s.sessions}s ${s.messages}m · +${r.messagesAdded}m from ${r.filesScanned} file(s) in ${Date.now() - t0}ms`);
  } catch (err) {
    console.error(`[worker] ingest (${reason}) failed:`, err);
  } finally {
    lastIngestAt = Date.now();
    ingestInFlight = false;
  }
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

  // Rate-limit extraction rides the ingest cadence: blocks land, then get
  // classified. Incremental, so each pass only reads what arrived since the
  // last one. Without this a 429 stays buried in prose and unqueryable.
  const rateLimitInterval = setInterval(() => {
    try {
      const r = scanRateLimits(getDb());
      if (r.found > 0) console.log(`[worker] rate limits: ${r.found} event(s) from ${r.scanned} new block(s)`);
    } catch (err) {
      console.error('[worker] rate limit scan failed:', err);
    }
  }, POLL_INTERVAL_MS);

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

  // Dashboard payloads for the ranges a dashboard opens on. Any other range
  // builds on its first request and is stored for the next.
  // A skipped range logs nothing: the ingest line a moment earlier already
  // said +0m, and a rebuild is the event worth a line.
  const refreshDashboards = (ranges: readonly string[], unlessCurrentMs: number) => {
    for (const range of ranges) {
      try {
        const t0 = Date.now();
        if (refreshDashboard(range, { unlessCurrentMs }) === null) continue;
        console.log(`[worker] dashboard ${range} in ${Date.now() - t0}ms`);
      } catch (err) {
        console.error(`[worker] dashboard ${range} failed:`, err);
      }
    }
  };
  const dashboardKickoff = setTimeout(() => {
    refreshDashboards(WARM_SHORT_RANGES, DASHBOARD_MAX_QUIET_MS);
    refreshDashboards(WARM_LONG_RANGES, DASHBOARD_LONG_MAX_QUIET_MS);
  }, 12_000);
  const dashboardInterval = setInterval(() => refreshDashboards(WARM_SHORT_RANGES, DASHBOARD_MAX_QUIET_MS), DASHBOARD_REFRESH_MS);
  const dashboardLongInterval = setInterval(() => refreshDashboards(WARM_LONG_RANGES, DASHBOARD_LONG_MAX_QUIET_MS), DASHBOARD_LONG_REFRESH_MS);

  // Project list. Two aggregates over messages plus a filesystem pass —
  // about 5s, which starves the single-threaded web process if it runs
  // there. Built here, read there.
  const refreshProjects = async () => {
    try {
      const t0 = Date.now();
      const rows = await refreshProjectList({ unlessCurrentMs: PROJECT_LIST_MAX_QUIET_MS });
      if (rows === null) return;
      console.log(`[worker] project list: ${rows.length} projects in ${Date.now() - t0}ms`);
    } catch (err) {
      console.error('[worker] project list refresh failed:', err);
    }
  };
  const projectsKickoff = setTimeout(() => { void refreshProjects(); }, 8_000);
  const projectsInterval = setInterval(() => { void refreshProjects(); }, PROJECT_LIST_REFRESH_MS);

  // Scrobble payload. Building it is two full scans of a 1.6M-row table, so
  // it is computed here and stored, and the page reads what we left.
  const refreshScrobble = () => {
    try {
      const t0 = Date.now();
      if (refreshScrobblePayload(getDb(), { unlessCurrentMs: SCROBBLE_MAX_QUIET_MS }) === null) return;
      console.log(`[worker] scrobble payload refreshed in ${Date.now() - t0}ms`);
    } catch (err) {
      console.error('[worker] scrobble refresh failed:', err);
    }
  };
  const scrobbleKickoff = setTimeout(refreshScrobble, 20_000);
  const scrobbleInterval = setInterval(refreshScrobble, SCROBBLE_REFRESH_MS);

  // Vendor status pages. What the provider admits to, next to what we hit.
  // First poll shortly after boot so the refusals tab is not blank for a
  // minute; robots.txt is honoured inside pollAllStatusTargets.
  const runStatusPoll = async () => {
    try {
      const polls = await pollAllStatusTargets(getDb());
      const bad = polls.filter((p) => p.indicator !== 'none');
      if (bad.length) console.log(`[worker] vendor status: ${bad.map((p) => `${p.targetId}=${p.indicator}`).join(' ')}`);
    } catch (err) {
      console.error('[worker] vendor status poll failed:', err);
    }
  };
  // Stale-gated like the price sync: tsx watch reboots on every save, and a
  // poll a minute ago is still the answer.
  const statusKickoff = setTimeout(() => {
    const last = getDb().prepare('SELECT MAX(timestamp) AS t FROM status_polls').get() as { t: string | null };
    if (last?.t && Date.now() - Date.parse(last.t) < STATUS_POLL_INTERVAL_MS) return;
    void runStatusPoll();
  }, 10_000);
  const statusInterval = setInterval(() => { void runStatusPoll(); }, STATUS_POLL_INTERVAL_MS);
  const statusRollup = setInterval(() => {
    try {
      const n = rollupStatusPolls(getDb());
      if (n > 0) console.log(`[worker] vendor status: folded ${n} raw poll(s) into hourly tier`);
    } catch (err) {
      console.error('[worker] vendor status rollup failed:', err);
    }
  }, STATUS_ROLLUP_INTERVAL_MS);

  // Headless mesh sampler — keeps GPU watts / utilization rolling without a
  // browser tab being open — and the vLLM cache sampler, as one small child
  // process: their work is spawning ssh and nvidia-smi, and a fork from this
  // process costs ~100 ms of held event loop per spawn (see sampler.ts).
  const sampler = startSampler(new URL('./sampler.ts', import.meta.url).pathname);

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

  // Hourly WAL checkpoint. `journal_size_limit` (see db/pragmas) caps our -wal
  // file, but only a checkpoint actually applies that cap — SQLite truncates on
  // checkpoint, not on write. Busy is an expected outcome, not a failure: web
  // and worker are separate processes on one file, so some ticks will find
  // readers holding our WAL and simply retry an hour later.
  const checkpointInterval = setInterval(() => {
    try {
      const t0 = Date.now();
      const r = checkpointTruncate(getDb());
      const mb = (b: number) => (b / 1048576).toFixed(1);
      if (r.busy) {
        console.log(`[worker] WAL checkpoint busy (readers active), -wal still ${mb(r.walBytesAfter)}MB — retrying next tick`);
      } else {
        console.log(`[worker] WAL checkpoint reclaimed ${mb(r.reclaimedBytes)}MB (${mb(r.walBytesBefore)} → ${mb(r.walBytesAfter)}MB) in ${Date.now() - t0}ms`);
      }
    } catch (err) {
      console.error('[worker] WAL checkpoint failed:', err);
    }
  }, CHECKPOINT_INTERVAL_MS);

  // Model price catalog. Hydrate whatever we already stored first so cost
  // numbers are right from the first request, then refresh from our oracles
  // shortly after boot and daily after that. A failed fetch keeps the stored
  // prices — stale beats zero, and a zero price silently reads as "free".
  hydratePricing(getDb());
  const logPriceSync = (results: Awaited<ReturnType<typeof syncPricing>>) => {
    for (const r of results) {
      if (r.ok) {
        console.log(`[worker] price sync: ${r.source} → ${r.models} models, +${r.added} new, ~${r.changed} changed, -${r.delisted} delisted (run#${r.runId})`);
        for (const c of r.changes) {
          if (!c.from) continue;
          console.log(`[worker]   ${r.source} ${c.modelId}: $${c.from.input}/$${c.from.output} → $${c.to.input}/$${c.to.output} per M`);
        }
      } else {
        console.error(`[worker] price sync failed: ${r.source} — ${r.error} (run#${r.runId})`);
      }
    }
  };
  const priceKickoff = setTimeout(() => {
    const runPriceSync = async () => {
      try {
        logPriceSync(await syncPricing(getDb(), { trigger: 'worker' }));
      } catch (err) {
        console.error('[worker] price sync failed:', err);
      }
    };
    // On boot, only fetch if the book is actually stale. Under `tsx watch`
    // this process restarts on every file save, and five full catalog pulls
    // per save is both wasteful and how `make pricing` ends up contending
    // for the write lock with a worker that just came back up.
    void syncPricingIfStale(PRICE_SYNC_INTERVAL_MS / 1000 / 4, getDb(), { trigger: 'worker' })
      .then((r) => { if (r) logPriceSync(r); })
      .catch((err) => console.error('[worker] price sync failed:', err));
    setInterval(() => { void runPriceSync(); }, PRICE_SYNC_INTERVAL_MS);
  }, 10_000);

  // The clock is not the only reason to check the book. A model that shipped
  // this afternoon has tokens in the log now and a price on the oracles now;
  // waiting for tomorrow's tick prices every one of them as `unknown` until
  // then. After each ingest, if anything recent is unpriced, sync — throttled
  // to once an hour so a model no oracle carries cannot become a fetch storm.
  const unpricedInterval = setInterval(() => {
    void syncIfUnpriced(getDb(), UNPRICED_SYNC_MIN_INTERVAL_MS)
      .then((r) => {
        if (!r) return;
        console.log(`[worker] unpriced models seen: ${r.unpriced.map((u) => u.model).join(', ')} — synced`);
        logPriceSync(r.results);
      })
      .catch((err) => console.error('[worker] unpriced price sync failed:', err));
  }, UNPRICED_CHECK_INTERVAL_MS);

  // VACUUM only when there is something to reclaim. This ran unconditionally
  // every day and was our reason our WAL reached 3.6G: VACUUM rewrites every
  // page of our database, and in WAL mode those pages all land in our WAL, so
  // one run sizes our WAL to match our whole database. Measured 2026-08-14 it
  // recovered 9MB from a 3.6G database — it was paying our entire database size
  // in WAL growth to reclaim a rounding error. Our freelist tells us what a
  // VACUUM would genuinely return, so we only pay when it is worth paying.
  // Offset our first run by 1 hour so a fresh worker doesn't VACUUM the moment
  // ingest is busiest.
  const vacuumKickoff = setTimeout(() => {
    const runVacuum = () => {
      try {
        const db = getDb();
        const reclaimable = freelistBytes(db);
        if (reclaimable < VACUUM_MIN_FREELIST_BYTES) {
          console.log(`[worker] VACUUM skipped — freelist ${(reclaimable / 1048576).toFixed(1)}MB below ${(VACUUM_MIN_FREELIST_BYTES / 1048576).toFixed(0)}MB threshold`);
          return;
        }
        const t0 = Date.now();
        db.exec('VACUUM');
        console.log(`[worker] VACUUM reclaimed ${(reclaimable / 1048576).toFixed(1)}MB in ${Date.now() - t0}ms`);
        // VACUUM just pushed our whole database through our WAL. Fold it back
        // immediately rather than leaving our file at its new high-water mark
        // until our next hourly tick.
        checkpointTruncate(db);
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
      clearInterval(rateLimitInterval);
      clearTimeout(statusKickoff);
      clearInterval(statusInterval);
      clearInterval(statusRollup);
      clearTimeout(scrobbleKickoff);
      clearInterval(scrobbleInterval);
      clearTimeout(projectsKickoff);
      clearInterval(projectsInterval);
      clearTimeout(dashboardKickoff);
      clearInterval(dashboardInterval);
      clearInterval(dashboardLongInterval);
      clearInterval(checkpointInterval);
      clearTimeout(vacuumKickoff);
      clearTimeout(priceKickoff);
      clearInterval(unpricedInterval);
      sampler.stop();
      stopWatcher();
      process.exit(0);
    });
  }

  console.log(`[worker] polling every ${POLL_INTERVAL_MS / 1000}s, mesh sampled by a child process, rollup every ${ROLLUP_TICK_MS / 1000}s, ctrl+c to stop`);
}

main().catch((err) => {
  console.error('[worker] fatal:', err);
  process.exit(1);
});
