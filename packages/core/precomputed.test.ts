import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createTestDb } from './test/db-helper';

const db = createTestDb();
vi.mock('./db/schema', () => ({ getDb: () => db }));

const { storePayload, readPayload } = await import('./precomputed');

/**
 * The dashboard, the project list and the scrobble payload all reach a route
 * through this, so every way it can decline to answer is a way a page falls
 * back to computing seconds of work on the request thread.
 */
describe('precomputed payloads', () => {
  beforeEach(() => {
    db.prepare("DELETE FROM settings WHERE key LIKE 'test_%'").run();
  });

  it('reads back what it stored, with the time it was built', () => {
    const before = Date.now();
    storePayload('test_a', { rows: [1, 2, 3] });
    const stored = readPayload<{ rows: number[] }>('test_a', 60_000);

    expect(stored?.payload).toEqual({ rows: [1, 2, 3] });
    expect(Date.parse(stored!.at)).toBeGreaterThanOrEqual(before - 1000);
  });

  it('declines a payload older than the caller will accept', () => {
    storePayload('test_a', { n: 1 });
    // Zero tolerance: anything already written is already too old.
    expect(readPayload('test_a', -1)).toBeNull();
    expect(readPayload('test_a', 60_000)).not.toBeNull();
  });

  it('declines a key nothing has written', () => {
    expect(readPayload('test_never', 60_000)).toBeNull();
  });

  it('declines a payload whose timestamp went missing', () => {
    // Half a write — the payload landed, the stamp did not. Age is unknowable,
    // so the answer is no answer.
    storePayload('test_a', { n: 1 });
    db.prepare("DELETE FROM settings WHERE key = 'test_a_at'").run();
    expect(readPayload('test_a', 60_000)).toBeNull();
  });

  it('declines a payload that will not parse', () => {
    storePayload('test_a', { n: 1 });
    db.prepare("UPDATE settings SET value = '{ truncated' WHERE key = 'test_a'").run();
    expect(readPayload('test_a', 60_000)).toBeNull();
  });

  it('declines a payload stamped with something that is not a time', () => {
    storePayload('test_a', { n: 1 });
    db.prepare("UPDATE settings SET value = 'whenever' WHERE key = 'test_a_at'").run();
    expect(readPayload('test_a', 60_000)).toBeNull();
  });

  it('keeps payloads under different keys apart', () => {
    storePayload('test_a', { which: 'a' });
    storePayload('test_b', { which: 'b' });
    expect(readPayload<{ which: string }>('test_a', 60_000)?.payload.which).toBe('a');
    expect(readPayload<{ which: string }>('test_b', 60_000)?.payload.which).toBe('b');
  });

  it('replaces a payload rather than accumulating rows', () => {
    storePayload('test_a', { n: 1 });
    storePayload('test_a', { n: 2 });
    expect(readPayload<{ n: number }>('test_a', 60_000)?.payload.n).toBe(2);
    const count = db.prepare("SELECT COUNT(*) AS c FROM settings WHERE key = 'test_a'").get() as { c: number };
    expect(count.c).toBe(1);
  });
});
