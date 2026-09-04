/**
 * Terminal shape shared by every report here: one table, one bar, one set
 * of colours, so four reports read as four views of one instrument rather
 * than four tools that happen to live in the same directory.
 */

import fs from 'fs';
import path from 'path';

const NO_COLOUR = process.env.NO_COLOR !== undefined || !process.stdout.isTTY;

const CODES: Record<string, string> = {
  reset: '\x1b[0m',
  dim: '\x1b[2m',
  bold: '\x1b[1m',
  red: '\x1b[31m',
  yellow: '\x1b[33m',
  green: '\x1b[32m',
  cyan: '\x1b[36m',
  magenta: '\x1b[35m',
};

export function paint(text: string, ...styles: string[]): string {
  if (NO_COLOUR) return text;
  return styles.map((s) => CODES[s] ?? '').join('') + text + CODES.reset;
}

export const dim = (t: string) => paint(t, 'dim');
export const bold = (t: string) => paint(t, 'bold');

/** Green when healthy, red when it needs work — high or low is the caller's call. */
export function grade(text: string, value: number, warn: number, bad: number, higherIsWorse = true): string {
  const failing = higherIsWorse ? value >= bad : value <= bad;
  const warning = higherIsWorse ? value >= warn : value <= warn;
  if (failing) return paint(text, 'red');
  if (warning) return paint(text, 'yellow');
  return paint(text, 'green');
}

export function bar(fraction: number, width = 20): string {
  const filled = Math.round(Math.max(0, Math.min(1, fraction)) * width);
  const pct = fraction * 100;
  const glyphs = '█'.repeat(filled) + dim('░'.repeat(width - filled));
  return grade(glyphs, pct, 70, 50, false);
}

interface Column {
  header: string;
  /** Right-align numbers, left-align names. */
  align?: 'left' | 'right';
  width?: number;
}

/**
 * A table that measures its own columns. Cells arrive already coloured, so
 * width is taken from the text with escapes stripped.
 */
export function table(columns: Column[], rows: string[][]): string {
  const plain = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, '');
  const widths = columns.map((col, i) =>
    Math.max(col.width ?? 0, plain(col.header).length, ...rows.map((r) => plain(r[i] ?? '').length)),
  );

  const line = (cells: string[], style?: (s: string) => string) =>
    cells
      .map((cell, i) => {
        const pad = widths[i] - plain(cell).length;
        const padded = columns[i].align === 'right' ? ' '.repeat(pad) + cell : cell + ' '.repeat(pad);
        return style ? style(padded) : padded;
      })
      .join('  ')
      .trimEnd();

  return [
    line(columns.map((c) => c.header), bold),
    dim(widths.map((w) => '─'.repeat(w)).join('  ')),
    ...rows.map((r) => line(r)),
  ].join('\n');
}

export function heading(text: string): string {
  return `\n${bold(text)}\n${dim('═'.repeat(text.length))}`;
}

/** `--flag=value`, `--flag value`, and bare `--flag`. */
export function args(argv = process.argv.slice(2)) {
  const flags = new Map<string, string>();
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!arg.startsWith('--')) continue;
    const eq = arg.indexOf('=');
    if (eq !== -1) {
      flags.set(arg.slice(2, eq), arg.slice(eq + 1));
    } else if (argv[i + 1] && !argv[i + 1].startsWith('--')) {
      flags.set(arg.slice(2), argv[i + 1]);
      i += 1;
    } else {
      flags.set(arg.slice(2), 'true');
    }
  }
  return {
    has: (name: string) => flags.has(name),
    str: (name: string, fallback: string) => flags.get(name) ?? fallback,
    num: (name: string, fallback: number) => {
      const raw = flags.get(name);
      const n = raw === undefined ? NaN : Number(raw);
      return Number.isFinite(n) ? n : fallback;
    },
  };
}

/** Write a machine-readable copy next to the printed one. */
export function writeJson(file: string, data: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(data, null, 2)}\n`);
}
