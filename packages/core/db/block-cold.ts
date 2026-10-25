/**
 * Cold storage for content-block text: a retention window the user chooses.
 *
 * Block text (prose, reasoning, tool inputs and results) is most of our
 * database: on 2026-10-23 fox's box held 2.35 M blocks in 7.0 GB. Nothing
 * that counts reads it — tokens, costs and message counts live on
 * `messages` — so old text can be packed away without moving one number.
 *
 * With a window set (say 90 days), blocks of messages older than it have
 * `text_content` and `tool_input` compressed into `content_blocks_cold`,
 * keyed by block id, and the hot row keeps everything else with both
 * columns NULL and `cold = 1`. Nothing is deleted: a reader asks for
 * `blockTextSql('cb')` instead of `cb.text_content` and gets the original
 * bytes back, decompressed in SQL by `unfirehose_unz()`, which every
 * connection registers in migrate(). `thawBatch` puts text back hot.
 *
 * Default: no window, nothing moves. The move runs in our worker in small
 * batches while ingest is quiet, the way mesh-rollup folds old snapshots
 * into a cold tier.
 *
 * Codec: brotli (node's zlib), text mode, quality 5. Measured on our own
 * block text it packs prose and JSON tool input to roughly a quarter, and
 * decompresses in microseconds, which is what a reader waits on. Each row
 * names its codec so a later change can live beside old rows.
 */

import type Database from 'better-sqlite3';
import { brotliCompressSync, brotliDecompressSync, constants as zc } from 'zlib';

export const COLD_CODEC = 'br';
export const RETENTION_SETTING_KEY = 'block_text_retention_days';
export const RETENTION_CURSOR_KEY = 'block_text_retention_cursor';
/** Shortest window we accept. Recent text feeds session naming, todo and rate-limit extraction and the 30-day prompt lists; those stay hot. */
export const MIN_RETENTION_DAYS = 30;
/** Windows the Settings control offers. */
export const RETENTION_CHOICES = [30, 90, 180, 365] as const;
const DAY_MS = 86_400_000;
/** Per cold row: rowid, codec, two blob headers, raw size, moved_at. An estimate, used only for the dry run. */
const COLD_ROW_OVERHEAD_BYTES = 40;

const BROTLI_OPTS = {
  params: {
    [zc.BROTLI_PARAM_MODE]: zc.BROTLI_MODE_TEXT,
    [zc.BROTLI_PARAM_QUALITY]: 5,
  },
};

/** Compress one field. NULL stays NULL, so a block without that field reads back without it. */
export function compressText(text: string | null | undefined): Buffer | null {
  if (text == null) return null;
  return brotliCompressSync(Buffer.from(text, 'utf8'), BROTLI_OPTS);
}

export function decompressText(blob: Buffer | Uint8Array | null | undefined): string | null {
  if (blob == null) return null;
  return brotliDecompressSync(blob).toString('utf8');
}

/**
 * `unfirehose_unz(blob)` in SQL. Pure, so SQLite may treat it as
 * deterministic. Idempotent: migrate() calls it on every connection.
 */
export function registerColdFunctions(db: Database.Database): void {
  db.function('unfirehose_unz', { deterministic: true }, (blob: unknown) => {
    if (blob == null) return null;
    return decompressText(blob as Buffer);
  });
}

/**
 * A block's text, hot or cold, as a SQL expression on alias `a`. Use it
 * wherever a query reads `text_content`, in SELECT or WHERE alike, and a
 * cold row answers exactly as it did before it moved. Costs one primary-key
 * lookup and a decompress, only for cold rows.
 */
export function blockTextSql(a = 'cb'): string {
  return `(CASE WHEN ${a}.cold = 1 THEN unfirehose_unz((SELECT text_z FROM content_blocks_cold WHERE block_id = ${a}.id)) ELSE ${a}.text_content END)`;
}

/** The same for `tool_input`. */
export function blockToolInputSql(a = 'cb'): string {
  return `(CASE WHEN ${a}.cold = 1 THEN unfirehose_unz((SELECT tool_input_z FROM content_blocks_cold WHERE block_id = ${a}.id)) ELSE ${a}.tool_input END)`;
}

// ---------------------------------------------------------------- setting

function readSetting(db: Database.Database, key: string): string | null {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key) as { value: string } | undefined;
  return row?.value ?? null;
}

function writeSetting(db: Database.Database, key: string, value: string): void {
  db.prepare(
    `INSERT INTO settings (key, value, updated_at) VALUES (?, ?, datetime('now'))
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
  ).run(key, value);
}

/** Days of block text kept hot, or null: keep everything (our default). */
export function getRetentionDays(db: Database.Database): number | null {
  const n = parseInt(readSetting(db, RETENTION_SETTING_KEY) ?? '', 10);
  return Number.isFinite(n) && n >= MIN_RETENTION_DAYS ? n : null;
}

/** Validate a requested window. Null, 0, '' or 'off' mean keep everything. */
export function parseRetentionDays(v: unknown): number | null | 'invalid' {
  if (v == null || v === '' || v === 0 || v === 'off') return null;
  const n = typeof v === 'number' ? v : parseInt(String(v), 10);
  if (!Number.isInteger(n) || n < MIN_RETENTION_DAYS || n > 36_500) return 'invalid';
  return n;
}

export function setRetentionDays(db: Database.Database, days: number | null): void {
  if (days == null) {
    db.prepare('DELETE FROM settings WHERE key = ?').run(RETENTION_SETTING_KEY);
    return;
  }
  if (!Number.isInteger(days) || days < MIN_RETENTION_DAYS) {
    throw new Error(`retention window must be a whole number of days, at least ${MIN_RETENTION_DAYS}`);
  }
  writeSetting(db, RETENTION_SETTING_KEY, String(days));
}

export function retentionCutoff(days: number, now: number = Date.now()): string {
  return new Date(now - days * DAY_MS).toISOString();
}

// ---------------------------------------------------------------- stats

export interface ColdStats {
  blocks: number;
  /** Bytes of text the cold rows hold once decompressed. */
  rawBytes: number;
  /** Bytes the compressed blobs take. */
  storedBytes: number;
}

export const COLD_TOTALS_KEY = 'block_text_cold_totals';

/**
 * Running totals, kept in settings by every freeze and thaw inside the same
 * transaction, so a Settings page load reads one row instead of scanning a
 * cold table that may hold millions. `recountColdStats` is the exact answer;
 * the daily size snapshot calls it and rewrites the totals.
 */
export function coldStats(db: Database.Database): ColdStats {
  try {
    const t = JSON.parse(readSetting(db, COLD_TOTALS_KEY) ?? 'null');
    if (t && Number.isFinite(t.blocks)) return { blocks: t.blocks, rawBytes: t.rawBytes ?? 0, storedBytes: t.storedBytes ?? 0 };
  } catch { /* fall through to a recount */ }
  return recountColdStats(db);
}

function bumpColdTotals(db: Database.Database, d: ColdStats): void {
  // No totals yet: a recount, taken inside this transaction, already
  // includes the rows just written.
  if (readSetting(db, COLD_TOTALS_KEY) == null) { recountColdStats(db); return; }
  const t = coldStats(db);
  writeSetting(db, COLD_TOTALS_KEY, JSON.stringify({
    blocks: Math.max(0, t.blocks + d.blocks),
    rawBytes: Math.max(0, t.rawBytes + d.rawBytes),
    storedBytes: Math.max(0, t.storedBytes + d.storedBytes),
  }));
}

/** Exact cold totals, by scanning the cold table; rewrites the running totals. */
export function recountColdStats(db: Database.Database): ColdStats {
  const r = db.prepare(`
    SELECT COUNT(*) AS blocks,
           COALESCE(SUM(raw_bytes), 0) AS rawBytes,
           COALESCE(SUM(COALESCE(LENGTH(text_z), 0) + COALESCE(LENGTH(tool_input_z), 0)), 0) AS storedBytes
      FROM content_blocks_cold
  `).get() as ColdStats;
  const out = { blocks: r.blocks, rawBytes: r.rawBytes, storedBytes: r.storedBytes };
  writeSetting(db, COLD_TOTALS_KEY, JSON.stringify(out));
  return out;
}

const rawBytesSql = (a: string) =>
  `COALESCE(octet_length(${a}.text_content), 0) + COALESCE(octet_length(${a}.tool_input), 0)`;

/**
 * Blocks smaller than this stay hot. Brotli plus a cold row costs about
 * forty bytes, so packing a one-line reply grows our database; measured on
 * the demo seed, blocks averaging 44 bytes packed to 96% of their size
 * before the row overhead. Large blocks are where the bytes are.
 */
export const MIN_COLD_BYTES = 256;

const eligible = (a: string) => `cold = 0 AND ${rawBytesSql(a)} >= ?`;

const ELIGIBLE = `
  FROM messages m
  JOIN content_blocks cb ON cb.message_id = m.id
 WHERE m.timestamp < ?
   AND cb.${eligible('cb')}`;

export interface ColdEstimate {
  days: number;
  cutoff: string;
  /** Hot blocks older than the window carrying at least MIN_COLD_BYTES. */
  blocks: number;
  rawBytes: number;
  /** Compressed size, from a sample of those blocks. */
  estimatedColdBytes: number;
  /** What leaves our hot rows minus what the cold table adds. Disk shrinks by this after a VACUUM. */
  estimatedSavedBytes: number;
  /** compressed / raw over the sample; 1 when there was nothing to sample. */
  ratio: number;
  sampled: number;
}

/**
 * Dry run: what a window would move, and roughly what it would save.
 * Reads every eligible block's length once, so on millions of rows this is
 * seconds, not milliseconds: run it on request, never on page load.
 */
export function estimateColdMove(
  db: Database.Database,
  days: number,
  opts: { now?: number; sampleSize?: number; minBytes?: number } = {},
): ColdEstimate {
  const cutoff = retentionCutoff(days, opts.now);
  const minBytes = opts.minBytes ?? MIN_COLD_BYTES;
  const totals = db.prepare(`SELECT COUNT(*) AS blocks, COALESCE(SUM(${rawBytesSql('cb')}), 0) AS rawBytes ${ELIGIBLE}`)
    .get(cutoff, minBytes) as { blocks: number; rawBytes: number };

  const sampleSize = opts.sampleSize ?? 400;
  let sampledRaw = 0;
  let sampledPacked = 0;
  let sampled = 0;
  if (totals.blocks > 0) {
    // Every k-th block rather than ORDER BY random(): no sort over millions.
    const stride = Math.max(1, Math.floor(totals.blocks / sampleSize));
    const rows = db.prepare(`SELECT cb.text_content AS t, cb.tool_input AS i ${ELIGIBLE} AND cb.id % ? = 0 LIMIT ?`)
      .all(cutoff, minBytes, stride, sampleSize) as Array<{ t: string | null; i: string | null }>;
    for (const r of rows) {
      sampledRaw += Buffer.byteLength(r.t ?? '', 'utf8') + Buffer.byteLength(r.i ?? '', 'utf8');
      sampledPacked += (compressText(r.t)?.length ?? 0) + (compressText(r.i)?.length ?? 0);
      sampled++;
    }
  }
  const ratio = sampledRaw > 0 ? sampledPacked / sampledRaw : 1;
  const estimatedColdBytes = Math.round(totals.rawBytes * ratio) + totals.blocks * COLD_ROW_OVERHEAD_BYTES;
  return {
    days,
    cutoff,
    blocks: totals.blocks,
    rawBytes: totals.rawBytes,
    estimatedColdBytes,
    estimatedSavedBytes: Math.max(0, totals.rawBytes - estimatedColdBytes),
    ratio,
    sampled,
  };
}

// ---------------------------------------------------------------- move

interface Cursor {
  /** The window this sweep was started for; a different window restarts it. */
  days: number;
  /** Last message the timestamp walk has passed. */
  ts: string;
  id: number;
  /** messages.id high-water mark when late arrivals were last checked. */
  maxId: number;
}

function readCursor(db: Database.Database): Cursor | null {
  try {
    const c = JSON.parse(readSetting(db, RETENTION_CURSOR_KEY) ?? 'null');
    return c && typeof c.ts === 'string' ? c as Cursor : null;
  } catch {
    return null;
  }
}

export interface FreezeResult {
  messages: number;
  blocks: number;
  rawBytes: number;
  storedBytes: number;
  /** Nothing older than the window is left hot, as of this batch. */
  caughtUp: boolean;
}

const NOTHING: FreezeResult = { messages: 0, blocks: 0, rawBytes: 0, storedBytes: 0, caughtUp: true };

/**
 * Move one batch of old block text into the cold table. One transaction,
 * at most `maxMessages` messages' blocks, so a call holds the write lock
 * for milliseconds. Call it until `caughtUp`.
 *
 * Messages are walked in (timestamp, id) order from a saved cursor, so a
 * batch never rereads what an earlier one passed. Messages ingested after
 * the walk went by but stamped older than it (a backfill of old logs) are
 * caught by id: everything above the last high-water mark and behind the
 * cursor is moved first.
 */
export function freezeBatch(
  db: Database.Database,
  opts: { days?: number | null; now?: number; maxMessages?: number; minBytes?: number } = {},
): FreezeResult {
  const days = opts.days === undefined ? getRetentionDays(db) : opts.days;
  if (days == null) return NOTHING;
  const cutoff = retentionCutoff(days, opts.now);
  const maxMessages = opts.maxMessages ?? 500;

  const selectBlocks = db.prepare(`
    SELECT id, text_content, tool_input FROM content_blocks
     WHERE message_id = ? AND ${eligible('content_blocks')}
  `);
  const minBytes = opts.minBytes ?? MIN_COLD_BYTES;
  const insertCold = db.prepare(`
    INSERT OR REPLACE INTO content_blocks_cold (block_id, codec, text_z, tool_input_z, raw_bytes)
    VALUES (?, ?, ?, ?, ?)
  `);
  const markCold = db.prepare('UPDATE content_blocks SET text_content = NULL, tool_input = NULL, cold = 1 WHERE id = ?');

  return db.transaction((): FreezeResult => {
    const maxNow = (db.prepare('SELECT COALESCE(MAX(id), 0) AS n FROM messages').get() as { n: number }).n;
    let cursor = readCursor(db);
    if (!cursor || cursor.days !== days) cursor = { days, ts: '', id: 0, maxId: maxNow };

    // Late arrivals behind the walk.
    let late: number[] = [];
    if (cursor.ts) {
      late = (db.prepare(`
        SELECT id FROM messages WHERE id > ? AND id <= ? AND timestamp <= ? AND timestamp < ?
         ORDER BY id LIMIT ?
      `).all(cursor.maxId, maxNow, cursor.ts, cutoff, maxMessages) as { id: number }[]).map((r) => r.id);
    }
    const lateFull = late.length === maxMessages;
    const nextMaxId = lateFull ? late[late.length - 1] : maxNow;

    const room = maxMessages - late.length;
    const walk = room > 0
      ? db.prepare(`
          SELECT id, timestamp FROM messages
           WHERE timestamp >= ? AND (timestamp > ? OR id > ?) AND timestamp < ?
           ORDER BY timestamp, id LIMIT ?
        `).all(cursor.ts, cursor.ts, cursor.id, cutoff, room) as { id: number; timestamp: string }[]
      : [];

    const out: FreezeResult = { messages: 0, blocks: 0, rawBytes: 0, storedBytes: 0, caughtUp: false };
    for (const messageId of [...late, ...walk.map((w) => w.id)]) {
      out.messages++;
      for (const b of selectBlocks.all(messageId, minBytes) as Array<{ id: number; text_content: string | null; tool_input: string | null }>) {
        const tz = compressText(b.text_content);
        const iz = compressText(b.tool_input);
        const raw = Buffer.byteLength(b.text_content ?? '', 'utf8') + Buffer.byteLength(b.tool_input ?? '', 'utf8');
        insertCold.run(b.id, COLD_CODEC, tz, iz, raw);
        markCold.run(b.id);
        out.blocks++;
        out.rawBytes += raw;
        out.storedBytes += (tz?.length ?? 0) + (iz?.length ?? 0);
      }
    }

    const last = walk[walk.length - 1];
    const next: Cursor = { days, ts: last ? last.timestamp : cursor.ts, id: last ? last.id : cursor.id, maxId: nextMaxId };
    writeSetting(db, RETENTION_CURSOR_KEY, JSON.stringify(next));
    if (out.blocks > 0) bumpColdTotals(db, { blocks: out.blocks, rawBytes: out.rawBytes, storedBytes: out.storedBytes });
    out.caughtUp = !lateFull && walk.length < room;
    return out;
  })();
}

export interface ThawResult {
  blocks: number;
  /** Nothing in scope is left cold. */
  done: boolean;
}

/**
 * Put cold text back in its hot rows, a batch at a time. With `keepDays`,
 * only blocks whose message is inside that window (for a window made
 * longer); without, every cold block (retention turned off). Byte-for-byte
 * what was moved: the cold row is deleted only after its hot row has the
 * text again, in the same transaction.
 */
export function thawBatch(
  db: Database.Database,
  opts: { limit?: number; keepDays?: number | null; now?: number } = {},
): ThawResult {
  const limit = opts.limit ?? 2000;
  const scope = opts.keepDays != null
    ? { join: 'JOIN content_blocks cb ON cb.id = c.block_id JOIN messages m ON m.id = cb.message_id', where: 'WHERE m.timestamp >= ?', params: [retentionCutoff(opts.keepDays, opts.now)] }
    : { join: '', where: '', params: [] as string[] };
  const restore = db.prepare('UPDATE content_blocks SET text_content = ?, tool_input = ?, cold = 0 WHERE id = ?');
  const drop = db.prepare('DELETE FROM content_blocks_cold WHERE block_id = ?');

  return db.transaction((): ThawResult => {
    const rows = db.prepare(`SELECT c.block_id, c.text_z, c.tool_input_z, c.raw_bytes FROM content_blocks_cold c ${scope.join} ${scope.where} LIMIT ?`)
      .all(...scope.params, limit) as Array<{ block_id: number; text_z: Buffer | null; tool_input_z: Buffer | null; raw_bytes: number }>;
    const d: ColdStats = { blocks: 0, rawBytes: 0, storedBytes: 0 };
    for (const r of rows) {
      restore.run(decompressText(r.text_z), decompressText(r.tool_input_z), r.block_id);
      drop.run(r.block_id);
      d.blocks--;
      d.rawBytes -= r.raw_bytes;
      d.storedBytes -= (r.text_z?.length ?? 0) + (r.tool_input_z?.length ?? 0);
    }
    if (rows.length) bumpColdTotals(db, d);
    return { blocks: rows.length, done: rows.length < limit };
  })();
}

/**
 * Replace a block's text wherever it lives: the hot column, or the cold
 * blob (repacked, raw size corrected). For rewrites like the PII backfill,
 * which must reach old text too. Cold totals catch up at the next daily
 * recount.
 */
export function rewriteBlockText(db: Database.Database, blockId: number, text: string | null): void {
  const row = db.prepare('SELECT cold FROM content_blocks WHERE id = ?').get(blockId) as { cold: number } | undefined;
  if (!row) return;
  if (!row.cold) {
    db.prepare('UPDATE content_blocks SET text_content = ? WHERE id = ?').run(text, blockId);
    return;
  }
  const c = db.prepare('SELECT text_z, tool_input_z FROM content_blocks_cold WHERE block_id = ?').get(blockId) as { text_z: Buffer | null; tool_input_z: Buffer | null } | undefined;
  if (!c) return;
  const raw = Buffer.byteLength(text ?? '', 'utf8') + Buffer.byteLength(decompressText(c.tool_input_z) ?? '', 'utf8');
  db.prepare('UPDATE content_blocks_cold SET text_z = ?, raw_bytes = ? WHERE block_id = ?').run(compressText(text), raw, blockId);
}
