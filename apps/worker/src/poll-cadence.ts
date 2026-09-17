/**
 * How long until the next full ingest pass.
 *
 * The full pass is the safety net under the file watcher: every journal on
 * the box is stat'd (~47k, ~1.5 s with nothing new, measured 2026-09-17).
 * While something is landing it runs every minute. When a pass finds
 * nothing and the watcher has seen nothing since the last one, the wait
 * doubles, up to POLL_QUIET_MAX_MS; the first new byte the watcher sees is
 * ingested by a targeted pass at once, and the next full pass is a minute
 * after that.
 */

export const POLL_INTERVAL_MS = 60_000;
export const POLL_QUIET_MAX_MS = 5 * 60_000;

export function nextPollDelayMs(previousMs: number, activeSinceLastPass: boolean): number {
  if (activeSinceLastPass) return POLL_INTERVAL_MS;
  return Math.min(POLL_QUIET_MAX_MS, Math.max(POLL_INTERVAL_MS, previousMs) * 2);
}
