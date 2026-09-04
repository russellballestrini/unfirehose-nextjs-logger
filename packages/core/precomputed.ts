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

export interface Stored<T> {
  payload: T;
  /** ISO timestamp of the build, for an X-Computed-At header. */
  at: string;
}

/** Write a payload and stamp it. */
export function storePayload(key: string, payload: unknown): void {
  setSetting(key, JSON.stringify(payload));
  setSetting(`${key}_at`, new Date().toISOString());
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
