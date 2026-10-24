/**
 * Alert delivery from the worker.
 *
 * checkThresholds writes alert rows during ingest; this sends them where a
 * user's rules say (packages/core/db/alert-delivery). It runs on its own
 * short timer and once right after an ingest that raised alerts. Its work
 * is a few small queries and awaited HTTP calls, so it holds this thread
 * for milliseconds, never for an ingest's worth. Single-flight: a slow
 * destination cannot stack ticks. With no enabled rule a tick is one
 * indexed SELECT and nothing is sent.
 *
 * Logs counts only. A destination URL or secret never reaches a log line.
 */
import type Database from 'better-sqlite3';
import { deliverDue, hasEnabledRules, type SecretStore, type Sender, type DeliverySummary } from '@unturf/unfirehose/db/alert-delivery';

export const ALERT_DELIVERY_TICK_MS = 30_000;

export function createAlertTicker(opts: {
  db: () => Database.Database;
  store: () => SecretStore;
  send?: Sender;
  log?: (line: string) => void;
  now?: () => Date;
}) {
  const log = opts.log ?? ((l: string) => console.log(l));
  let inFlight = false;
  return async function tick(): Promise<DeliverySummary | null> {
    if (inFlight) return null;
    inFlight = true;
    try {
      const db = opts.db();
      if (!hasEnabledRules(db)) return null;
      const s = await deliverDue(db, opts.store(), opts.send, opts.now?.() ?? new Date());
      if (s.sent || s.retrying || s.failed || s.rateLimited) {
        log(`[worker] alert delivery: ${s.sent} sent, ${s.retrying} retrying, ${s.failed} failed, ${s.rateLimited} rate-limited`);
      }
      return s;
    } catch (err) {
      log(`[worker] alert delivery failed: ${(err as Error).message}`);
      return null;
    } finally {
      inFlight = false;
    }
  };
}
