import { describe, it, expect } from 'vitest';
import { parseResetDate, resolveExtraUsage } from './extra-usage';

const synced = new Date('2026-03-16T20:54:24.321Z');

describe('parseResetDate', () => {
  it('anchors a year-less reset to the sync year when still ahead', () => {
    expect(parseResetDate('Apr 1', synced)?.toISOString()).toBe('2026-04-01T00:00:00.000Z');
  });
  it('rolls a year-less reset forward when it already passed at sync time', () => {
    expect(parseResetDate('Jan 5', synced)?.toISOString()).toBe('2027-01-05T00:00:00.000Z');
  });
  it('keeps a reset on the sync day itself in the sync year', () => {
    expect(parseResetDate('Mar 16', synced)?.toISOString()).toBe('2026-03-16T00:00:00.000Z');
  });
  it('accepts explicit years and ISO dates', () => {
    expect(parseResetDate('Apr 1, 2026', synced)?.toISOString()).toBe('2026-04-01T00:00:00.000Z');
    expect(parseResetDate('2026-04-01', synced)?.toISOString()).toBe('2026-04-01T00:00:00.000Z');
  });
  it('returns null for garbage', () => {
    expect(parseResetDate('soon', synced)).toBeNull();
    expect(parseResetDate('', synced)).toBeNull();
    expect(parseResetDate(null, synced)).toBeNull();
  });
});

describe('resolveExtraUsage', () => {
  const snapshot = {
    extraSpent: '318.32', extraLimit: '319', extraBalance: '0.93',
    extraResetDate: 'Apr 1', extraUpdatedAt: synced.toISOString(),
  };

  it('is current before the reset date', () => {
    const r = resolveExtraUsage(snapshot, new Date('2026-03-20T00:00:00Z'));
    expect(r.expired).toBe(false);
    expect(r.resetAt).toBe('2026-04-01T00:00:00.000Z');
  });

  it('expires once the reset date passes — our March snapshot read in September', () => {
    const r = resolveExtraUsage(snapshot, new Date('2026-09-03T13:44:00Z'));
    expect(r.expired).toBe(true);
    expect(r.expiredReason).toBe('reset_passed');
  });

  it('expires an unparseable reset after 35 days', () => {
    const r = resolveExtraUsage({ ...snapshot, extraResetDate: 'soon' }, new Date('2026-04-25T00:00:00Z'));
    expect(r.expired).toBe(true);
    expect(r.expiredReason).toBe('too_old');
  });

  it('keeps an unparseable reset current inside 35 days', () => {
    const r = resolveExtraUsage({ ...snapshot, extraResetDate: 'soon' }, new Date('2026-04-01T00:00:00Z'));
    expect(r.expired).toBe(false);
  });

  it('never expires an empty snapshot', () => {
    const r = resolveExtraUsage(
      { extraSpent: null, extraLimit: null, extraBalance: null, extraResetDate: null, extraUpdatedAt: null },
      new Date('2030-01-01T00:00:00Z'),
    );
    expect(r.expired).toBe(false);
  });
});
