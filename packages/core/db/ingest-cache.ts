// Per-pass caches and hot-path helpers shared by every ingest reader:
// fleet roots, directory listings, prepared statements and the byte offsets
// a pass resumes from. Extracted from ingest.ts; ingest.ts stays the public
// entry point.
import { readdirSync, statSync } from 'fs';
import type { Stats } from 'fs';
import type { getDb } from './schema';
import { discoverFleetHarnesses } from '../fleet-roots';

// Fleet roots are other homes on this box, found by walking them; that walk
// was 0.5 s of every pass (measured 2026-09-17) to rediscover the same
// homes. A worker home appears on the order of minutes, so this is
// remembered for a while.
const FLEET_TTL_MS = 5 * 60_000;
let _fleet: { at: number; value: ReturnType<typeof discoverFleetHarnesses> } | null = null;
export function fleetHarnesses() {
  if (_fleet && Date.now() - _fleet.at < FLEET_TTL_MS) return _fleet.value;
  _fleet = { at: Date.now(), value: discoverFleetHarnesses() };
  return _fleet.value;
}

// A directory's listing, remembered against its mtime. A directory's mtime
// moves when an entry is created, renamed or removed — exactly when its
// listing changes — and not when a file inside it grows. So a project
// directory that lists the same journals as last pass costs one stat, not a
// readdir plus a path.join per entry: ~24k readdirs a pass, 0.9 s, measured
// 2026-09-17.
const _listingCache = new Map<string, { mtimeMs: number; files: string[] }>();
export function jsonlListing(dir: string, dirMtimeMs: number): string[] {
  const hit = _listingCache.get(dir);
  if (hit && hit.mtimeMs === dirMtimeMs) return hit.files;
  const files = readdirSyncSafe(dir).filter((f) => f.endsWith('.jsonl'));
  _listingCache.set(dir, { mtimeMs: dirMtimeMs, files });
  return files;
}

// ── Per-pass hot paths ───────────────────────────────────────────────────
// A quiet pass (nothing new anywhere) still visits every project directory
// and every journal to learn that: ~10k directories, ~24k files, one offset
// lookup each. Measured 2026-09-17 that pass took 26 s, of which 16 s was
// fs/promises round trips through the thread pool (a stat is microseconds;
// the await around it is not) and 4 s was re-preparing the same statements
// inside the loops. The pass runs every minute and after every write burst,
// which came to 83% of one core, steadily, with nothing to ingest.
//
// So the no-new-bytes checks are synchronous — a batch pass on a worker with
// no requests to serve, where blocking for 20 µs beats yielding for 400 — and
// the statements it repeats are prepared once per database.
export function statSyncSafe(p: string): Stats | null {
  try { return statSync(p); } catch { return null; }
}
export function readdirSyncSafe(p: string, opts?: { recursive?: boolean }): string[] {
  try { return readdirSync(p, opts) as string[]; } catch { return []; }
}
export type Db = ReturnType<typeof getDb>;
const _stmtCache = new WeakMap<Db, Map<string, ReturnType<Db['prepare']>>>();
export function stmt(db: Db, sql: string) {
  let m = _stmtCache.get(db);
  if (!m) { m = new Map(); _stmtCache.set(db, m); }
  let st = m.get(sql);
  if (!st) { st = db.prepare(sql); m.set(sql, st); }
  return st;
}
// Where ingest last stopped in every file, read once per pass. A quiet pass
// asks this ~47k times (one per journal, every source); as 47k point
// lookups that was 1.1 s of the pass, as one scan of 80k rows into a Map it
// is ~80 ms. Set for the duration of ingestAll; a standalone caller of
// ingestJsonlSource has no snapshot and falls back to the lookup.
let _offsetsSnapshot: Map<string, number> | null = null;
export function snapshotOffsets(db: Db): Map<string, number> {
  const m = new Map<string, number>();
  for (const r of db.prepare('SELECT file_path, byte_offset FROM ingest_offsets').iterate() as Iterable<{ file_path: string; byte_offset: number }>) {
    m.set(r.file_path, r.byte_offset);
  }
  return m;
}
/** Install the pass's offsets snapshot, or clear it with null. Called by ingestAll. */
export function setOffsetsSnapshot(snapshot: Map<string, number> | null): void {
  _offsetsSnapshot = snapshot;
}
export function knownOffset(db: Db, filePath: string): number | undefined {
  if (_offsetsSnapshot) return _offsetsSnapshot.get(filePath);
  const row = stmt(db, 'SELECT byte_offset FROM ingest_offsets WHERE file_path = ?')
    .get(filePath) as { byte_offset: number } | undefined;
  return row?.byte_offset;
}
