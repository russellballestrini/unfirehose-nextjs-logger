import { describe, it, expect } from 'vitest';
import { human, humanDelta, delta2dict, extractComponents, formatComponents, getDeltaFromSubject, TIME_UNITS } from './ago';

/**
 * The python `ago` test-suite, carried over. Fixtures are the same ones:
 * PAST is a year, 127 days, 16 hours and change before NOW; FUTURE is two
 * days, 3 hours and 27 minutes after.
 */
const NOW = Date.UTC(2026, 8, 13, 20, 0, 0);
const DAY = 86_400_000;
const PAST = NOW - (365 * DAY + 127 * DAY + 16 * 3_600_000 + 18 * 60_000 + 39_000 + 45);
const FUTURE = NOW + (2 * DAY + 12_447_000 + 967);

describe('human', () => {
  it('tenses past and future', () => {
    expect(human(PAST, { now: NOW })).toBe('1 year, 127 days ago');
    expect(human(FUTURE, { now: NOW })).toBe('in 2 days, 3 hours');
  });

  it('precision counts non-zero units, largest first', () => {
    expect(human(PAST, { now: NOW, precision: 1 })).toBe('1 year ago');
    expect(human(PAST, { now: NOW, precision: 3 })).toBe('1 year, 127 days, 16 hours ago');
    expect(human(PAST, { now: NOW, precision: 10 })).toBe('1 year, 127 days, 16 hours, 18 minutes, 39 seconds, 45 milliseconds ago');
  });

  it('skips a zero unit rather than spending a slot on it', () => {
    const then = NOW - (365 * DAY + 3 * 3_600_000);
    expect(human(then, { now: NOW })).toBe('1 year, 3 hours ago');
  });

  it('singular for one, plural otherwise', () => {
    expect(human(NOW - DAY, { now: NOW })).toBe('1 day ago');
    expect(human(NOW - 2 * DAY, { now: NOW })).toBe('2 days ago');
  });

  it('abbreviates the way ago does', () => {
    expect(human(NOW - 2 * DAY, { now: NOW, abbreviate: true })).toBe('2d ago');
    expect(human(NOW - 3.5 * DAY, { now: NOW, abbreviate: true })).toBe('3d, 12h ago');
    expect(human(NOW - 0.1 * DAY, { now: NOW, abbreviate: true })).toBe('2h, 24m ago');
    expect(human(NOW - 400 * DAY, { now: NOW, abbreviate: true })).toBe('1y, 35d ago');
  });

  it('takes custom tenses', () => {
    expect(human(PAST, { now: NOW, pastTense: 'titanic sunk {}' })).toBe('titanic sunk 1 year, 127 days');
    expect(human(FUTURE, { now: NOW, futureTense: 'titanic will sink in {}' })).toBe('titanic will sink in 2 days, 3 hours');
  });

  it('accepts a Date or an ISO string', () => {
    expect(human(new Date(PAST), { now: NOW })).toBe('1 year, 127 days ago');
    expect(human(new Date(PAST).toISOString(), { now: NOW })).toBe('1 year, 127 days ago');
  });

  it('says just now for a delta with no whole unit', () => {
    expect(human(NOW, { now: NOW })).toBe('just now');
    expect(human(NOW, { now: NOW, zero: 'now' })).toBe('now');
  });

  it('throws on something that is not a time', () => {
    expect(() => human('not-a-date', { now: NOW })).toThrow(TypeError);
    expect(() => human('', { now: NOW })).toThrow(/Cannot convert ""/);
  });

  it('floors at a unit so a page never reads milliseconds', () => {
    expect(human(NOW - 60_004, { now: NOW, smallest: 'second' })).toBe('1 minute ago');
    expect(human(NOW - 4, { now: NOW, smallest: 'second' })).toBe('just now');
  });

  it('lets a caller override the tense and the zero word together', () => {
    expect(human(NOW - 5 * 3_600_000, { now: NOW, pastTense: 'up {}', zero: 'up just now' })).toBe('up 5 hours');
    expect(human(NOW, { now: NOW, pastTense: 'up {}', zero: 'up just now' })).toBe('up just now');
  });

  it('crosses a year boundary the way python does: 365 days, no leap', () => {
    expect(human(NOW - 365 * DAY, { now: NOW })).toBe('1 year ago');
    expect(human(NOW - 364 * DAY, { now: NOW })).toBe('364 days ago');
    expect(human(NOW - 730 * DAY, { now: NOW })).toBe('2 years ago');
  });

  it('measures against the wall clock when no now is given', () => {
    expect(human(new Date(Date.now() - 60_000))).toBe('1 minute ago');
  });
});

describe('humanDelta', () => {
  it('is bare by default: a span has no tense', () => {
    expect(humanDelta(90_000)).toBe('1 minute, 30 seconds');
    expect(humanDelta(90_000, { abbreviate: true })).toBe('1m, 30s');
  });

  it('can be tensed, with a negative span reading as future', () => {
    expect(humanDelta(3_600_000, { pastTense: '{} ago' })).toBe('1 hour ago');
    expect(humanDelta(-3_600_000, { futureTense: 'in {}' })).toBe('in 1 hour');
  });

  it('floors at a chosen smallest unit', () => {
    expect(humanDelta(5_500, { abbreviate: true })).toBe('5s, 500ms');
    expect(humanDelta(5_500, { abbreviate: true, smallest: 'second' })).toBe('5s');
    expect(humanDelta(500, { abbreviate: true, smallest: 'second' })).toBe('0s');
    expect(humanDelta(0)).toBe('0 milliseconds');
  });

  it('joins with whatever separator the page wants', () => {
    expect(humanDelta(7_260_000, { abbreviate: true, separator: ' ' })).toBe('2h 1m');
  });

  it('names the zero in the unit it was floored at', () => {
    expect(humanDelta(0, { smallest: 'minute' })).toBe('0 minutes');
    expect(humanDelta(59_999, { smallest: 'minute', abbreviate: true })).toBe('0m');
    expect(humanDelta(0, { zero: 'none' })).toBe('none');
  });

  it('ignores a tense for a zero span', () => {
    expect(humanDelta(0, { pastTense: '{} ago', zero: 'just now' })).toBe('just now');
  });

  it('carries the sign into the tense but never into the digits', () => {
    expect(humanDelta(-90_000, { pastTense: '{} ago', futureTense: 'in {}' })).toBe('in 1 minute, 30 seconds');
  });

  it('takes precision past the unit count without complaint', () => {
    expect(humanDelta(1500, { precision: 99 })).toBe('1 second, 500 milliseconds');
    expect(humanDelta(1500, { precision: 0 })).toBe('');
  });
});

describe('TIME_UNITS', () => {
  it('runs year to millisecond, each a multiple of the next', () => {
    expect(TIME_UNITS.map((u) => u.name)).toEqual(['year', 'day', 'hour', 'minute', 'second', 'millisecond']);
    for (let i = 0; i + 1 < TIME_UNITS.length; i++) {
      expect(TIME_UNITS[i].ms % TIME_UNITS[i + 1].ms).toBe(0);
    }
  });

  it('extracts each digit modulo its parent, so nothing double-counts', () => {
    const ms = 400 * DAY + 25 * 3_600_000 + 61 * 60_000 + 61_000 + 1001;
    const d = delta2dict(ms);
    const rebuilt = d.year * 365 * DAY + d.day * DAY + d.hour * 3_600_000 + d.minute * 60_000 + d.second * 1000 + d.millisecond;
    expect(rebuilt).toBe(ms);
  });
});

describe('delta2dict', () => {
  it('breaks a past delta into every unit', () => {
    const d = delta2dict(NOW - PAST);
    expect(d).toEqual({ year: 1, day: 127, hour: 16, minute: 18, second: 39, millisecond: 45 });
  });

  it('breaks a future delta the same way, sign ignored', () => {
    const d = delta2dict(NOW - FUTURE);
    expect(d).toEqual({ year: 0, day: 2, hour: 3, minute: 27, second: 27, millisecond: 967 });
  });
});

describe('extractComponents', () => {
  it('keeps only the non-zero units, in order', () => {
    const c = extractComponents(2 * DAY + 3 * 3_600_000);
    expect(c).toEqual([
      { unit: 'day', abbr: 'd', value: 2 },
      { unit: 'hour', abbr: 'h', value: 3 },
    ]);
  });

  it('is empty for zero', () => {
    expect(extractComponents(0)).toEqual([]);
  });

  it('is empty below the floor, and unsigned', () => {
    expect(extractComponents(999, 'second')).toEqual([]);
    expect(extractComponents(-DAY)).toEqual([{ unit: 'day', abbr: 'd', value: 1 }]);
  });
});

describe('formatComponents', () => {
  it('formats and pluralizes', () => {
    const c = [{ unit: 'year' as const, abbr: 'y', value: 2 }, { unit: 'day' as const, abbr: 'd', value: 1 }];
    expect(formatComponents(c)).toBe('2 years, 1 day');
    expect(formatComponents(c, { abbreviate: true })).toBe('2y, 1d');
    expect(formatComponents(c, { precision: 1 })).toBe('2 years');
  });

  it('is empty for no components', () => {
    expect(formatComponents([])).toBe('');
  });

  it('never pluralizes an abbreviation', () => {
    expect(formatComponents([{ unit: 'millisecond', abbr: 'ms', value: 250 }], { abbreviate: true })).toBe('250ms');
    expect(formatComponents([{ unit: 'millisecond', abbr: 'ms', value: 1 }])).toBe('1 millisecond');
  });
});

describe('getDeltaFromSubject', () => {
  it('reports positive as past, like python', () => {
    expect(getDeltaFromSubject(PAST, NOW)).toEqual({ deltaMs: NOW - PAST, isPast: true });
    expect(getDeltaFromSubject(FUTURE, NOW).isPast).toBe(false);
  });

  it('takes now as a Date as readily as a number', () => {
    expect(getDeltaFromSubject(PAST, new Date(NOW)).deltaMs).toBe(NOW - PAST);
  });

  it('measures against the wall clock when no now is given', () => {
    const { deltaMs, isPast } = getDeltaFromSubject(Date.now() - 1000);
    expect(isPast).toBe(true);
    expect(deltaMs).toBeGreaterThanOrEqual(1000);
    expect(deltaMs).toBeLessThan(2000);
  });

  it('forgives the newline git leaves on a date', () => {
    // `git log -1 --format=%aI` hands back its stdout verbatim.
    expect(getDeltaFromSubject('2026-09-04T12:00:00Z\n', NOW).deltaMs).toBe(NOW - Date.UTC(2026, 8, 4, 12));
  });

  it('refuses an invalid Date object, not only a bad string', () => {
    expect(() => getDeltaFromSubject(new Date('nope'), NOW)).toThrow(TypeError);
    expect(() => getDeltaFromSubject(NaN, NOW)).toThrow(TypeError);
  });

  it('reads zero as past — the boundary python draws too', () => {
    expect(getDeltaFromSubject(NOW, NOW)).toEqual({ deltaMs: 0, isPast: true });
  });
});
