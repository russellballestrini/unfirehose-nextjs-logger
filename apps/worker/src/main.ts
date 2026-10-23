import { startWatcher, stopWatcher } from '@unturf/unfirehose/db/watcher';
import { ingestAll, getDbStats, ingestActivityAt, type IngestResult } from '@unturf/unfirehose/db/ingest';
import { POLL_INTERVAL_MS, nextPollDelayMs } from './poll-cadence';
import { getDb } from '@unturf/unfirehose/db/schema';
import { checkpointTruncate } from '@unturf/unfirehose/db/pragmas';
import { maintenanceTick, describeTick, MAINTENANCE_TICK_MS } from './maintenance';
import { rollupDrain } from './mesh-rollup';
import { startSampler, startPayloadBuilder } from './sampler-supervisor';
import { syncPricing, syncPricingIfStale, hydratePricing, syncIfUnpriced } from '@unturf/unfirehose/pricing-sync';
import { scanRateLimits } from '@unturf/unfirehose/db/rate-limit-scan';
import { scanLedgerHead, backfillLedger } from '@unturf/unfirehose/db/action-ledger';
import { pollAllStatusTargets, rollupStatusPolls } from '@unturf/unfirehose/status-pages';
import { fileSecretStore } from '@unturf/unfirehose/db/alert-delivery';
import { createAlertTicker, ALERT_DELIVERY_TICK_MS } from './alert-tick';

// Cold-tier rollup tick — one minute is plenty since each 15s sample only
// ages past the 28-day boundary once. With multiple hosts the per-tick drain
// (capped at 16) catches up quickly without locking the DB for long.
const ROLLUP_TICK_MS = 60_000;
// Daily VACUUM, size snapshot and retention moves: see ./maintenance.ts.
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
// Action ledger history: one window of block ids per tick, only while no
// ingest is running. 2.35 M blocks is ~47 windows, so a large history fills
// in about twelve minutes without ever holding the write lock for long.
const LEDGER_BACKFILL_TICK_MS = 15_000;
const STATUS_POLL_INTERVAL_MS = 60_000;      // vendor status feeds — once a minute is polite
const STATUS_ROLLUP_INTERVAL_MS = 60 * 60_000;
// Watchdog cadence + thresholds. The worker is meant to run for days; if the
// ingest loop silently wedges (stuck flag, dropped timer, an event loop that
// blocked then recovered) we want it to self-heal, not wait for a human.
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

// Alert delivery (see alert-tick.ts): a no-op until a user creates a rule.
const deliverAlerts = createAlertTicker({ db: getDb, store: () => fileSecretStore() });

async function runIngestOnce(reason: string): Promise<IngestResult | null> {
  if (ingestInFlight) return null;
  ingestInFlight = true;
  const t0 = Date.now();
  try {
    const r = await ingestAll();
    const s = getDbStats();
    // The duration is the number that matters: a quiet pass was 26 s on
    // 2026-09-17 and nobody could see it, because this line said only what
    // the database held afterwards.
    console.log(`[worker] ingest (${reason}): ${s.projects}p ${s.sessions}s ${s.messages}m · +${r.messagesAdded}m from ${r.filesScanned} file(s) in ${Date.now() - t0}ms`);
    // A fresh alert goes out now, not on the next delivery tick.
    if (r.alertsTriggered > 0) void deliverAlerts();
    return r;
  } catch (err) {
    console.error(`[worker] ingest (${reason}) failed:`, err);
    return null;
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
  // Self-scheduling: the wait stretches while nothing lands (poll-cadence.ts).
  let pollDelay = POLL_INTERVAL_MS;
  let pollTimer: ReturnType<typeof setTimeout> | null = null;
  const schedulePoll = () => {
    pollTimer = setTimeout(async () => {
      const scheduledAt = Date.now() - pollDelay;
      await runIngestOnce('periodic');
      // Active if any pass — this one or a watcher's — read new bytes since
      // this poll was scheduled.
      const next = nextPollDelayMs(pollDelay, ingestActivityAt() >= scheduledAt);
      if (next !== pollDelay) console.log(`[worker] ${next > pollDelay ? 'quiet' : 'active'}: next full pass in ${next / 1000}s`);
      pollDelay = next;
      schedulePoll();
    }, pollDelay);
  };
  schedulePoll();

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

  // Agent action ledger. New tool calls are classified at the end of every
  // ingest pass; this catches up anything a bounded pass left, then walks
  // history newest first. Skipped while ingest holds the database.
  let ledgerBackfillDone = false;
  let ledgerLogged = 0;
  const ledgerInterval = setInterval(() => {
    if (ingestInFlight) return;
    try {
      const db = getDb();
      scanLedgerHead(db);
      // Cheap once history is done (two settings reads), and it resumes on
      // its own after a rebuild from /api/actions.
      const t0 = Date.now();
      const r = backfillLedger(db);
      ledgerLogged += r.recorded;
      if (r.done) {
        if (!ledgerBackfillDone) console.log(`[worker] action ledger: history classified (${ledgerLogged} action(s) this run)`);
        ledgerBackfillDone = true;
        return;
      }
      ledgerBackfillDone = false;
      if (r.recorded > 0) {
        console.log(`[worker] action ledger: +${r.recorded} from ${r.scanned} tool call(s) in ${Date.now() - t0}ms, ${r.remaining} block id(s) to go`);
      }
    } catch (err) {
      console.error('[worker] action ledger failed:', err);
    }
  }, LEDGER_BACKFILL_TICK_MS);

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

  // Payloads a route serves — dashboard, tokens, scrobble, the project
  // list — built in a child of their own. A lifetime or 365d build is 13 to
  // 20 s of synchronous scans; on this thread that was 13 to 20 s of ingest
  // and watchdog standing still (see payloads.ts).
  const payloads = startPayloadBuilder(new URL('./payloads.ts', import.meta.url).pathname);

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

  // Alert delivery: rules in Settings → Alerts, attempts in alert_deliveries.
  const alertDeliveryInterval = setInterval(() => { void deliverAlerts(); }, ALERT_DELIVERY_TICK_MS);

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

  // Upkeep while ingest is idle (./maintenance.ts, rules in core's
  // db/maintenance): today's size snapshot for Settings → Database, the
  // retention window's move of old block text into cold storage, and the
  // daily VACUUM. VACUUM runs only when our freelist makes it worth a full
  // rewrite (it once sized our WAL to the whole 3.6G database to reclaim
  // 9MB) and only after fifteen quiet minutes; a busy day defers it to the
  // next quiet tick rather than skipping it.
  const bootAt = Date.now();
  let vacuumDeferral = '';
  const maintenanceInterval = setInterval(() => {
    try {
      const r = maintenanceTick(getDb(), { inFlight: ingestInFlight, lastActivityAt: ingestActivityAt() }, { bootAt });
      for (const line of describeTick(r)) console.log(`[worker] ${line}`);
      const deferred = r.skipped.find((s) => s.startsWith('vacuum:'));
      if (deferred && !vacuumDeferral) console.log(`[worker] VACUUM due, deferred until ingest is quiet (${deferred.slice(8)})`);
      vacuumDeferral = r.vacuum ? '' : deferred ?? vacuumDeferral;
    } catch (err) {
      console.error('[worker] maintenance failed:', err);
    }
  }, MAINTENANCE_TICK_MS);

  // Graceful shutdown
  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.on(signal, () => {
      console.log(`[worker] ${signal} received, shutting down`);
      if (pollTimer) clearTimeout(pollTimer);
      clearInterval(watchdog);
      clearInterval(rollupInterval);
      clearInterval(rateLimitInterval);
      clearInterval(ledgerInterval);
      clearTimeout(statusKickoff);
      clearInterval(statusInterval);
      clearInterval(statusRollup);
      clearInterval(checkpointInterval);
      clearInterval(maintenanceInterval);
      clearTimeout(priceKickoff);
      clearInterval(unpricedInterval);
      clearInterval(alertDeliveryInterval);
      sampler.stop();
      payloads.stop();
      stopWatcher();
      process.exit(0);
    });
  }

  console.log(`[worker] full pass every ${POLL_INTERVAL_MS / 1000}s while active, stretching to 5 min when quiet; mesh sampled and payloads built by child processes; rollup every ${ROLLUP_TICK_MS / 1000}s; ctrl+c to stop`);
}

main().catch((err) => {
  console.error('[worker] fatal:', err);
  process.exit(1);
});
