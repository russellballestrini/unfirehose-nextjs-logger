/**
 * CRAP — Change Risk Anti-Patterns — `make crap`.
 *
 *   crap(f) = cc(f)² × (1 − coverage(f))³ + cc(f)
 *
 * Complexity alone flags every parser and dispatch table we deliberately
 * wrote; coverage alone flags every trivial getter nobody bothered to test.
 * Neither is worth acting on. CRAP multiplies them, so a hairy function with
 * tests scores low and a hairy function without them scores enormous — it
 * ranks the code that is both hard to change and unprotected while you
 * change it. That is the list worth working down.
 *
 * A fully covered function scores exactly its complexity, so anything above
 * 30 either wants tests or wants breaking up. The cube is deliberate: partial
 * coverage of a branchy function is worth much less than it looks.
 *
 *   make crap                      after `make coverage`
 *   make crap ARGS="--threshold 60"
 *   npx tsx scripts/quality/report-crap.ts --json reports/crap.json
 */

import path from 'path';
import { ROOT, WORKSPACES, sourcesOf, workspaceOf } from './workspaces.ts';
import { complexityOfAll } from './complexity.ts';
import { loadCoverage, coverageOfRange } from './coverage.ts';
import { crapScore, coverageNeeded, CRAP_THRESHOLD } from './crap.ts';
import { args, table, heading, dim, bold, grade, writeJson, checkBudget } from './render.ts';

/**
 * The report, as a function.
 *
 * These bodies used to run on import, which is what a script does — and it
 * also meant nothing could call one without printing to a terminal and
 * exiting. A `main` that takes its arguments can be tested; the line at the
 * bottom keeps `npx tsx` and `make` working exactly as before.
 */
export function main(argv: string[] = process.argv.slice(2)): void {
  const flags = args(argv);
  const top = flags.num('top', 30);
  const threshold = flags.num('threshold', CRAP_THRESHOLD);

  const cov = loadCoverage();
  if (cov.found.length === 0) {
    console.error('No coverage on disk — CRAP needs it. Run `make coverage` first.');
    process.exit(1);
  }

  const measured = WORKSPACES.filter((ws) => cov.found.some((f) => f.dir === ws.dir));
  const files = measured.flatMap((ws) => sourcesOf(ws));

  const scored = complexityOfAll(files)
    .map((fn) => {
      const file = cov.files.get(fn.path);
      const { fraction, statements } = coverageOfRange(file, fn.line, fn.endLine);
      return { ...fn, coverage: fraction, statements, crap: crapScore(fn.complexity, fraction) };
    })
    // A function with no statements and no coverage record is one v8 folded
    // away — a re-export, a type-only body. Nothing to change, nothing to risk.
    .filter((f) => f.statements > 0 || f.complexity > 1)
    .sort((a, b) => b.crap - a.crap);

  const failing = scored.filter((f) => f.crap > threshold);

  console.log(heading('CRAP by workspace'));
  console.log(table(
    [
      { header: 'workspace' },
      { header: 'functions', align: 'right' },
      { header: `over ${threshold}`, align: 'right' },
      { header: 'worst', align: 'right' },
      { header: 'median', align: 'right' },
    ],
    measured.map((ws) => {
      const mine = scored.filter((f) => workspaceOf(f.file)?.dir === ws.dir);
      if (mine.length === 0) return [ws.dir, dim('—'), '', '', ''];
      const over = mine.filter((f) => f.crap > threshold).length;
      const sorted = [...mine].map((f) => f.crap).sort((a, b) => a - b);
      return [
        ws.dir,
        String(mine.length),
        grade(String(over), over, 1, Math.max(10, mine.length * 0.1)),
        grade(sorted[sorted.length - 1].toFixed(0), sorted[sorted.length - 1], threshold, threshold * 4),
        sorted[Math.floor(sorted.length / 2)].toFixed(1),
      ];
    }),
  ));

  console.log(heading(`Worst offenders (${Math.min(top, failing.length)} of ${failing.length} over ${threshold})`));
  console.log(table(
    [
      { header: 'crap', align: 'right' },
      { header: 'cc', align: 'right' },
      { header: 'cov', align: 'right' },
      { header: 'needs', align: 'right' },
      { header: 'function' },
      { header: 'where' },
    ],
    failing.slice(0, top).map((f) => {
      const needed = coverageNeeded(f.complexity, threshold);
      return [
        grade(f.crap.toFixed(0), f.crap, threshold, threshold * 4),
        String(f.complexity),
        grade(`${(f.coverage * 100).toFixed(0)}%`, f.coverage * 100, 70, 50, false),
        needed === null ? dim('split') : dim(`${(needed * 100).toFixed(0)}%`),
        f.name,
        dim(`${f.path}:${f.line}`),
      ];
    }),
  ));

  const worstFiles = new Map<string, number>();
  for (const f of failing) worstFiles.set(f.path, (worstFiles.get(f.path) ?? 0) + f.crap);
  const byFile = [...worstFiles.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10);

  if (byFile.length > 0) {
    console.log(heading('Files carrying the most risk'));
    console.log(table(
      [{ header: 'crap', align: 'right' }, { header: 'functions', align: 'right' }, { header: 'file' }],
      byFile.map(([file, total]) => [
        grade(total.toFixed(0), total, threshold, threshold * 6),
        String(failing.filter((f) => f.path === file).length),
        file,
      ]),
    ));
  }

  const total = scored.reduce((sum, f) => sum + f.crap, 0);
  console.log(
    `\n  ${bold('total')} ${total.toFixed(0)} across ${scored.length} functions  ` +
    `${dim('·')} ${grade(`${failing.length} over ${threshold}`, failing.length, 1, 50)}  ` +
    `${dim('· a fully covered function scores its own complexity')}`,
  );

  if (flags.has('json')) {
    writeJson(path.resolve(ROOT, flags.str('json', 'reports/crap.json')), {
      generatedAt: new Date().toISOString(),
      threshold,
      total,
      over: failing.length,
      functions: scored.map((f) => ({
        path: f.path, name: f.name, line: f.line,
        complexity: f.complexity, coverage: f.coverage, crap: f.crap,
      })),
    });
  }

  if (flags.has('fail-over') && failing.length > flags.num('fail-over', Infinity)) {
    process.exit(1);
  }

  // A ceiling on the whole board, for CI. `--fail-over` counts offenders,
  // which stays flat while every one of them gets worse; this is the
  // number that moves when risk is added anywhere.
  checkBudget('total crap', Math.round(scored.reduce((sum, f) => sum + f.crap, 0)), flags);

}

// Run when invoked directly, which is how make and npx call it.
if (process.argv[1]?.endsWith('report-crap.ts')) main();
