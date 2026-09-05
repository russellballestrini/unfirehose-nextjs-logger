import { describe, it, expect, beforeEach, vi } from 'vitest';
import { createTestDb } from '../test/db-helper';

/**
 * When we last read the harnesses.
 *
 * Every way ingestion can fail looks the same from a page: no new rows. A
 * harness nobody ran, a worker that died overnight, a watcher that never
 * saw a new directory — all of them render as a quiet dashboard. This is
 * the one fact that separates them, and it went missing for ten hours
 * without anything saying so.
 */

const db = createTestDb();
vi.mock('./schema', async (original) => ({
  ...(await original<Record<string, unknown>>()),
  getDb: () => db,
}));

const { ingestLagMinutes, INGEST_HEARTBEAT_KEY, setSetting } = await import('./ingest');

const stamp = (minutesAgo: number) =>
  setSetting(INGEST_HEARTBEAT_KEY, new Date(Date.now() - minutesAgo * 60_000).toISOString());

beforeEach(() => {
  db.prepare('DELETE FROM settings WHERE key = ?').run(INGEST_HEARTBEAT_KEY);
});

describe('ingestLagMinutes', () => {
  it('is null before anything has ever been ingested', () => {
    // A fresh install has never ingested, which is not the same as one
    // whose worker died an hour ago. A page that showed 0 for both would
    // say a new machine was perfectly up to date.
    expect(ingestLagMinutes()).toBeNull();
  });

  it('reads zero immediately after a run', () => {
    stamp(0);
    expect(ingestLagMinutes()).toBe(0);
  });

  it('counts the minutes since the last run', () => {
    stamp(615);
    expect(ingestLagMinutes()).toBe(615);
  });

  it('never reads negative, however the clock moved', () => {
    // A machine that resumed from suspend, or an NTP step, can put the
    // stamp in the future. Negative lag reads as data from ahead of now.
    stamp(-30);
    expect(ingestLagMinutes()).toBe(0);
  });

  it('is null for a stamp that will not parse', () => {
    // Settings are a text table anybody can edit.
    setSetting(INGEST_HEARTBEAT_KEY, 'whenever');
    expect(ingestLagMinutes()).toBeNull();
  });
});
