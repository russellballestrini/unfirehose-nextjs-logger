import { describe, it, expect, beforeEach, vi } from 'vitest';
import { createTestDb, seedProject, seedSession, seedMessage, seedContentBlock } from './test/db-helper';

/**
 * Messages per week, and the sessions active in each, as the payload
 * reports them.
 *
 * The old fold credited every message of a session to the week the session
 * last ran in, so one still-open session showed the current week as
 * "1 session, 11,884 msgs". A message belongs to the week it happened; a
 * session counts in every week it was active. And the week is SQLite's
 * %Y-W%W, which starts on Monday — a JS mirror that started on Sunday put
 * every Sunday in the wrong week.
 */

const db = createTestDb();
vi.mock('./db/schema', () => ({ getDb: () => db }));
const { buildScrobblePayload, weekKey } = await import('./scrobble');
const { sliceScrobble } = await import('./scrobble-range');

let pid: number;
beforeEach(() => {
  db.prepare('DELETE FROM content_blocks').run(); db.prepare('DELETE FROM messages').run(); db.prepare('DELETE FROM sessions').run(); db.prepare('DELETE FROM projects').run();
  pid = seedProject(db, 'p', 'p');
});
const velocity = () => buildScrobblePayload(db).timeSeries.weeklyVelocity as Array<{ week: string; messages: number; sessions: number; partial?: boolean }>;

// Two Mondays in different %W weeks of 2026: W24 starts Mon Jun 15, W25 Mon Jun 22.
const W24 = '2026-06-15T10:00:00Z', W25 = '2026-06-22T10:00:00Z';

describe('weeklyVelocity in the payload', () => {
  it('counts a message in the week it happened, not the week its session ended', () => {
    const sid = seedSession(db, pid, 's1');
    seedMessage(db, sid, { timestamp: W24 }); seedMessage(db, sid, { timestamp: W24 });
    seedMessage(db, sid, { timestamp: W25 });
    expect(velocity().map((r) => [r.week, r.messages])).toEqual([['2026-W24', 2], ['2026-W25', 1]]);
  });

  it('counts a session in every week it was active', () => {
    const sid = seedSession(db, pid, 's1');
    seedMessage(db, sid, { timestamp: W24 }); seedMessage(db, sid, { timestamp: W25 });
    const other = seedSession(db, pid, 's2');
    seedMessage(db, other, { timestamp: W25 });
    expect(velocity().map((r) => [r.week, r.sessions])).toEqual([['2026-W24', 1], ['2026-W25', 2]]);
  });

  it('puts a Sunday in the week that ends with it, as SQLite does', () => {
    // Sun Jun 21 is the last day of W24; Mon Jun 22 opens W25.
    const sid = seedSession(db, pid, 's1');
    seedMessage(db, sid, { timestamp: '2026-06-21T23:00:00Z' });
    seedMessage(db, sid, { timestamp: W25 });
    expect(velocity().map((r) => r.week)).toEqual(['2026-W24', '2026-W25']);
  });

  it('marks the week we are in as partial, since its numbers are still growing', () => {
    const sid = seedSession(db, pid, 's1');
    seedMessage(db, sid, { timestamp: new Date().toISOString() });
    expect(velocity()[0].partial).toBe(true);
  });

  it('does not mark a finished week', () => {
    const sid = seedSession(db, pid, 's1');
    seedMessage(db, sid, { timestamp: W24 });
    expect(velocity()[0].partial).toBeUndefined();
  });
});

describe('weekKey', () => {
  it("is SQLite's strftime('%Y-W%W') for every day of eleven years", () => {
    const sql = db.prepare("SELECT strftime('%Y-W%W', ?) AS w");
    let disagreements: string[] = [];
    for (let t = Date.UTC(2020, 0, 1); t <= Date.UTC(2030, 11, 31); t += 86400000) {
      const day = new Date(t).toISOString().slice(0, 10);
      const { w } = sql.get(day) as { w: string };
      if (weekKey(day) !== w) disagreements.push(`${day}: js ${weekKey(day)} sqlite ${w}`);
    }
    expect(disagreements).toEqual([]);
  });
});

/**
 * The day grain the page re-folds for a range. Its whole point is that
 * folding every day gives back exactly what the worker computed, so the
 * lifetime view and the range view are the same arithmetic.
 */
describe('the day grain in the payload', () => {
  it('sums back to the lifetime figures, and carries the hour histogram', () => {
    const s1 = seedSession(db, pid, 's1');
    const m1 = seedMessage(db, s1, { timestamp: '2026-06-15T09:10:00Z', model: 'claude-opus-4-1', inputTokens: 100, outputTokens: 10, cacheReadTokens: 1000 });
    seedMessage(db, s1, { timestamp: '2026-06-15T22:00:00Z', model: 'claude-opus-4-1', inputTokens: 100, outputTokens: 10 });
    seedMessage(db, s1, { timestamp: '2026-06-16T09:00:00Z', model: 'claude-haiku-4-5', inputTokens: 50, outputTokens: 5 });
    const s2 = seedSession(db, pid, 's2');
    seedMessage(db, s2, { timestamp: '2026-06-16T10:00:00Z', model: 'claude-haiku-4-5', inputTokens: 50, outputTokens: 5 });
    seedContentBlock(db, m1, { blockType: 'tool_use', toolName: 'Bash' });

    const p = buildScrobblePayload(db);
    expect(p.daily.map((d: any) => [d.date, d.messages, d.sessions])).toEqual([['2026-06-15', 2, 1], ['2026-06-16', 2, 1]]);
    expect(p.daily[0].hours[9]).toBe(1);
    expect(p.daily[0].hours[22]).toBe(1);
    expect(p.daily[0].cacheRead).toBe(1000);
    expect(p.modelDaily).toContainEqual({ date: '2026-06-16', model: 'claude-haiku-4-5', messages: 2, inputTokens: 100, outputTokens: 10 });
    expect(p.harnessDaily).toEqual([
      { date: '2026-06-15', harness: 'claude-code', sessions: 1, messages: 2 },
      { date: '2026-06-16', harness: 'claude-code', sessions: 1, messages: 2 },
    ]);
    expect(p.toolDaily).toEqual([{ date: '2026-06-15', name: 'Bash', count: 1 }]);

    const all = sliceScrobble(p, undefined);
    expect(all.lifetime).toMatchObject({
      totalSessions: p.lifetime.totalSessions, totalMessages: p.lifetime.totalMessages, activeDays: p.lifetime.activeDays,
      totalInputTokens: p.lifetime.totalInputTokens, totalOutputTokens: p.lifetime.totalOutputTokens,
      totalCacheRead: p.lifetime.totalCacheRead, totalCacheWrite: p.lifetime.totalCacheWrite, totalCostUSD: p.lifetime.totalCostUSD,
    });
    expect(all.activity.heatmap).toEqual(expect.arrayContaining(p.activity.heatmap));
    expect(all.activity.heatmap).toHaveLength(p.activity.heatmap.length);
    expect(all.models.map((m) => [m.model, m.messages]).sort()).toEqual(p.models.map((m: any) => [m.model, m.messages]).sort());
    expect(all.tools).toEqual(p.tools);

    const day2 = sliceScrobble(p, '2026-06-16');
    expect(day2.lifetime).toMatchObject({ totalSessions: 1, totalMessages: 2, activeDays: 1, totalInputTokens: 100 });
    expect(day2.models).toEqual([{ model: 'claude-haiku-4-5', messages: 2, inputTokens: 100, outputTokens: 10 }]);
    expect(day2.tools).toEqual([]);
  });
});
