/**
 * Payloads the worker builds and a route serves.
 *
 * Three of these grew independently — the dashboard, the project list, the
 * scrobble payload — and each carried its own copy of the same store: write
 * JSON and a timestamp under two settings keys, read them back, treat a
 * missing key, a stale timestamp or unparseable JSON as "no answer". Three
 * copies of that is three places for a stale check to be wrong.
 *
 * The reason any of them exist is in packages/core/dashboard.ts: this server
 * is single-threaded, so work measured in seconds must not run in the
 * process that answers requests.
 */

import { getSetting, setSetting } from './db/ingest';
import { getDb } from './db/schema';

export interface Stored<T> {
  payload: T;
  /** ISO timestamp of the build, for an X-Computed-At header. */
  at: string;
}

/**
 * What the payloads are built from, as one number: the highest message
 * rowid. Ingest only appends, so a pass that added nothing leaves it where
 * it was, and a rebuild would write back the payload already stored. Two
 * builds a minute of the dashboard, four an hour of the project list, were
 * the worker's whole idle load once a quiet ingest pass was made cheap.
 */
export function messagesWatermark(): string {
  const row = getDb().prepare('SELECT MAX(id) AS id FROM messages').get() as { id: number | null } | undefined;
  return String(row?.id ?? 0);
}

/**
 * Write a payload and stamp it with the watermark it was built from. Read
 * the watermark before the build, not after: a message that lands during a
 * multi-second build is not in the payload, and a stamp taken afterwards
 * would say it was.
 */
export function storePayload(key: string, payload: unknown, watermark: string = messagesWatermark()): void {
  setSetting(key, JSON.stringify(payload));
  setSetting(`${key}_at`, new Date().toISOString());
  setSetting(`${key}_watermark`, watermark);
}

/**
 * True when rebuilding would store what is already there: the same
 * watermark, and a build younger than maxAgeMs. The age bound is what keeps
 * a sliding window honest — a 24h range moves with the clock, and mesh
 * energy samples land without adding a message — so a quiet hour still
 * rebuilds every maxAgeMs, and a busy one rebuilds every tick.
 */
export function payloadCurrent(key: string, maxAgeMs: number, watermark: string = messagesWatermark()): boolean {
  if (getSetting(`${key}_watermark`) !== watermark) return false;
  return readPayload(key, maxAgeMs) !== null;
}

/**
 * The stored payload when it is fresh enough, else null.
 *
 * Every failure reads the same: no answer. A caller that cannot tell "never
 * built" from "built badly" is a caller that does the right thing either
 * way — build it now.
 */
export function readPayload<T>(key: string, maxAgeMs: number): Stored<T> | null {
  const raw = getSetting(key);
  const at = getSetting(`${key}_at`);
  if (!raw || !at) return null;

  const age = Date.now() - Date.parse(at);
  if (!Number.isFinite(age) || age > maxAgeMs) return null;

  try {
    return { payload: JSON.parse(raw) as T, at };
  } catch {
    return null;
  }
}
