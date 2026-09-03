import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type Database from 'better-sqlite3';
import { createTestDb } from './test/db-helper';
import { recordStatusPoll, getStatusCurrent, getStatusHistory, rollupStatusPolls, DEFAULT_STATUS_TARGETS } from './status-pages';

let db: Database.Database;
beforeEach(() => { db = createTestDb(); });
afterEach(() => { db.close(); });

const poll = (targetId: string, timestamp: string, indicator: any, description = 'x') => ({
  targetId, timestamp, indicator, description, incidents: [], httpStatus: 200, latencyMs: 50,
});

describe('status poll storage', () => {
  it('reports the latest poll per target, worst first, with the start of the current state', () => {
    recordStatusPoll(db, poll('anthropic', '2026-09-03T13:00:00.000Z', 'none'));
    recordStatusPoll(db, poll('anthropic', '2026-09-03T13:26:00.000Z', 'minor', 'Investigating: Elevated errors'));
    recordStatusPoll(db, poll('anthropic', '2026-09-03T13:27:00.000Z', 'minor', 'Identified: Elevated errors'));
    recordStatusPoll(db, poll('openai', '2026-09-03T13:27:00.000Z', 'none'));
    const cur = getStatusCurrent(db);
    expect(cur.map((c) => c.id).slice(0, 1)).toEqual(['anthropic']);
    const a = cur.find((c) => c.id === 'anthropic')!;
    expect(a.poll?.description).toBe('Identified: Elevated errors');
    expect(a.since).toBe('2026-09-03T13:26:00.000Z');
    expect(cur.find((c) => c.id === 'x-ai')!.poll).toBeNull();
    expect(cur).toHaveLength(DEFAULT_STATUS_TARGETS.length);
  });

  it('history is scoped to one target and ordered oldest first', () => {
    recordStatusPoll(db, poll('anthropic', new Date(Date.now() - 3_600_000).toISOString(), 'minor'));
    recordStatusPoll(db, poll('anthropic', new Date().toISOString(), 'none'));
    recordStatusPoll(db, poll('openai', new Date().toISOString(), 'none'));
    const h = getStatusHistory(db, 'anthropic', 24) as any[];
    expect(h.map((r) => r.indicator)).toEqual(['minor', 'none']);
  });

  it('rollup folds old raw polls into the hour\'s worst light and deletes them', () => {
    const old = '2026-01-01T10:';
    recordStatusPoll(db, poll('anthropic', `${old}05:00.000Z`, 'none'));
    recordStatusPoll(db, poll('anthropic', `${old}06:00.000Z`, 'major'));
    recordStatusPoll(db, poll('anthropic', `${old}07:00.000Z`, 'unreachable'));
    recordStatusPoll(db, poll('anthropic', new Date().toISOString(), 'none'));
    expect(rollupStatusPolls(db, 28)).toBe(3);
    expect(db.prepare('SELECT COUNT(*) AS c FROM status_polls').get()).toEqual({ c: 1 });
    expect(db.prepare('SELECT * FROM status_polls_hourly').all()).toEqual([
      { hour: '2026-01-01T10', target_id: 'anthropic', worst_indicator: 'major', polls: 3, unreachable: 1 },
    ]);
  });
});

