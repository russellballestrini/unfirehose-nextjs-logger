/**
 * ago — human readable timedeltas.
 *
 * A TypeScript port of russell ballestrini's `ago` (python, public domain,
 * https://github.com/russellballestrini/ago). Same units, same rules:
 *
 *   human(date)                       → "1 year, 127 days ago"
 *   human(date, { precision: 3 })     → "1 year, 127 days, 16 hours ago"
 *   human(future)                     → "in 2 days, 3 hours"
 *   human(date, { abbreviate: true }) → "1y, 127d ago"
 *
 * `precision` counts the non-zero units kept, largest first, so a delta of
 * one year and three hours reads "1 year, 3 hours" — zero days are not a
 * unit worth a slot. Units run year (365 days), day, hour, minute, second,
 * millisecond; no weeks or months, because "4 weeks" is a rounding that
 * hides the day count and a month has no fixed length.
 *
 * Two entry points, because a number is ambiguous. `human` takes an instant
 * (Date or ISO string) and tenses the result against now; `humanDelta`
 * takes a span in milliseconds and by default returns it bare.
 */

export type Unit = 'year' | 'day' | 'hour' | 'minute' | 'second' | 'millisecond';

interface UnitDef {
  name: Unit;
  abbr: string;
  ms: number;
  /** This unit's own digit, given a whole delta in ms. */
  extract: (ms: number) => number;
}

const DAY = 86_400_000;

export const TIME_UNITS: readonly UnitDef[] = [
  { name: 'year', abbr: 'y', ms: 365 * DAY, extract: (ms) => Math.floor(ms / DAY / 365) },
  { name: 'day', abbr: 'd', ms: DAY, extract: (ms) => Math.floor(ms / DAY) % 365 },
  { name: 'hour', abbr: 'h', ms: 3_600_000, extract: (ms) => Math.floor(ms / 3_600_000) % 24 },
  { name: 'minute', abbr: 'm', ms: 60_000, extract: (ms) => Math.floor(ms / 60_000) % 60 },
  { name: 'second', abbr: 's', ms: 1_000, extract: (ms) => Math.floor(ms / 1_000) % 60 },
  { name: 'millisecond', abbr: 'ms', ms: 1, extract: (ms) => Math.floor(ms) % 1_000 },
];

export interface Component {
  unit: Unit;
  abbr: string;
  value: number;
}

export interface FormatOptions {
  /** How many non-zero units to keep, largest first. Default 2. */
  precision?: number;
  /** "1y, 2d" instead of "1 year, 2 days". Default false. */
  abbreviate?: boolean;
  /** Between units. Default ", ". */
  separator?: string;
  /** Drop anything finer than this. Default 'millisecond' (keep everything). */
  smallest?: Unit;
}

export interface HumanOptions extends FormatOptions {
  /** Format for a delta in the past. Default "{} ago". */
  pastTense?: string;
  /** Format for a delta in the future. Default "in {}". */
  futureTense?: string;
  /** What to say when every unit is zero. Default "just now". */
  zero?: string;
  /** The clock to measure against. Tests pin this; pages leave it. */
  now?: Date | number;
}

/**
 * A subject as (delta in ms, is it past). Positive delta = past, matching
 * python's `datetime.now() - subject`.
 */
export function getDeltaFromSubject(
  subject: Date | string | number,
  now: Date | number = Date.now(),
): { deltaMs: number; isPast: boolean } {
  const nowMs = typeof now === 'number' ? now : now.getTime();
  const thenMs = subject instanceof Date ? subject.getTime()
    : typeof subject === 'number' ? subject
    : Date.parse(subject.trim());
  if (!Number.isFinite(thenMs)) throw new TypeError(`Cannot convert ${JSON.stringify(subject)} to a time delta`);
  const deltaMs = nowMs - thenMs;
  return { deltaMs, isPast: deltaMs >= 0 };
}

/** Every unit's digit, zero or not. */
export function delta2dict(deltaMs: number): Record<Unit, number> {
  const abs = Math.abs(deltaMs);
  const out = {} as Record<Unit, number>;
  for (const u of TIME_UNITS) out[u.name] = u.extract(abs);
  return out;
}

/** The non-zero units, largest first. */
export function extractComponents(deltaMs: number, smallest: Unit = 'millisecond'): Component[] {
  const dict = delta2dict(deltaMs);
  const floor = TIME_UNITS.findIndex((u) => u.name === smallest);
  return TIME_UNITS
    .filter((u, i) => i <= floor && dict[u.name] > 0)
    .map((u) => ({ unit: u.name, abbr: u.abbr, value: dict[u.name] }));
}

/** "2 years, 1 day" or "2y, 1d". */
export function formatComponents(components: Component[], opts: FormatOptions = {}): string {
  const { precision = 2, abbreviate = false, separator = ', ' } = opts;
  return components.slice(0, precision).map((c) => {
    if (abbreviate) return `${c.value}${c.abbr}`;
    return `${c.value} ${c.unit}${c.value === 1 ? '' : 's'}`;
  }).join(separator);
}

/**
 * A span of time, in words. Bare by default — "2 hours, 5 minutes" — since a
 * duration (a turn, an uptime) has no tense. Pass `pastTense`/`futureTense`
 * to get one; a negative span counts as future.
 */
export function humanDelta(deltaMs: number, opts: HumanOptions = {}): string {
  const { pastTense = '{}', futureTense = '{}', zero } = opts;
  const components = extractComponents(deltaMs, opts.smallest);
  if (components.length === 0) {
    if (zero !== undefined) return zero;
    // A zero span is "0s", not "just now": nothing happened, it just took no time.
    const floor = opts.smallest ?? 'millisecond';
    const u = TIME_UNITS.find((x) => x.name === floor)!;
    return opts.abbreviate ? `0${u.abbr}` : `0 ${u.name}s`;
  }
  const formatted = formatComponents(components, opts);
  return (deltaMs >= 0 ? pastTense : futureTense).replace('{}', formatted);
}

/**
 * An instant, in words, relative to now: "3 hours, 12 minutes ago" or
 * "in 2 days". An unparseable subject throws — the caller decides what a
 * blank looks like on its page.
 */
export function human(subject: Date | string | number, opts: HumanOptions = {}): string {
  const { deltaMs } = getDeltaFromSubject(subject, opts.now);
  return humanDelta(deltaMs, {
    pastTense: '{} ago',
    futureTense: 'in {}',
    zero: 'just now',
    ...opts,
  });
}
