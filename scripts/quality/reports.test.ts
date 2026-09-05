import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { spawnSync } from 'child_process';
import { ROOT } from './workspaces.ts';

/**
 * The reports themselves run.
 *
 * Their bodies used to execute on import, so nothing could call one without
 * printing to a terminal and exiting — which is why the tools that measure
 * this repo were the least measured code in it. Each now has a `main`, and
 * these call it.
 *
 * The assertion is the JSON each writes, not the terminal output: the shape
 * of that file is what a later run reads back, and what the Makefile's
 * `report` target leaves behind.
 */

let out: string;
const quiet = { log: console.log, error: console.error };

beforeAll(() => {
  out = fs.mkdtempSync(path.join(os.tmpdir(), 'unfirehose-reports-'));
  console.log = vi.fn();
  console.error = vi.fn();
});

afterAll(() => {
  console.log = quiet.log;
  console.error = quiet.error;
  fs.rmSync(out, { recursive: true, force: true });
});

const jsonAt = (name: string) => path.relative(ROOT, path.join(out, name));
const read = (name: string) => JSON.parse(fs.readFileSync(path.join(out, name), 'utf8'));

describe('report-cc', () => {
  it('writes every function it scored, worst first', async () => {
    const { main } = await import('./report-cc.ts');
    main(['--json', jsonAt('cc.json'), '--top', '5']);

    const report = read('cc.json');
    expect(report.functions.length).toBeGreaterThan(100);
    expect(report.bands.simple).toBeGreaterThan(0);
    for (let i = 1; i < 50; i += 1) {
      expect(report.functions[i - 1].complexity).toBeGreaterThanOrEqual(report.functions[i].complexity);
    }
  });

  it('narrows to one workspace when asked', async () => {
    const { main } = await import('./report-cc.ts');
    main(['--json', jsonAt('cc-core.json'), '--dir', 'packages/core']);
    for (const fn of read('cc-core.json').functions) {
      expect(fn.path.startsWith('packages/core')).toBe(true);
    }
  });
});

describe('report-dupes', () => {
  it('writes the clones and what they cost', async () => {
    const { main } = await import('./report-dupes.ts');
    main(['--json', jsonAt('dupes.json'), '--min', '120']);

    const report = read('dupes.json');
    expect(report.minTokens).toBe(120);
    expect(typeof report.redundantTokens).toBe('number');
    for (const clone of report.clones) {
      expect(clone.instances.length).toBeGreaterThan(1);
      expect(clone.tokens).toBeGreaterThanOrEqual(120);
    }
  });
});

describe('report-orphans', () => {
  it('writes what nothing reaches', async () => {
    const { main } = await import('./report-orphans.ts');
    main(['--json', jsonAt('orphans.json')]);

    const report = read('orphans.json');
    expect(report.files).toBeGreaterThan(100);
    expect(Array.isArray(report.orphaned)).toBe(true);
    expect(Array.isArray(report.deadFunctions)).toBe(true);
    // The repo is clean today, and this is the assertion that says so —
    // a future orphan fails here rather than waiting to be noticed.
    expect(report.orphaned).toEqual([]);
    expect(report.deadFunctions).toEqual([]);
  });
});

describe('report-crap', () => {
  it('scores every function it measured and writes them worst first', async () => {
    const { main } = await import('./report-crap.ts');
    main(['--json', jsonAt('crap.json')]);
    const r = read('crap.json');
    expect(r.functions.length).toBeGreaterThan(1000);
    const craps = r.functions.map((f: { crap: number }) => f.crap);
    expect([...craps].sort((a: number, b: number) => b - a)).toEqual(craps);
  });

  it('scores a fully covered function at exactly its complexity', () => {
    // This is the property the whole metric rests on, and it is why the
    // total can never fall below the sum of our complexity. Asserted against
    // the real report rather than a fixture, so a change to the formula that
    // breaks it is caught here.
    const r = read('crap.json');
    const covered = r.functions.filter((f: { coverage: number }) => f.coverage === 1);
    expect(covered.length).toBeGreaterThan(100);
    for (const f of covered.slice(0, 200)) expect(f.crap).toBe(f.complexity);
  });

  it('never scores a function below its own complexity', () => {
    const r = read('crap.json');
    for (const f of r.functions) expect(f.crap).toBeGreaterThanOrEqual(f.complexity);
  });

  it('carries the threshold it judged by, and counts what failed it', () => {
    // The number is meaningless without the threshold that produced it.
    const r = read('crap.json');
    expect(typeof r.threshold).toBe('number');
    expect(r.over).toBe(r.functions.filter((f: { crap: number }) => f.crap > r.threshold).length);
  });

  it('reports a total that is the sum of what it wrote', async () => {
    const { main } = await import('./report-crap.ts');
    main(['--json', jsonAt('crap-total.json')]);
    const r = read('crap-total.json');
    const sum = r.functions.reduce((a: number, f: { crap: number }) => a + f.crap, 0);
    expect(r.total).toBeCloseTo(sum, 6);
  });

  it('honours a threshold given on the command line', async () => {
    const { main } = await import('./report-crap.ts');
    main(['--threshold', '9999', '--json', jsonAt('crap-high.json')]);
    expect(read('crap-high.json').threshold).toBe(9999);
    expect(read('crap-high.json').over).toBe(0);
  });

  it('refuses a budget when a workspace was not measured', async () => {
    // A workspace with no report on disk is silently not scored, and its
    // complexity leaves the total with it — which reads as an improvement.
    // This report once showed 9,778 instead of 10,366 because one of four
    // suites had not finished writing when `make -j4` reached it. A gate
    // that passes because it measured less is worse than no gate.
    const { main } = await import('./report-crap.ts');
    const coverage = await import('./coverage.ts');
    const real = coverage.loadCoverage();
    const spy = vi.spyOn(coverage, 'loadCoverage').mockReturnValue({
      ...real, missing: [{ dir: 'packages/core', tested: true } as never],
    });
    const exit = vi.spyOn(process, 'exit').mockImplementation((() => { throw new Error('exit'); }) as never);
    expect(() => main(['--budget', '999999'])).toThrow('exit');
    // Without a budget it warns and carries on, since a partial number is
    // still worth reading when nothing depends on it.
    exit.mockClear();
    expect(() => main([])).not.toThrow();
    expect(exit).not.toHaveBeenCalled();
    spy.mockRestore();
    exit.mockRestore();
  });

  it('refuses rather than reporting zeros when there is no coverage', async () => {
    // A report of 0% coverage and a report of no measurement look identical
    // afterwards, and only one of them means anything.
    const { main } = await import('./report-crap.ts');
    const { loadCoverage } = await import('./coverage.ts');
    const spy = vi.spyOn(await import('./coverage.ts'), 'loadCoverage')
      .mockReturnValue({ found: [], files: new Map() } as ReturnType<typeof loadCoverage>);
    const exit = vi.spyOn(process, 'exit').mockImplementation((() => { throw new Error('exit'); }) as never);
    expect(() => main([])).toThrow('exit');
    expect(exit).toHaveBeenCalledWith(1);
    spy.mockRestore();
    exit.mockRestore();
  });
});

describe('report-coverage', () => {
  it('writes covered-of-total per workspace, not a percentage', async () => {
    // A percentage cannot be added up. Keeping both numbers is what lets
    // the overall figure be recomputed rather than averaged — averaging
    // workspace percentages weights a 40-file package the same as a 400.
    const { main } = await import('./report-coverage.ts');
    main(['--json', jsonAt('coverage.json')]);
    const r = read('coverage.json');
    expect(r.workspaces.length).toBeGreaterThan(0);
    for (const w of r.workspaces) {
      for (const metric of ['statements', 'branches', 'functions'] as const) {
        expect(w[metric].covered).toBeLessThanOrEqual(w[metric].total);
        expect(w[metric].covered).toBeGreaterThanOrEqual(0);
      }
    }
  });

  it('reports an overall figure that is the sum of the parts', async () => {
    const r = read('coverage.json');
    for (const metric of ['statements', 'branches', 'functions'] as const) {
      const summed = r.workspaces.reduce(
        (a: number, w: Record<string, { total: number }>) => a + w[metric].total, 0);
      expect(r.overall[metric].total).toBe(summed);
    }
  });

  it('lists the files it measured', async () => {
    const r = read('coverage.json');
    expect(r.files.length).toBeGreaterThan(100);
    expect(r.files[0]).toHaveProperty('path');
  });

  it('refuses rather than reporting zeros when there is no coverage', async () => {
    const { main } = await import('./report-coverage.ts');
    const { loadCoverage } = await import('./coverage.ts');
    const spy = vi.spyOn(await import('./coverage.ts'), 'loadCoverage')
      .mockReturnValue({ found: [], files: new Map() } as ReturnType<typeof loadCoverage>);
    const exit = vi.spyOn(process, 'exit').mockImplementation((() => { throw new Error('exit'); }) as never);
    expect(() => main([])).toThrow('exit');
    spy.mockRestore();
    exit.mockRestore();
  });
});

/**
 * The budgets, which are the only part of these reports CI reads.
 *
 * A report that prints a number nobody checks is a report. A budget that
 * cannot fail is worse than none, because it looks like a gate — which is
 * exactly what our coverage thresholds had become, sitting at 5% functions
 * while the real number climbed to seventy.
 */
describe('budgets', () => {
  const run = (script: string, args: string[]) => {
    const res = spawnSync('npx', ['tsx', `scripts/quality/${script}`, ...args], {
      cwd: ROOT, encoding: 'utf-8', timeout: 300_000,
    });
    return { code: res.status, out: (res.stdout ?? '') + (res.stderr ?? '') };
  };

  // The crap budget is checked in-process rather than by spawning. Under
  // `make coverage -j4` and inside this suite's own coverage run, one
  // workspace's report is legitimately absent from disk for a few seconds,
  // and report-crap now refuses a budget against a partial measurement —
  // correctly. Spawning here would be a race, not a test.
  const crapWithFullCoverage = async () => {
    const coverage = await import('./coverage.ts');
    const real = coverage.loadCoverage();
    return vi.spyOn(coverage, 'loadCoverage').mockReturnValue({ ...real, missing: [] });
  };

  it('fails the build when crap is over its budget', async () => {
    const { main } = await import('./report-crap.ts');
    const spy = await crapWithFullCoverage();
    const exit = vi.spyOn(process, 'exit').mockImplementation((() => { throw new Error('exit'); }) as never);
    expect(() => main(['--budget', '1'])).toThrow('exit');
    expect(exit).toHaveBeenCalledWith(1);
    spy.mockRestore(); exit.mockRestore();
  });

  it('passes, and says so, when crap is under it', async () => {
    const { main } = await import('./report-crap.ts');
    const spy = await crapWithFullCoverage();
    const exit = vi.spyOn(process, 'exit').mockImplementation((() => { throw new Error('exit'); }) as never);
    expect(() => main(['--budget', '999999'])).not.toThrow();
    expect(exit).not.toHaveBeenCalled();
    spy.mockRestore(); exit.mockRestore();
  });

  it('fails the build when duplication is over its budget', () => {
    const r = run('report-dupes.ts', ['--budget', '1']);
    expect(r.code).toBe(1);
    expect(r.out).toMatch(/redundant tokens \d+ is over the budget/);
  });

  it('says nothing about budgets when none was asked for', () => {
    // The reports are read by people too, and a number with no budget
    // beside it should not imply one.
    const r = run('report-dupes.ts', []);
    expect(r.code).toBe(0);
    expect(r.out).not.toMatch(/budget/);
  });
});
