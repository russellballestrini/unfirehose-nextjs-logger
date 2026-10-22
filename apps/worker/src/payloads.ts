/**
 * Our stored payloads — dashboard, tokens, scrobble, the project list — built
 * in a process of their own.
 *
 * Every build is synchronous better-sqlite3 scanning: 0.4 s for a week of
 * tokens, 13 to 20 s for a dashboard or tokens page over 90d, 365d or a
 * lifetime, 15 s for scrobble. Run from the worker, each of those held the
 * one thread that also ingests, so a stored-range tick was up to a minute
 * of ingest and watchdog standing still. Here they hold only this thread.
 *
 * This opens its own database connection; WAL lets it read while the
 * worker writes, and each store is a few short writes to `settings`. Like
 * the sampler it lives exactly as long as the parent: the IPC channel
 * fork() opens closes when the parent dies, and 'disconnect' ends this.
 * Routes read what lands; see docs/architecture/precomputed-payloads.md.
 */

import { getDb } from '@unturf/unfirehose/db/schema';
import { refreshScrobblePayload } from '@unturf/unfirehose/scrobble';
import { refreshProjectList } from '@unturf/unfirehose/projects-list';
import { refreshDashboard, storedDashboardRanges, WARM_SHORT_RANGES, WARM_LONG_RANGES } from '@unturf/unfirehose/dashboard';
import { refreshTokensPayload, storedTokensRanges, WARM_TOKENS_SHORT_RANGES, WARM_TOKENS_LONG_RANGES } from '@unturf/unfirehose/tokens';

// Stored-payload cadences. Every route serves whatever is stored, however
// old (readX(Infinity)) — staleness is the only cost of a longer interval,
// never a rebuild on a request. Measured 2026-09-17 on a 6.6 GB database:
// dashboard 24h 0.7 s, 7d 1.2 s, 28d 4.6 s; project list 4.0 s; scrobble
// 14.7 s. All at 60 s / 60 s / 5 min that was 13 s of every minute on one
// thread. The short ranges stay live; the long tail moves to minutes.
const DASHBOARD_REFRESH_MS = 60_000;             // 24h + 7d: what a dashboard opens on
const DASHBOARD_LONG_REFRESH_MS = 5 * 60_000;    // 28d: a month does not move in a minute
// A stored range nobody warms (90d, 365d, all, the odd 1h) builds in 16 to
// 20 s each, on this thread, ahead of ingest. Five of them every ten minutes
// was a minute of blocked ingest per ten; thirty minutes bounds it near 3%.
// A quarter-year view does not move in half an hour.
const DASHBOARD_STORED_REFRESH_MS = 30 * 60_000; // 90d, 365d, all: whatever a first request stored
const PROJECT_LIST_REFRESH_MS = 3 * 60_000;      // ~4 s of aggregates
const SCROBBLE_REFRESH_MS = 15 * 60_000;         // ~15 s, two full scans of messages
const TOKENS_REFRESH_MS = 60_000;                // 24h + 7d: ~0.4 s each, what the Tokens page opens on
const TOKENS_LONG_REFRESH_MS = 10 * 60_000;      // 28d, lifetime (~11 s)
const TOKENS_STORED_REFRESH_MS = 30 * 60_000;    // 90d, 180d, 365d: ~13 s each, whatever a first request stored
// Each tick above rebuilds only when a message has landed since the stored
// payload was built (see payloadCurrent). These bound how old a payload may
// grow while nothing lands: a range slides with the clock and mesh energy
// samples arrive without a message, so a quiet hour still rebuilds this
// often. Measured 2026-09-17: the three dashboards and the project list were
// ~5 s of every minute on a worker with nothing to ingest.
// While nothing lands, the only things that move are the window's trailing
// edge and the mesh energy integral; the page shows X-Computed-At. The
// first message to land moves the watermark and rebuilds within a minute.
const DASHBOARD_MAX_QUIET_MS = 15 * 60_000;
const DASHBOARD_LONG_MAX_QUIET_MS = 30 * 60_000;
const DASHBOARD_STORED_MAX_QUIET_MS = 60 * 60_000;
const PROJECT_LIST_MAX_QUIET_MS = 15 * 60_000;
const SCROBBLE_MAX_QUIET_MS = 2 * 60 * 60_000;
const TOKENS_MAX_QUIET_MS = 15 * 60_000;
const TOKENS_LONG_MAX_QUIET_MS = 60 * 60_000;
const TOKENS_STORED_MAX_QUIET_MS = 60 * 60_000;

// Payloads a route serves and this process builds: the dashboard and the
// tokens page, each with a warm set rebuilt on a cadence. One loop for
// both. A skipped range logs nothing: the ingest line a moment earlier
// already said +0m, and a rebuild is the event worth a line.
export const refreshRanges = (
  label: string,
  refresh: (range: string, opts: { unlessCurrentMs: number }) => unknown | null,
  ranges: readonly string[],
  unlessCurrentMs: number,
) => {
  for (const range of ranges) {
    try {
      const t0 = Date.now();
      if (refresh(range, { unlessCurrentMs }) === null) continue;
      console.log(`[payloads] ${label} ${range} in ${Date.now() - t0}ms`);
    } catch (err) {
      console.error(`[payloads] ${label} ${range} failed:`, err);
    }
  }
};
// The ranges a first request built and stored, less any the warm ticks
// already own. Without this the route served that first build forever:
// the dashboard's 90d, 365d and lifetime sat a month old (2026-10-14).
export const storedBeyond = (stored: () => string[], ...warm: readonly (readonly string[])[]) => {
  const own = new Set<string>(warm.flat());
  return [...new Set(stored())].filter((r) => !own.has(r));
};

function main() {
  // Dashboard payloads for the ranges a dashboard opens on, plus whatever a
  // request stored, on a slower tick: 90d and lifetime are many seconds.
  const refreshDashboards = (ranges: readonly string[], unlessCurrentMs: number) =>
    refreshRanges('dashboard', refreshDashboard, ranges, unlessCurrentMs);
  const storedDashboards = () => storedBeyond(storedDashboardRanges, WARM_SHORT_RANGES, WARM_LONG_RANGES);
  const dashboardKickoff = setTimeout(() => {
    refreshDashboards(WARM_SHORT_RANGES, DASHBOARD_MAX_QUIET_MS);
    refreshDashboards(WARM_LONG_RANGES, DASHBOARD_LONG_MAX_QUIET_MS);
  }, 12_000);
  const dashboardInterval = setInterval(() => refreshDashboards(WARM_SHORT_RANGES, DASHBOARD_MAX_QUIET_MS), DASHBOARD_REFRESH_MS);
  const dashboardLongInterval = setInterval(() => refreshDashboards(WARM_LONG_RANGES, DASHBOARD_LONG_MAX_QUIET_MS), DASHBOARD_LONG_REFRESH_MS);
  // Later than the other kickoffs: these are the slow builds, and the warm
  // sets, the project list and the tokens page all want the first minute.
  const dashboardStoredKickoff = setTimeout(() => refreshDashboards(storedDashboards(), DASHBOARD_STORED_MAX_QUIET_MS), 45_000);
  const dashboardStoredInterval = setInterval(() => refreshDashboards(storedDashboards(), DASHBOARD_STORED_MAX_QUIET_MS), DASHBOARD_STORED_REFRESH_MS);

  // Project list. Two aggregates over messages plus a filesystem pass —
  // about 5s, which starves the single-threaded web process if it runs
  // there. Built here, read there.
  const refreshProjects = async () => {
    try {
      const t0 = Date.now();
      const rows = await refreshProjectList({ unlessCurrentMs: PROJECT_LIST_MAX_QUIET_MS });
      if (rows === null) return;
      console.log(`[payloads] project list: ${rows.length} projects in ${Date.now() - t0}ms`);
    } catch (err) {
      console.error('[payloads] project list refresh failed:', err);
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
      console.log(`[payloads] scrobble payload refreshed in ${Date.now() - t0}ms`);
    } catch (err) {
      console.error('[payloads] scrobble refresh failed:', err);
    }
  };
  const scrobbleKickoff = setTimeout(refreshScrobble, 20_000);
  const scrobbleInterval = setInterval(refreshScrobble, SCROBBLE_REFRESH_MS);

  // Tokens payloads. Lifetime is 11 s of scans and the page's week was 6 s
  // on the request thread; built here and stored, like the dashboard. The
  // stored tick carries any range a first request built and stored, so that
  // build is not the one served forever, on the dashboard's slower cadence.
  const refreshTokens = (ranges: readonly string[], unlessCurrentMs: number) =>
    refreshRanges('tokens', refreshTokensPayload, ranges, unlessCurrentMs);
  const storedTokens = () => storedBeyond(storedTokensRanges, WARM_TOKENS_SHORT_RANGES, WARM_TOKENS_LONG_RANGES);
  const tokensKickoff = setTimeout(() => {
    refreshTokens(WARM_TOKENS_SHORT_RANGES, TOKENS_MAX_QUIET_MS);
    refreshTokens(WARM_TOKENS_LONG_RANGES, TOKENS_LONG_MAX_QUIET_MS);
  }, 16_000);
  const tokensInterval = setInterval(() => refreshTokens(WARM_TOKENS_SHORT_RANGES, TOKENS_MAX_QUIET_MS), TOKENS_REFRESH_MS);
  const tokensLongInterval = setInterval(() => refreshTokens(WARM_TOKENS_LONG_RANGES, TOKENS_LONG_MAX_QUIET_MS), TOKENS_LONG_REFRESH_MS);
  const tokensStoredKickoff = setTimeout(() => refreshTokens(storedTokens(), TOKENS_STORED_MAX_QUIET_MS), 50_000);
  const tokensStoredInterval = setInterval(() => refreshTokens(storedTokens(), TOKENS_STORED_MAX_QUIET_MS), TOKENS_STORED_REFRESH_MS);

  const stop = (why: string) => {
    console.log(`[payloads] ${why}, stopping`);
    process.exit(0);
  };
  process.on('disconnect', () => stop('parent gone'));
  for (const signal of ['SIGINT', 'SIGTERM'] as const) process.on(signal, () => stop(signal));
  // A parent SIGKILLed before the channel closed leaves us orphaned to pid 1.
  setInterval(() => { if (process.ppid === 1) stop('orphaned'); }, 5_000).unref();

  process.on('uncaughtException', (err) => console.error('[payloads] uncaughtException (continuing):', err));
  process.on('unhandledRejection', (reason) => console.error('[payloads] unhandledRejection (continuing):', reason));
}

// Forked by the worker (see startPayloadBuilder); importable by tests.
if (process.env.UNFIREHOSE_PAYLOADS_CHILD === '1') main();
