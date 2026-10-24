import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type Database from 'better-sqlite3';
import { createTestDb, seedProject, seedSession, seedMessage, seedContentBlock } from '../test/db-helper';
import { scanRateLimitsFully } from './rate-limit-scan';

/**
 * Draining the scan backlog in batches.
 *
 * The worker calls this after a big ingest: a batch at a time so no one
 * transaction holds the database for long, until a pass comes back empty.
 * The totals have to be the sum of the passes and the cursor has to end on
 * the last block, or the next incremental scan starts in the wrong place.
 */

let db: Database.Database;
let blockIds: number[];

beforeEach(() => {
  db = createTestDb();
  const sid = seedSession(db, seedProject(db, 'p'));
  blockIds = [];
  // Five tool results, three of which are refusals.
  const texts = [
    'API Error: 529 Overloaded. This is a server-side issue.',
    'all good',
    'API Error: 529 Overloaded. This is a server-side issue.',
    'nothing to see',
    'API Error: 529 Overloaded. This is a server-side issue.',
  ];
  texts.forEach((t, i) => {
    const mid = seedMessage(db, sid, { uuid: `m${i}`, timestamp: `2026-09-03T10:0${i}:00.000Z` });
    blockIds.push(seedContentBlock(db, mid, { textContent: t }));
  });
});
afterEach(() => db.close());

const events = () => (db.prepare('SELECT COUNT(*) AS c FROM rate_limit_events').get() as { c: number }).c;

describe('scanRateLimitsFully', () => {
  it('scans every block across as many batches as it takes and sums the passes', () => {
    const r = scanRateLimitsFully(db, { batch: 2 });
    expect(r).toEqual({ scanned: 5, found: 3, lastBlockId: blockIds[4] });
    expect(events()).toBe(3);
  });

  it('stops after maxPasses even with backlog left, and says how far it got', () => {
    const r = scanRateLimitsFully(db, { batch: 2, maxPasses: 1 });
    expect(r.scanned).toBe(2);
    expect(r.lastBlockId).toBe(blockIds[1]);
    // The next call carries on from the cursor rather than starting over.
    expect(scanRateLimitsFully(db, { batch: 2 })).toEqual({ scanned: 3, found: 2, lastBlockId: blockIds[4] });
    expect(events()).toBe(3);
  });

  it('finds nothing new on a second drain, and fromScratch rebuilds the same events once', () => {
    scanRateLimitsFully(db, { batch: 2 });
    expect(scanRateLimitsFully(db, { batch: 2 }).scanned).toBe(0);
    // fromScratch applies to the first pass only; were it applied to every
    // pass the loop would never see an empty batch and run to maxPasses.
    const again = scanRateLimitsFully(db, { batch: 2, fromScratch: true, maxPasses: 10 });
    expect(again).toEqual({ scanned: 5, found: 3, lastBlockId: blockIds[4] });
    expect(events()).toBe(3);
  });
});
