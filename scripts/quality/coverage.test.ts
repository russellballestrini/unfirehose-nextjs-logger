import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { coverageOfRange, percent, totals, loadCoverage, type FileCoverage } from './coverage.ts';
import { ROOT } from './workspaces.ts';

/**
 * Attribution is what turns a per-file percentage into a per-function one,
 * and it is the step that makes CRAP rankable. Every case here is one the
 * real reports hit.
 */
function fileWith(
  statements: [line: number, hits: number][],
  functions: [line: number, hits: number][] = [],
): FileCoverage {
  const statementMap: Record<string, { start: { line: number }; end: { line: number } }> = {};
  const s: Record<string, number> = {};
  statements.forEach(([line, hits], i) => {
    statementMap[i] = { start: { line }, end: { line } };
    s[i] = hits;
  });
  const fnMap: Record<string, { name: string; decl: { start: { line: number }; end: { line: number } }; loc: { start: { line: number }; end: { line: number } } }> = {};
  const f: Record<string, number> = {};
  functions.forEach(([line, hits], i) => {
    fnMap[i] = { name: `fn${i}`, decl: { start: { line }, end: { line } }, loc: { start: { line }, end: { line } } };
    f[i] = hits;
  });
  const raw = { path: '/virtual/x.ts', statementMap, s, branchMap: {}, b: {}, fnMap, f };
  return {
    path: 'virtual/x.ts',
    statements: { covered: statements.filter(([, h]) => h > 0).length, total: statements.length },
    branches: { covered: 0, total: 0 },
    functions: { covered: functions.filter(([, h]) => h > 0).length, total: functions.length },
    lines: new Map(statements),
    raw: raw as FileCoverage['raw'],
  };
}

describe('coverageOfRange', () => {
  it('counts only the statements inside our line range', () => {
    // Lines 1-2 belong to a neighbouring function and must not be borrowed.
    const file = fileWith([[1, 5], [2, 5], [10, 1], [11, 0], [12, 0], [13, 0]]);
    expect(coverageOfRange(file, 10, 13).fraction).toBeCloseTo(0.25, 6);
    expect(coverageOfRange(file, 10, 13).statements).toBe(4);
  });

  it('reads a function nothing entered as nothing covered', () => {
    const file = fileWith([[5, 0], [6, 0]]);
    expect(coverageOfRange(file, 5, 6).fraction).toBe(0);
  });

  it('reads a function every statement of which ran as fully covered', () => {
    const file = fileWith([[5, 2], [6, 9]]);
    expect(coverageOfRange(file, 5, 6).fraction).toBe(1);
  });

  it('falls back to whether a statementless function was entered', () => {
    // A one-line arrow can carry no statement of its own. "Nothing to cover"
    // and "never called" are different facts, so we ask the function counter.
    const file = fileWith([[99, 1]], [[5, 3]]);
    expect(coverageOfRange(file, 5, 5)).toEqual({ fraction: 1, statements: 0 });

    const cold = fileWith([[99, 1]], [[5, 0]]);
    expect(cold ? coverageOfRange(cold, 5, 5).fraction : null).toBe(0);
  });

  it('treats a file no report mentions as uncovered rather than crashing', () => {
    // A source file the suite never loaded has no entry at all.
    expect(coverageOfRange(undefined, 1, 10)).toEqual({ fraction: 0, statements: 0 });
  });
});

describe('summaries', () => {
  it('reports an empty file as fully covered, having nothing to miss', () => {
    expect(percent({ covered: 0, total: 0 })).toBe(100);
  });

  it('adds up across files rather than averaging their percentages', () => {
    // Averaging would let a fully covered two-line file cancel out a
    // thousand-line file nobody tests.
    const acc = totals([
      fileWith([[1, 1], [2, 1]]),
      fileWith(Array.from({ length: 100 }, (_, i) => [i + 1, 0] as [number, number])),
    ]);
    expect(acc.statements).toEqual({ covered: 2, total: 102 });
    expect(percent(acc.statements)).toBeCloseTo(1.96, 2);
  });
});

describe('loadCoverage', () => {
  let dir: string;

  beforeAll(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'unfirehose-cov-'));
  });
  afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

  const report = (name: string, files: Record<string, unknown>) => {
    const ws = path.join(dir, name, 'coverage');
    fs.mkdirSync(ws, { recursive: true });
    fs.writeFileSync(path.join(ws, 'coverage-final.json'), JSON.stringify(files));
    // A workspace dir is stated relative to our repo root, so a fixture in
    // the system temp directory has to be expressed as a path back out of it.
    return { name, dir: path.relative(ROOT, path.join(dir, name)), src: ['.'], tested: true };
  };

  const istanbul = (file: string, hits: number[]) => ({
    path: file,
    statementMap: Object.fromEntries(hits.map((_, i) => [i, { start: { line: i + 1 }, end: { line: i + 1 } }])),
    s: Object.fromEntries(hits.map((h, i) => [i, h])),
    branchMap: {}, b: {}, fnMap: {}, f: {},
  });

  it('reads a workspace report and summarises each file', () => {
    const ws = report('alpha', {
      '/repo/a.ts': istanbul('/repo/a.ts', [1, 1, 0, 0]),
    });
    const cov = loadCoverage([ws as never]);

    expect(cov.found).toHaveLength(1);
    expect(cov.missing).toHaveLength(0);
    const file = [...cov.files.values()][0];
    expect(file.statements).toEqual({ covered: 2, total: 4 });
  });

  it('names a workspace whose report is not on disk instead of ignoring it', () => {
    // A suite that failed to run leaves no file, and a report that quietly
    // omitted it would read as "nothing to cover here".
    const cov = loadCoverage([{ name: 'ghost', dir: 'nowhere', src: ['.'], tested: true } as never]);
    expect(cov.found).toEqual([]);
    expect(cov.missing).toHaveLength(1);
  });

  it('keeps the better reading when two suites both touch a file', () => {
    // A shared file measured by two packages should not read as uncovered
    // just because the second suite happened to be listed last.
    const cold = report('beta', { '/repo/shared.ts': istanbul('/repo/shared.ts', [0, 0, 0, 0]) });
    const warm = report('gamma', { '/repo/shared.ts': istanbul('/repo/shared.ts', [1, 1, 1, 0]) });

    const [a] = [...loadCoverage([cold as never, warm as never]).files.values()];
    expect(a.statements.covered).toBe(3);
    const [b] = [...loadCoverage([warm as never, cold as never]).files.values()];
    expect(b.statements.covered).toBe(3);
  });
});
