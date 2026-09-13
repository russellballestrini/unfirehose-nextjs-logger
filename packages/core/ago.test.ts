import { describe, it, expect } from 'vitest';
import { human, humanDelta, delta2dict, extractComponents, formatComponents, getDeltaFromSubject } from './ago';

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
});

describe('formatComponents', () => {
  it('formats and pluralizes', () => {
    const c = [{ unit: 'year' as const, abbr: 'y', value: 2 }, { unit: 'day' as const, abbr: 'd', value: 1 }];
    expect(formatComponents(c)).toBe('2 years, 1 day');
    expect(formatComponents(c, { abbreviate: true })).toBe('2y, 1d');
    expect(formatComponents(c, { precision: 1 })).toBe('2 years');
  });
});

describe('getDeltaFromSubject', () => {
  it('reports positive as past, like python', () => {
    expect(getDeltaFromSubject(PAST, NOW)).toEqual({ deltaMs: NOW - PAST, isPast: true });
    expect(getDeltaFromSubject(FUTURE, NOW).isPast).toBe(false);
  });
});
