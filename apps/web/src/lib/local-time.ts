/**
 * Reading SQLite's timestamps as what they are.
 *
 * SQLite writes "YYYY-MM-DD HH:MM[:SS]" in UTC with no zone marker, and
 * `new Date()` reads a string like that as local time. On a machine east or
 * west of Greenwich that silently shifts every mesh chart by the operator's
 * offset — the data is right and the axis is wrong, which is the hardest
 * kind of wrong to notice.
 *
 * These lived in two pages, identical down to the comment explaining them.
 */

/** Parse a SQLite UTC timestamp, seconds optional. */
export function utcToLocalDate(utcStr: string): Date {
  const iso = utcStr.replace(' ', 'T') + (utcStr.length <= 16 ? ':00Z' : 'Z');
  return new Date(iso);
}

/** 24-hour clock time in the viewer's zone. */
export function fmtLocalHHMM(utcStr: string): string {
  return utcToLocalDate(utcStr)
    .toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false });
}

/** Short date and time in the viewer's zone. */
export function fmtLocalDateTime(utcStr: string): string {
  return utcToLocalDate(utcStr).toLocaleString([], {
    month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false,
  });
}
