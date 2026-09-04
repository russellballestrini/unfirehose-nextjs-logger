import { describe, it, expect } from 'vitest';
import { utcToLocalDate, fmtLocalHHMM } from './local-time';

describe('utcToLocalDate', () => {
  it('reads a SQLite timestamp as UTC rather than as local time', () => {
    // SQLite writes no zone marker, and `new Date()` would take that as
    // local — shifting every mesh chart by the operator's offset, with the
    // data right and the axis wrong.
    expect(utcToLocalDate('2026-09-04 12:00:00').toISOString()).toBe('2026-09-04T12:00:00.000Z');
  });

  it('accepts the seconds-less form SQLite also emits', () => {
    expect(utcToLocalDate('2026-09-04 12:00').toISOString()).toBe('2026-09-04T12:00:00.000Z');
  });

  it('formats in the viewer zone, on a 24-hour clock', () => {
    // The value depends on where the viewer is; the shape does not.
    expect(fmtLocalHHMM('2026-09-04 12:00:00')).toMatch(/^\d{2}:\d{2}$/);
  });
});
