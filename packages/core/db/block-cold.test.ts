import { describe, it, expect, beforeEach } from 'vitest';
import type Database from 'better-sqlite3';
import { createTestDb, seedProject, seedSession, seedMessage } from '../test/db-helper';
import {
  compressText, decompressText, blockTextSql, blockToolInputSql,
  getRetentionDays, setRetentionDays, parseRetentionDays, MIN_RETENTION_DAYS,
  estimateColdMove, freezeBatch, thawBatch, coldStats, recountColdStats,
} from './block-cold';

const DAY = 86_400_000;
// With minBytes: 1, every block that carries a byte.
const COLD_EXPECTED = 12 * 2 + 6 - 5;
const NOW = Date.parse('2026-10-23T12:00:00Z');
const ago = (days: number) => new Date(NOW - days * DAY).toISOString();

// Text that must come back exactly: multi-byte UTF-8, emoji, NULs, CRLF,
// trailing whitespace, an empty string, and something big enough to
// compress.
const TRICKY = [
  'héllo wörld — “quotes” ✓ 🦊 \u0000 nul\r\nCRLF  trailing   ',
  '',
  'x'.repeat(50_000) + 'end',
  JSON.stringify({ command: 'rm -rf /tmp/a && echo "ok"', nested: { a: [1, 2, 3], s: 'ü' } }),
  '\u{1F600}'.repeat(1000),
];

let db: Database.Database;
let sessionId: number;

function addBlock(messageId: number, pos: number, type: string, text: string | null, toolInput: string | null = null) {
  return db.prepare(
    'INSERT INTO content_blocks (message_id, position, block_type, text_content, tool_name, tool_input) VALUES (?, ?, ?, ?, ?, ?)',
  ).run(messageId, pos, type, text, toolInput ? 'Bash' : null, toolInput).lastInsertRowid as number;
}

function snapshotAll() {
  return db.prepare(`
    SELECT id, message_id, position, block_type, tool_name, tool_use_id, is_error,
           ${blockTextSql('cb')} AS text_content, ${blockToolInputSql('cb')} AS tool_input
      FROM content_blocks cb ORDER BY id
  `).all();
}

function aggregates() {
  return db.prepare(`
    SELECT COUNT(*) AS messages, SUM(input_tokens) AS input, SUM(output_tokens) AS output,
           (SELECT COUNT(*) FROM content_blocks) AS blocks,
           (SELECT COUNT(*) FROM content_blocks WHERE block_type = 'tool_use') AS tools
      FROM messages
  `).get();
}

beforeEach(() => {
  db = createTestDb();
  const p = seedProject(db);
  sessionId = seedSession(db, p);
});

describe('codec', () => {
  it('round-trips every tricky string byte for byte, and NULL as NULL', () => {
    for (const t of TRICKY) {
      const back = decompressText(compressText(t));
      expect(back).toBe(t);
      expect(Buffer.from(back!, 'utf8').equals(Buffer.from(t, 'utf8'))).toBe(true);
    }
    expect(compressText(null)).toBeNull();
    expect(decompressText(null)).toBeNull();
  });

  it('is registered in SQL on every migrated connection', () => {
    const blob = compressText('from sql');
    expect((db.prepare('SELECT unfirehose_unz(?) AS t').get(blob) as { t: string }).t).toBe('from sql');
    expect((db.prepare('SELECT unfirehose_unz(NULL) AS t').get() as { t: null }).t).toBeNull();
  });
});

describe('retention setting', () => {
  it('defaults to keep everything', () => {
    expect(getRetentionDays(db)).toBeNull();
    expect(freezeBatch(db, { now: NOW })).toMatchObject({ blocks: 0, caughtUp: true });
  });

  it('leaves blocks too small to pay for packing hot by default', () => {
    const m = seedMessage(db, sessionId, { timestamp: ago(200) });
    const small = addBlock(m, 0, 'text', 'ok, done.');
    const big = addBlock(m, 1, 'text', 'a longer reply that is worth packing. '.repeat(10));
    while (!freezeBatch(db, { days: 90, now: NOW }).caughtUp) { /* drain */ }
    const cold = (id: number) => (db.prepare('SELECT cold FROM content_blocks WHERE id = ?').get(id) as { cold: number }).cold;
    expect([cold(small), cold(big)]).toEqual([0, 1]);
    expect(estimateColdMove(db, 90, { now: NOW, minBytes: 1 }).blocks).toBe(1);
  });

  it('stores a window and clears it', () => {
    setRetentionDays(db, 90);
    expect(getRetentionDays(db)).toBe(90);
    setRetentionDays(db, null);
    expect(getRetentionDays(db)).toBeNull();
  });

  it('refuses windows shorter than the minimum', () => {
    expect(() => setRetentionDays(db, 7)).toThrow();
    expect(parseRetentionDays(7)).toBe('invalid');
    expect(parseRetentionDays('90')).toBe(90);
    expect(parseRetentionDays(null)).toBeNull();
    expect(parseRetentionDays('off')).toBeNull();
    expect(parseRetentionDays(MIN_RETENTION_DAYS)).toBe(MIN_RETENTION_DAYS);
  });
});

describe('freeze and thaw', () => {
  function seedHistory() {
    const ids: number[] = [];
    // 12 old messages (200 days), 3 recent (5 days)
    for (let i = 0; i < 15; i++) {
      const old = i < 12;
      const m = seedMessage(db, sessionId, { timestamp: ago(old ? 200 - i : 5 - i * 0.1), inputTokens: 100 + i, outputTokens: 10 + i });
      ids.push(addBlock(m, 0, 'text', TRICKY[i % TRICKY.length]));
      ids.push(addBlock(m, 1, 'tool_use', null, TRICKY[(i + 3) % TRICKY.length]));
      ids.push(addBlock(m, 2, 'thinking', i % 2 ? null : `reasoning ${i}`));
    }
    return ids;
  }

  it('moves only text older than the window, keeps every aggregate, and reads back byte for byte', () => {
    seedHistory();
    const before = snapshotAll();
    const aggBefore = aggregates();

    let r;
    let batches = 0;
    do { r = freezeBatch(db, { days: 90, now: NOW, maxMessages: 5, minBytes: 1 }); batches++; } while (!r.caughtUp && batches < 20);
    expect(batches).toBeGreaterThan(1);

    const cold = db.prepare('SELECT COUNT(*) AS n FROM content_blocks WHERE cold = 1').get() as { n: number };
    // 12 old messages: 12 text, 12 tool_use, 6 thinking (the NULL ones carry
    // nothing), less the five whose only field is '' (nothing to pack).
    expect(cold.n).toBe(COLD_EXPECTED);
    expect((db.prepare('SELECT COUNT(*) AS n FROM content_blocks WHERE cold = 1 AND (text_content IS NOT NULL OR tool_input IS NOT NULL)').get() as { n: number }).n).toBe(0);
    // Recent text untouched
    expect((db.prepare(`SELECT COUNT(*) AS n FROM content_blocks cb JOIN messages m ON m.id = cb.message_id WHERE m.timestamp >= ? AND cb.cold = 1`).get(ago(90)) as { n: number }).n).toBe(0);

    expect(snapshotAll()).toEqual(before);
    expect(aggregates()).toEqual(aggBefore);

    const stats = coldStats(db);
    expect(stats.blocks).toBe(COLD_EXPECTED);
    expect(stats).toEqual(recountColdStats(db));

    // Thaw everything: hot rows are what they were, cold table is empty.
    let t;
    do { t = thawBatch(db, { limit: 7 }); } while (!t.done);
    // Plain columns now, no cold path: the hot rows hold the original bytes again.
    expect(db.prepare(`
      SELECT id, message_id, position, block_type, tool_name, tool_use_id, is_error, text_content, tool_input
        FROM content_blocks ORDER BY id
    `).all()).toEqual(before);
    expect((db.prepare('SELECT COUNT(*) AS n FROM content_blocks WHERE cold = 1').get() as { n: number }).n).toBe(0);
    expect(coldStats(db)).toEqual({ blocks: 0, rawBytes: 0, storedBytes: 0 });
  });

  it('thaws only inside a longer window when asked', () => {
    seedHistory();
    while (!freezeBatch(db, { days: 30, now: NOW, minBytes: 1 }).caughtUp) { /* drain */ }
    const m = seedMessage(db, sessionId, { timestamp: ago(60) });
    addBlock(m, 0, 'text', 'sixty days old');
    while (!freezeBatch(db, { days: 30, now: NOW, minBytes: 1 }).caughtUp) { /* drain */ }
    expect((db.prepare('SELECT cold FROM content_blocks WHERE message_id = ?').get(m) as { cold: number }).cold).toBe(1);

    thawBatch(db, { keepDays: 90, now: NOW });
    expect((db.prepare('SELECT cold, text_content FROM content_blocks WHERE message_id = ?').get(m))).toEqual({ cold: 0, text_content: 'sixty days old' });
    expect((db.prepare(`SELECT COUNT(*) AS n FROM content_blocks WHERE cold = 1`).get() as { n: number }).n).toBe(COLD_EXPECTED);
  });

  it('catches old messages ingested after the sweep went past them', () => {
    seedHistory();
    while (!freezeBatch(db, { days: 90, now: NOW, minBytes: 1 }).caughtUp) { /* drain */ }
    // A backfill: a new row (higher id) stamped long ago, behind the cursor.
    const late = seedMessage(db, sessionId, { timestamp: ago(300) });
    addBlock(late, 0, 'text', 'backfilled');
    const r = freezeBatch(db, { days: 90, now: NOW, minBytes: 1 });
    expect(r.blocks).toBe(1);
    expect((db.prepare(`SELECT ${blockTextSql('cb')} AS t, cold FROM content_blocks cb WHERE message_id = ?`).get(late))).toEqual({ t: 'backfilled', cold: 1 });
  });

  it('restarts the sweep when the window changes', () => {
    seedHistory();
    while (!freezeBatch(db, { days: 365, now: NOW, minBytes: 1 }).caughtUp) { /* drain */ }
    expect((db.prepare('SELECT COUNT(*) AS n FROM content_blocks WHERE cold = 1').get() as { n: number }).n).toBe(0);
    while (!freezeBatch(db, { days: 90, now: NOW, minBytes: 1 }).caughtUp) { /* drain */ }
    expect((db.prepare('SELECT COUNT(*) AS n FROM content_blocks WHERE cold = 1').get() as { n: number }).n).toBe(COLD_EXPECTED);
  });
});

describe('estimate', () => {
  it('counts what a window would move and moves nothing', () => {
    for (let i = 0; i < 10; i++) {
      const m = seedMessage(db, sessionId, { timestamp: ago(100 + i) });
      addBlock(m, 0, 'text', 'the same sentence, said again and again. '.repeat(50));
    }
    const recent = seedMessage(db, sessionId, { timestamp: ago(1) });
    addBlock(recent, 0, 'text', 'recent');
    const e = estimateColdMove(db, 90, { now: NOW });
    expect(e.blocks).toBe(10);
    expect(e.rawBytes).toBe(10 * 'the same sentence, said again and again. '.length * 50);
    expect(e.sampled).toBeGreaterThan(0);
    expect(e.ratio).toBeLessThan(0.2);
    expect(e.estimatedSavedBytes).toBeGreaterThan(e.rawBytes / 2);
    expect((db.prepare('SELECT COUNT(*) AS n FROM content_blocks WHERE cold = 1').get() as { n: number }).n).toBe(0);
  });

  it('is zero on an empty window', () => {
    expect(estimateColdMove(db, 90, { now: NOW })).toMatchObject({ blocks: 0, rawBytes: 0, estimatedSavedBytes: 0, ratio: 1 });
  });
});
