import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
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

describe('report-coverage and report-crap', () => {
  it('read the coverage on disk, or say plainly that there is none', async () => {
    // Both refuse rather than reporting zeros, because a report of 0%
    // coverage and a report of no measurement look identical afterwards.
    const coverage = await import('./report-coverage.ts');
    const crap = await import('./report-crap.ts');
    expect(typeof coverage.main).toBe('function');
    expect(typeof crap.main).toBe('function');
  });
});
