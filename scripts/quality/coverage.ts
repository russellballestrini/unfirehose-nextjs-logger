/**
 * Read what vitest measured, per file and per line range.
 *
 * `coverage-final.json` is istanbul's shape even when v8 collected it: a
 * `statementMap` of ranges with a hit count each, plus the same for branches
 * and functions. That per-range detail is what lets the CRAP report ask
 * "how much of *this function* ran", which a percentage per file cannot
 * answer.
 */

import fs from 'fs';
import path from 'path';
import { ROOT, WORKSPACES, rel, type Workspace } from './workspaces.ts';

interface Range { start: { line: number }; end: { line: number } }

interface IstanbulFile {
  path: string;
  statementMap: Record<string, Range>;
  s: Record<string, number>;
  branchMap: Record<string, { loc: Range }>;
  b: Record<string, number[]>;
  fnMap: Record<string, { name: string; decl: Range; loc: Range }>;
  f: Record<string, number>;
}

export interface FileCoverage {
  path: string;
  statements: { covered: number; total: number };
  branches: { covered: number; total: number };
  functions: { covered: number; total: number };
  /** Hit count per statement, keyed by the line it starts on. */
  lines: Map<number, number>;
  raw: IstanbulFile;
}

interface CoverageSet {
  /** Keyed by path relative to our repo root. */
  files: Map<string, FileCoverage>;
  /** Workspaces whose report was found. */
  found: Workspace[];
  /** Workspaces that claim a suite but have no report on disk. */
  missing: Workspace[];
}

const pct = (c: { covered: number; total: number }) =>
  c.total === 0 ? 100 : (c.covered / c.total) * 100;

export const percent = pct;

export function reportPath(ws: Workspace): string {
  return path.join(ROOT, ws.dir, 'coverage', 'coverage-final.json');
}

function readOne(file: string): IstanbulFile[] {
  const raw = JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, IstanbulFile>;
  return Object.values(raw);
}

function summarise(f: IstanbulFile): FileCoverage {
  const statements = { covered: 0, total: 0 };
  const lines = new Map<number, number>();
  for (const [id, range] of Object.entries(f.statementMap)) {
    const hits = f.s[id] ?? 0;
    statements.total += 1;
    if (hits > 0) statements.covered += 1;
    const line = range.start.line;
    lines.set(line, Math.max(lines.get(line) ?? 0, hits));
  }

  const branches = { covered: 0, total: 0 };
  for (const counts of Object.values(f.b)) {
    for (const hits of counts) {
      branches.total += 1;
      if (hits > 0) branches.covered += 1;
    }
  }

  const functions = { covered: 0, total: 0 };
  for (const id of Object.keys(f.fnMap)) {
    functions.total += 1;
    if ((f.f[id] ?? 0) > 0) functions.covered += 1;
  }

  return { path: rel(f.path), statements, branches, functions, lines, raw: f };
}

/** Every coverage report on disk, merged into one lookup. */
export function loadCoverage(only?: Workspace[]): CoverageSet {
  const files = new Map<string, FileCoverage>();
  const found: Workspace[] = [];
  const missing: Workspace[] = [];

  for (const ws of only ?? WORKSPACES.filter((w) => w.tested)) {
    const report = reportPath(ws);
    if (!fs.existsSync(report)) {
      missing.push(ws);
      continue;
    }
    found.push(ws);
    for (const f of readOne(report)) {
      const summary = summarise(f);
      // A file measured by two suites keeps the more favourable reading:
      // it did run, somewhere.
      const prior = files.get(summary.path);
      if (!prior || pct(summary.statements) > pct(prior.statements)) {
        files.set(summary.path, summary);
      }
    }
  }

  return { files, found, missing };
}

/**
 * How much of one line range ran, as a fraction.
 *
 * Statements are attributed to the function whose body contains their first
 * line. A function with no statements of its own — a one-line arrow that v8
 * folded away, an empty body — falls back to whether it was entered at all,
 * because "nothing to cover" and "never called" are different facts.
 */
export function coverageOfRange(
  file: FileCoverage | undefined,
  startLine: number,
  endLine: number,
): { fraction: number; statements: number } {
  if (!file) return { fraction: 0, statements: 0 };

  let covered = 0;
  let total = 0;
  for (const [id, range] of Object.entries(file.raw.statementMap)) {
    const line = range.start.line;
    if (line < startLine || line > endLine) continue;
    total += 1;
    if ((file.raw.s[id] ?? 0) > 0) covered += 1;
  }
  if (total > 0) return { fraction: covered / total, statements: total };

  for (const [id, fn] of Object.entries(file.raw.fnMap)) {
    const line = fn.decl?.start?.line ?? fn.loc?.start?.line;
    if (line === undefined || line < startLine || line > endLine) continue;
    return { fraction: (file.raw.f[id] ?? 0) > 0 ? 1 : 0, statements: 0 };
  }

  return { fraction: 0, statements: 0 };
}

/** Totals across a set of files. */
export function totals(files: Iterable<FileCoverage>) {
  const acc = {
    statements: { covered: 0, total: 0 },
    branches: { covered: 0, total: 0 },
    functions: { covered: 0, total: 0 },
  };
  for (const f of files) {
    for (const kind of ['statements', 'branches', 'functions'] as const) {
      acc[kind].covered += f[kind].covered;
      acc[kind].total += f[kind].total;
    }
  }
  return acc;
}
