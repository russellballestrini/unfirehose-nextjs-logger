/**
 * What our suites actually exercise — `make coverage`.
 *
 * Reads the reports each suite left behind rather than running them, so it
 * costs nothing to look twice. `make coverage` runs the suites first; this
 * prints what they found.
 *
 *   make coverage                  every workspace with a suite
 *   npx tsx scripts/quality/report-coverage.ts --worst 20
 *   ... --json reports/coverage.json
 */

import path from 'path';
import { ROOT, WORKSPACES, workspaceOf } from './workspaces.ts';
import { loadCoverage, totals, percent, reportPath, type FileCoverage } from './coverage.ts';
import { args, table, heading, bar, dim, grade, writeJson } from './render.ts';

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
  const worst = flags.num('worst', 15);

  const cov = loadCoverage();

  if (cov.found.length === 0) {
    console.error('No coverage on disk. Run `make coverage` first.');
    process.exit(1);
  }

  // A workspace with no report is not a workspace at 0% — it is one nobody
  // measured, and averaging over what is left flatters the total.
  if (cov.missing.length > 0) {
    console.error(`\n  no coverage report for: ${cov.missing.map((ws) => ws.dir).join(', ')}`);
    console.error('  these are not counted below. Run `make coverage`.');
  }

  const pctCell = (c: { covered: number; total: number }) => {
    const p = percent(c);
    return grade(`${p.toFixed(1)}%`, p, 70, 50, false);
  };

  console.log(heading('Coverage by workspace'));

  const byWorkspace = new Map<string, FileCoverage[]>();
  for (const file of cov.files.values()) {
    const ws = workspaceOf(path.join(ROOT, file.path));
    const key = ws?.dir ?? 'other';
    byWorkspace.set(key, [...(byWorkspace.get(key) ?? []), file]);
  }

  const wsRows = WORKSPACES.map((ws) => {
    const files = byWorkspace.get(ws.dir) ?? [];
    if (files.length === 0) {
      return [ws.dir, dim('—'), dim(ws.tested ? 'not measured' : 'no suite'), '', '', ''];
    }
    const t = totals(files);
    return [
      ws.dir,
      String(files.length),
      `${bar(percent(t.statements) / 100)} ${pctCell(t.statements)}`,
      pctCell(t.branches),
      pctCell(t.functions),
      dim(`${t.statements.covered}/${t.statements.total}`),
    ];
  });

  console.log(table(
    [
      { header: 'workspace' },
      { header: 'files', align: 'right' },
      { header: 'statements' },
      { header: 'branches', align: 'right' },
      { header: 'functions', align: 'right' },
      { header: 'covered', align: 'right' },
    ],
    wsRows,
  ));

  const all = totals(cov.files.values());
  console.log(
    `\n  ${dim('overall')}  ${bar(percent(all.statements) / 100, 28)} ` +
    `${pctCell(all.statements)} statements  ${pctCell(all.branches)} branches  ` +
    `${pctCell(all.functions)} functions  ${dim(`${cov.files.size} files`)}`,
  );

  // Least covered first, and among the equally uncovered the biggest — a
  // 200-statement file nobody tests is not the same finding as a 6-line one.
  const ranked = [...cov.files.values()]
    .filter((f) => f.statements.total >= 5)
    .sort((a, b) =>
      percent(a.statements) - percent(b.statements) || b.statements.total - a.statements.total);

  console.log(heading(`Least covered (${Math.min(worst, ranked.length)} of ${ranked.length})`));
  console.log(table(
    [
      { header: 'file' },
      { header: 'statements' },
      { header: 'covered', align: 'right' },
      { header: 'branches', align: 'right' },
    ],
    ranked.slice(0, worst).map((f) => [
      f.path,
      `${bar(percent(f.statements) / 100, 14)} ${pctCell(f.statements)}`,
      dim(`${f.statements.covered}/${f.statements.total}`),
      pctCell(f.branches),
    ]),
  ));

  const untouched = [...cov.files.values()].filter((f) => f.statements.covered === 0);
  if (untouched.length > 0) {
    console.log(`\n  ${grade(`${untouched.length} files no test ever enters`, 1, 1, 1)}`);
  }

  for (const ws of cov.missing) {
    console.log(dim(`\n  no report at ${reportPath(ws)} — did ${ws.dir}'s suite run with --coverage?`));
  }

  if (flags.has('json')) {
    writeJson(flags.str('json', 'reports/coverage.json'), {
      generatedAt: new Date().toISOString(),
      overall: all,
      workspaces: WORKSPACES.map((ws) => ({
        dir: ws.dir,
        files: (byWorkspace.get(ws.dir) ?? []).length,
        ...totals(byWorkspace.get(ws.dir) ?? []),
      })),
      files: [...cov.files.values()].map((f) => ({
        path: f.path,
        statements: f.statements,
        branches: f.branches,
        functions: f.functions,
      })),
    });
  }

}

// Run when invoked directly, which is how make and npx call it.
if (process.argv[1]?.endsWith('report-coverage.ts')) main();
