/**
 * Has anything ever landed in this table?
 *
 * A page that filters by range cannot tell, from its own rows, a quiet week
 * from a fresh install: both arrive as zero. The empty state they show must
 * differ — a person with a year of sessions does not need to be told to
 * install a harness — so a route that serves a ranged payload also answers
 * this. `SELECT 1 … LIMIT 1` stops at the first row, so it costs the same on
 * ten rows as on ten million.
 *
 * A missing table reads as never: it means a database older than the
 * feature, which has by definition never held a row of it.
 */

export type EverTable = 'sessions' | 'messages' | 'mesh_snapshots' | 'mesh_snapshots_15m';

// Interpolated into SQL, so only names from this list ever reach a query.
const TABLES: ReadonlySet<string> = new Set<EverTable>([
  'sessions', 'messages', 'mesh_snapshots', 'mesh_snapshots_15m',
]);

interface Db {
  prepare(sql: string): { get(...params: unknown[]): unknown };
}

export function hasAny(db: Db, table: EverTable): boolean {
  if (!TABLES.has(table)) return false;
  try {
    return db.prepare(`SELECT 1 FROM ${table} LIMIT 1`).get() !== undefined;
  } catch {
    return false;
  }
}
