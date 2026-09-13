import { describe, it, expect } from 'vitest';
import { sliceScrobble, streaksOf, weekKey, dowOf, type DailyGrain } from './scrobble-range';

/**
 * Re-folding the scrobble payload for a range.
 *
 * The range selector used to trim two series and leave every other number
 * and chart at lifetime. Now the payload carries the day grain and the page
 * folds it. These pin the fold: the sums, the heatmap cells, the streaks,
 * the per-model / per-tool lists, and — the case that matters most — that
 * lifetime (no `from`) reproduces what the worker computed.
 */

const day = (date: string, over: Partial<DailyGrain> & { at?: Record<number, number> } = {}): DailyGrain => {
  const hours = new Array(24).fill(0);
  for (const [h, n] of Object.entries(over.at ?? {})) hours[Number(h)] = n;
  const messages = over.messages ?? hours.reduce((a, b) => a + b, 0);
  return {
    date, messages, sessions: over.sessions ?? 1,
    inputTokens: over.inputTokens ?? 100, outputTokens: over.outputTokens ?? 10,
    cacheRead: over.cacheRead ?? 1000, cacheWrite: over.cacheWrite ?? 50,
    costUSD: over.costUSD ?? 1,
    costSplit: over.costSplit ?? { input: 0.25, output: 0.25, cacheRead: 0.25, cacheWrite: 0.25 },
    hours,
  };
};

// Mon Sep 7 .. Sun Sep 13 2026, with a hole on Thursday.
const PAYLOAD = {
  lifetime: { totalSessions: 6, totalMessages: 60, activeDays: 6, totalInputTokens: 600, totalOutputTokens: 60, totalCacheRead: 6000, totalCacheWrite: 300, totalCostUSD: 6, costSplit: { input: 1.5, output: 1.5, cacheRead: 1.5, cacheWrite: 1.5 }, firstActivity: '2026-09-07T09:00:00Z', lastActivity: '2026-09-13T22:00:00Z' },
  streaks: { current: 3, longest: 3 },
  activity: { hourOfDay: [{ hour: 9, count: 60 }], dayOfWeek: [], heatmap: [] },
  timeSeries: {
    dailyMessages: [], dailyCost: [],
    weeklyVelocity: [{ week: '2026-W35', sessions: 1, messages: 5 }, { week: '2026-W36', sessions: 6, messages: 60, partial: true }],
  },
  models: [{ model: 'lifetime-model', messages: 60, inputTokens: 600, outputTokens: 60 }],
  harnesses: [{ harness: 'claude-code', sessions: 6, messages: 60 }],
  tools: [{ name: 'Bash', count: 99 }],
  daily: [
    day('2026-09-07', { at: { 9: 10 } }),
    day('2026-09-08', { at: { 9: 5, 22: 5 } }),
    day('2026-09-09', { at: { 9: 10 } }),
    // Thursday: nothing.
    day('2026-09-11', { at: { 9: 10 }, sessions: 2 }),
    day('2026-09-12', { at: { 9: 10 } }),
    day('2026-09-13', { at: { 9: 10 }, sessions: 0 }),
  ],
  modelDaily: [
    { date: '2026-09-07', model: 'opus', messages: 10, inputTokens: 100, outputTokens: 10 },
    { date: '2026-09-12', model: 'opus', messages: 5, inputTokens: 50, outputTokens: 5 },
    { date: '2026-09-12', model: 'haiku', messages: 5, inputTokens: 50, outputTokens: 5 },
    { date: '2026-09-13', model: 'haiku', messages: 10, inputTokens: 100, outputTokens: 10 },
  ],
  harnessDaily: [
    { date: '2026-09-07', harness: 'claude-code', sessions: 1, messages: 10 },
    { date: '2026-09-12', harness: 'uncloseai', sessions: 1, messages: 10 },
  ],
  toolDaily: [
    { date: '2026-09-07', name: 'Bash', count: 8 },
    { date: '2026-09-12', name: 'Read', count: 3 },
    { date: '2026-09-13', name: 'Bash', count: 1 },
  ],
};
const TODAY = '2026-09-13T23:00:00Z';

describe('sliceScrobble', () => {
  it('lifetime reproduces the worker\'s fold from the grain', () => {
    const v = sliceScrobble(PAYLOAD, undefined, TODAY);
    expect(v.sliced).toBe(true);
    expect(v.lifetime).toMatchObject({ totalSessions: 6, totalMessages: 60, activeDays: 6, totalInputTokens: 600, totalOutputTokens: 60, totalCacheRead: 6000, totalCacheWrite: 300, totalCostUSD: 6 });
    expect(v.lifetime.costSplit).toEqual({ input: 1.5, output: 1.5, cacheRead: 1.5, cacheWrite: 1.5 });
    expect(v.lifetime.firstActivity).toBe('2026-09-07T09:00:00Z');
    expect(v.streaks).toEqual({ current: 3, longest: 3 });
    expect(v.activity.hourOfDay).toEqual([{ hour: 9, count: 55 }, { hour: 22, count: 5 }]);
    expect(v.timeSeries.weeklyVelocity).toHaveLength(2);
  });

  it('folds only the days from the cut', () => {
    const v = sliceScrobble(PAYLOAD, '2026-09-12', TODAY);
    expect(v.lifetime).toMatchObject({ totalSessions: 1, totalMessages: 20, activeDays: 2, totalInputTokens: 200, totalCostUSD: 2 });
    expect(v.lifetime.firstActivity).toBe('2026-09-12');
    expect(v.timeSeries.dailyMessages).toEqual([{ date: '2026-09-12', count: 10 }, { date: '2026-09-13', count: 10 }]);
    expect(v.timeSeries.dailyCost).toEqual([{ date: '2026-09-12', costUSD: 1 }, { date: '2026-09-13', costUSD: 1 }]);
    // W36 starts Mon Sep 7; the cut is inside it, so W35 goes and W36 stays.
    expect(v.timeSeries.weeklyVelocity.map((w: any) => w.week)).toEqual(['2026-W36']);
  });

  it('re-folds the heatmap and the weekday bars from the hour histograms', () => {
    const v = sliceScrobble(PAYLOAD, '2026-09-08', TODAY);
    // Tue Sep 8 had 5 at 09 and 5 at 22.
    expect(v.activity.heatmap).toContainEqual({ dow: 2, hour: 9, count: 5 });
    expect(v.activity.heatmap).toContainEqual({ dow: 2, hour: 22, count: 5 });
    // Monday is before the cut; nothing lands on it.
    expect(v.activity.heatmap.some((c) => c.dow === 1)).toBe(false);
    expect(v.activity.dayOfWeek).toEqual([
      { day: 'Sun', count: 10 }, { day: 'Tue', count: 10 }, { day: 'Wed', count: 10 }, { day: 'Fri', count: 10 }, { day: 'Sat', count: 10 },
    ]);
  });

  it('re-ranks models, harnesses and tools within the range', () => {
    const all = sliceScrobble(PAYLOAD, undefined, TODAY);
    expect(all.models.map((m) => [m.model, m.messages])).toEqual([['haiku', 15], ['opus', 15]]);
    const week = sliceScrobble(PAYLOAD, '2026-09-12', TODAY);
    expect(week.models.map((m) => [m.model, m.messages])).toEqual([['haiku', 15], ['opus', 5]]);
    expect(week.harnesses).toEqual([{ harness: 'uncloseai', sessions: 1, messages: 10 }]);
    expect(week.tools).toEqual([{ name: 'Read', count: 3 }, { name: 'Bash', count: 1 }]);
  });

  it('counts a streak within the range, against today', () => {
    // Cut after the Thursday hole: Fri, Sat, Sun = 3.
    expect(sliceScrobble(PAYLOAD, '2026-09-11', TODAY).streaks).toEqual({ current: 3, longest: 3 });
    // Cut inside: Sat, Sun = 2.
    expect(sliceScrobble(PAYLOAD, '2026-09-12', TODAY).streaks).toEqual({ current: 2, longest: 2 });
    // A day later with nothing new: current is gone, longest stays.
    expect(sliceScrobble(PAYLOAD, undefined, '2026-09-15T01:00:00Z').streaks).toEqual({ current: 0, longest: 3 });
  });

  it('is empty, not broken, for a range with nothing in it', () => {
    const v = sliceScrobble(PAYLOAD, '2027-01-01', TODAY);
    expect(v.lifetime).toMatchObject({ totalSessions: 0, totalMessages: 0, activeDays: 0, totalCostUSD: 0 });
    expect(v.lifetime.firstActivity).toBeNull();
    expect(v.streaks).toEqual({ current: 0, longest: 0 });
    expect(v.activity.heatmap).toEqual([]);
    expect(v.models).toEqual([]);
  });

  it('hands an older payload back as lifetime, with the two series trimmed as before', () => {
    const { daily: _d, modelDaily: _m, harnessDaily: _h, toolDaily: _t, ...old } = PAYLOAD;
    const oldWithSeries = { ...old, timeSeries: { ...old.timeSeries, dailyMessages: [{ date: '2026-09-01', count: 1 }, { date: '2026-09-12', count: 2 }], dailyCost: [] } };
    const v = sliceScrobble(oldWithSeries, '2026-09-12', TODAY);
    expect(v.sliced).toBe(false);
    expect(v.lifetime.totalMessages).toBe(60);
    expect(v.models[0].model).toBe('lifetime-model');
    expect(v.tools).toEqual([{ name: 'Bash', count: 99 }]);
    expect(v.timeSeries.dailyMessages).toEqual([{ date: '2026-09-12', count: 2 }]);
    expect(v.timeSeries.weeklyVelocity.map((w: any) => w.week)).toEqual(['2026-W36']);
    const all = sliceScrobble(oldWithSeries, undefined, TODAY);
    expect(all.timeSeries.dailyMessages).toHaveLength(2);
  });

  it('survives a payload with nothing in it', () => {
    const v = sliceScrobble({}, undefined, TODAY);
    expect(v.lifetime.totalMessages).toBe(0);
    expect(v.activity.heatmap).toEqual([]);
    expect(sliceScrobble(null, '2026-01-01', TODAY).sliced).toBe(false);
  });

  it('tolerates a day row missing its histogram or split', () => {
    const bare = { daily: [{ date: '2026-09-13', messages: 3, sessions: 1, inputTokens: 0, outputTokens: 0, cacheRead: 0, cacheWrite: 0, costUSD: 0 }] };
    const v = sliceScrobble(bare, undefined, TODAY);
    expect(v.lifetime.totalMessages).toBe(3);
    expect(v.activity.hourOfDay).toEqual([]);
    expect(v.lifetime.costSplit).toEqual({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
  });
});

describe('streaksOf', () => {
  it('counts back from today or yesterday, and the best run anywhere', () => {
    expect(streaksOf([], '2026-09-13')).toEqual({ current: 0, longest: 0 });
    expect(streaksOf(['2026-09-13'], '2026-09-13')).toEqual({ current: 1, longest: 1 });
    expect(streaksOf(['2026-09-12'], '2026-09-13')).toEqual({ current: 1, longest: 1 });
    expect(streaksOf(['2026-09-11'], '2026-09-13')).toEqual({ current: 0, longest: 1 });
    expect(streaksOf(['2026-09-01', '2026-09-02', '2026-09-03', '2026-09-12', '2026-09-13'], '2026-09-13')).toEqual({ current: 2, longest: 3 });
  });
});

describe('weekKey and dowOf', () => {
  it('speak SQLite %W and UTC weekdays', () => {
    expect(weekKey('2026-09-07')).toBe('2026-W36');
    expect(weekKey('2026-09-13T23:59:59Z')).toBe('2026-W36');
    expect(weekKey('2026-01-01')).toBe('2026-W00');
    expect(dowOf('2026-09-13')).toBe(0);
    expect(dowOf('2026-09-07')).toBe(1);
  });
});
