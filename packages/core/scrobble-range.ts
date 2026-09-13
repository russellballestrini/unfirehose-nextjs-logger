/**
 * A scrobble payload, re-folded for a range.
 *
 * The payload is built once by the worker over every day there is. The
 * page carries a range selector, and until now that selector only trimmed
 * the two daily series — the heatmap, the hour-of-day bars, the stat
 * strip, the model and tool lists all stayed lifetime, which made "last
 * 7 days" a label on a page that had not changed.
 *
 * So the payload now carries the day grain everything was folded from
 * (`daily`, `modelDaily`, `harnessDaily`, `toolDaily`), and this module
 * folds it again from a chosen day. It is pure and runs in the browser;
 * nothing here touches the database. An older payload without the grain
 * comes back as it was — lifetime — rather than as zeros.
 *
 * Sessions belong to the day they began, so a range's session count means
 * "sessions started in the range" and the days sum to the lifetime total.
 */

export interface DailyGrain {
  date: string;
  messages: number;
  /** Sessions that began on this day. */
  sessions: number;
  inputTokens: number;
  outputTokens: number;
  cacheRead: number;
  cacheWrite: number;
  costUSD: number;
  costSplit: { input: number; output: number; cacheRead: number; cacheWrite: number };
  /** Messages per UTC hour, 24 entries. */
  hours: number[];
}

export interface ModelDaily { date: string; model: string; messages: number; inputTokens: number; outputTokens: number }
export interface HarnessDaily { date: string; harness: string; sessions: number; messages: number }
export interface ToolDaily { date: string; name: string; count: number }

export interface ScrobbleView {
  lifetime: {
    totalSessions: number; totalMessages: number; activeDays: number;
    totalInputTokens: number; totalOutputTokens: number; totalCacheRead: number; totalCacheWrite: number;
    totalCostUSD: number;
    costSplit?: { input: number; output: number; cacheRead: number; cacheWrite: number };
    firstActivity?: string | null; lastActivity?: string | null;
  };
  streaks: { current: number; longest: number };
  activity: {
    hourOfDay: { hour: number; count: number }[];
    dayOfWeek: { day: string; count: number }[];
    heatmap: { dow: number; hour: number; count: number }[];
  };
  timeSeries: {
    dailyMessages: { date: string; count: number }[];
    dailyCost: { date: string; costUSD: number }[];
    weeklyVelocity: any[];
  };
  models: { model: string; messages: number; inputTokens: number; outputTokens: number }[];
  harnesses: { harness: string; sessions: number; messages: number }[];
  tools: { name: string; count: number }[];
  /** False when the payload predates the grain and the view is lifetime regardless of range. */
  sliced: boolean;
}

const DOW = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

/** UTC weekday of a YYYY-MM-DD. */
export function dowOf(date: string): number {
  return new Date(`${date}T00:00:00Z`).getUTCDay();
}

/**
 * SQLite's strftime('%Y-W%W') for an ISO date, so the weekly series is keyed
 * the way every other week in this database is.
 *
 * %W starts a week on Monday, and the days before a year's first Monday are
 * week 00. The mirror this replaced started weeks on Sunday, so every Sunday
 * landed in the week after SQLite's — the "disagrees on some days" that once
 * forced the week to be keyed by SQLite itself. Checked against SQLite for
 * every day of eleven years in scrobble-velocity.test.ts.
 */
export function weekKey(date: string): string {
  const d = new Date(`${date.slice(0, 10)}T00:00:00Z`);
  const year = d.getUTCFullYear();
  const yday = Math.round((d.getTime() - Date.UTC(year, 0, 1)) / 86400000);
  const monday0 = (d.getUTCDay() + 6) % 7;
  const week = Math.floor((yday + 7 - monday0) / 7);
  return `${year}-W${String(week).padStart(2, '0')}`;
}

/**
 * Streaks over a sorted-ascending list of active days. Current counts back
 * from `today` (or yesterday, since today may not be over); longest is the
 * best run anywhere in the list.
 */
export function streaksOf(daysAsc: string[], today: string): { current: number; longest: number } {
  if (daysAsc.length === 0) return { current: 0, longest: 0 };
  const dayMs = 86_400_000;
  const ms = (d: string) => Date.parse(`${d}T00:00:00Z`);
  let longest = 1, run = 1;
  for (let i = 1; i < daysAsc.length; i++) {
    run = ms(daysAsc[i]) - ms(daysAsc[i - 1]) === dayMs ? run + 1 : 1;
    if (run > longest) longest = run;
  }
  const last = daysAsc[daysAsc.length - 1];
  const gap = (ms(today) - ms(last)) / dayMs;
  if (gap > 1) return { current: 0, longest };
  let current = 1;
  for (let i = daysAsc.length - 1; i > 0; i--) {
    if (ms(daysAsc[i]) - ms(daysAsc[i - 1]) !== dayMs) break;
    current++;
  }
  return { current, longest };
}

/**
 * Fold the payload for days `>= fromDay` (undefined = lifetime).
 * `today` pins the streak clock and the week the velocity series is cut at.
 */
export function sliceScrobble(payload: any, fromDay: string | undefined, today = new Date().toISOString()): ScrobbleView {
  const lt = payload?.lifetime ?? {};
  const base: ScrobbleView = {
    lifetime: {
      totalSessions: lt.totalSessions ?? 0, totalMessages: lt.totalMessages ?? 0, activeDays: lt.activeDays ?? 0,
      totalInputTokens: lt.totalInputTokens ?? 0, totalOutputTokens: lt.totalOutputTokens ?? 0,
      totalCacheRead: lt.totalCacheRead ?? 0, totalCacheWrite: lt.totalCacheWrite ?? 0,
      totalCostUSD: lt.totalCostUSD ?? 0, costSplit: lt.costSplit,
      firstActivity: lt.firstActivity ?? null, lastActivity: lt.lastActivity ?? null,
    },
    streaks: payload?.streaks ?? { current: 0, longest: 0 },
    activity: payload?.activity ?? { hourOfDay: [], dayOfWeek: [], heatmap: [] },
    timeSeries: payload?.timeSeries ?? { dailyMessages: [], dailyCost: [], weeklyVelocity: [] },
    models: payload?.models ?? [],
    harnesses: payload?.harnesses ?? [],
    tools: payload?.tools ?? [],
    sliced: false,
  };
  const daily: DailyGrain[] | undefined = Array.isArray(payload?.daily) ? payload.daily : undefined;
  if (!daily) {
    // No grain: the two series were always trimmable, so trim them at least.
    if (fromDay) {
      const fromWeek = weekKey(fromDay);
      base.timeSeries = {
        dailyMessages: base.timeSeries.dailyMessages.filter((d) => d.date >= fromDay),
        dailyCost: base.timeSeries.dailyCost.filter((d) => d.date >= fromDay),
        weeklyVelocity: base.timeSeries.weeklyVelocity.filter((w: any) => w.week >= fromWeek),
      };
    }
    return base;
  }

  const inRange = (date: string) => !fromDay || date >= fromDay;
  const days = daily.filter((d) => inRange(d.date));
  const todayDay = today.slice(0, 10);

  const sum = { sessions: 0, messages: 0, inp: 0, out: 0, cr: 0, cw: 0, cost: 0, split: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } };
  const hours = new Array<number>(24).fill(0);
  const heat = new Map<string, { dow: number; hour: number; count: number }>();
  const dow = new Array<number>(7).fill(0);
  for (const d of days) {
    sum.sessions += d.sessions; sum.messages += d.messages;
    sum.inp += d.inputTokens; sum.out += d.outputTokens; sum.cr += d.cacheRead; sum.cw += d.cacheWrite;
    sum.cost += d.costUSD;
    sum.split.input += d.costSplit?.input ?? 0; sum.split.output += d.costSplit?.output ?? 0;
    sum.split.cacheRead += d.costSplit?.cacheRead ?? 0; sum.split.cacheWrite += d.costSplit?.cacheWrite ?? 0;
    const w = dowOf(d.date);
    for (let h = 0; h < 24; h++) {
      const n = d.hours?.[h] ?? 0;
      if (!n) continue;
      hours[h] += n;
      dow[w] += n;
      const k = `${w}:${h}`;
      const cell = heat.get(k) ?? { dow: w, hour: h, count: 0 };
      cell.count += n;
      heat.set(k, cell);
    }
  }
  const activeDays = days.filter((d) => d.messages > 0).map((d) => d.date);

  const fold = <T extends { date: string }, K extends string>(rows: T[] | undefined, key: (r: T) => K, add: (acc: any, r: T) => void, seed: (r: T) => any) => {
    const m = new Map<K, any>();
    for (const r of rows ?? []) {
      if (!inRange(r.date)) continue;
      const k = key(r);
      const acc = m.get(k) ?? seed(r);
      add(acc, r);
      m.set(k, acc);
    }
    return [...m.values()];
  };
  const models = fold<ModelDaily, string>(payload.modelDaily, (r) => r.model,
    (a, r) => { a.messages += r.messages; a.inputTokens += r.inputTokens; a.outputTokens += r.outputTokens; },
    (r) => ({ model: r.model, messages: 0, inputTokens: 0, outputTokens: 0 }))
    .sort((a, b) => b.messages - a.messages || a.model.localeCompare(b.model));
  const harnesses = fold<HarnessDaily, string>(payload.harnessDaily, (r) => r.harness,
    (a, r) => { a.sessions += r.sessions; a.messages += r.messages; },
    (r) => ({ harness: r.harness, sessions: 0, messages: 0 }))
    .sort((a, b) => b.sessions - a.sessions || a.harness.localeCompare(b.harness));
  const tools = fold<ToolDaily, string>(payload.toolDaily, (r) => r.name,
    (a, r) => { a.count += r.count; },
    (r) => ({ name: r.name, count: 0 }))
    .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));

  const fromWeek = fromDay ? weekKey(fromDay) : undefined;
  return {
    lifetime: {
      totalSessions: sum.sessions, totalMessages: sum.messages, activeDays: activeDays.length,
      totalInputTokens: sum.inp, totalOutputTokens: sum.out, totalCacheRead: sum.cr, totalCacheWrite: sum.cw,
      totalCostUSD: Math.round(sum.cost * 100) / 100, costSplit: sum.split,
      firstActivity: fromDay ? (days[0]?.date ?? null) : base.lifetime.firstActivity,
      lastActivity: base.lifetime.lastActivity,
    },
    streaks: streaksOf(activeDays, todayDay),
    activity: {
      hourOfDay: hours.map((count, hour) => ({ hour, count })).filter((h) => h.count > 0),
      dayOfWeek: dow.map((count, i) => ({ day: DOW[i], count })).filter((d) => d.count > 0),
      heatmap: [...heat.values()],
    },
    timeSeries: {
      dailyMessages: days.map((d) => ({ date: d.date, count: d.messages })),
      dailyCost: days.map((d) => ({ date: d.date, costUSD: d.costUSD })),
      weeklyVelocity: fromWeek ? base.timeSeries.weeklyVelocity.filter((w: any) => w.week >= fromWeek) : base.timeSeries.weeklyVelocity,
    },
    models, harnesses, tools,
    sliced: true,
  };
}
