/**
 * Cyclomatic complexity — `make cc`.
 *
 * How many paths run through each function. It needs no tests and no
 * coverage: it reads the source, so it works on code nobody has tested yet,
 * which is exactly the code worth looking at.
 *
 *   make cc                        everything, worst first
 *   make cc ARGS="--min 15"        only what is genuinely branchy
 *   make cc ARGS="--dir apps/web"
 *   npx tsx scripts/quality/report-cc.ts --json reports/cc.json
 */

import { WORKSPACES, sourcesOf, workspaceOf, ROOT } from './workspaces.ts';
import { complexityOfAll, bandOf, type FunctionComplexity } from './complexity.ts';
import { args, table, heading, dim, bold, grade, paint, writeJson } from './render.ts';
import path from 'path';

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
  const top = flags.num('top', 25);
  const min = flags.num('min', 0);
  const only = flags.str('dir', '');

  const workspaces = WORKSPACES.filter((ws) => !only || ws.dir.startsWith(only));
  const files = workspaces.flatMap((ws) => sourcesOf(ws));
  const functions = complexityOfAll(files);

  const ccCell = (n: number) => grade(String(n), n, 11, 21);

  console.log(heading('Cyclomatic complexity by workspace'));

  const rows = workspaces.map((ws) => {
    const mine = functions.filter((f) => workspaceOf(f.file)?.dir === ws.dir);
    if (mine.length === 0) return [ws.dir, dim('—'), '', '', '', ''];
    const total = mine.reduce((sum, f) => sum + f.complexity, 0);
    const over10 = mine.filter((f) => f.complexity > 10).length;
    const over20 = mine.filter((f) => f.complexity > 20).length;
    return [
      ws.dir,
      String(new Set(mine.map((f) => f.file)).size),
      String(mine.length),
      (total / mine.length).toFixed(1),
      String(Math.max(...mine.map((f) => f.complexity))),
      `${grade(String(over10), over10, 1, 25)} ${dim('/')} ${grade(String(over20), over20, 1, 10)}`,
    ];
  });

  console.log(table(
    [
      { header: 'workspace' },
      { header: 'files', align: 'right' },
      { header: 'functions', align: 'right' },
      { header: 'mean', align: 'right' },
      { header: 'max', align: 'right' },
      { header: '>10 / >20', align: 'right' },
    ],
    rows,
  ));

  const ranked = functions
    .filter((f) => f.complexity >= min)
    .sort((a, b) => b.complexity - a.complexity || b.lines - a.lines);

  console.log(heading(`Branchiest functions (${Math.min(top, ranked.length)} of ${ranked.length})`));
  console.log(table(
    [
      { header: 'cc', align: 'right' },
      { header: 'lines', align: 'right' },
      { header: 'band' },
      { header: 'function' },
      { header: 'where' },
    ],
    ranked.slice(0, top).map((f) => [
      ccCell(f.complexity),
      dim(String(f.lines)),
      bandOf(f.complexity),
      f.name,
      dim(`${f.path}:${f.line}`),
    ]),
  ));

  const bands = { simple: 0, watch: 0, complex: 0, unmaintainable: 0 };
  for (const f of functions) bands[bandOf(f.complexity)] += 1;

  console.log(
    `\n  ${bold('bands')}  ` +
    `${paint(String(bands.simple), 'green')} simple ${dim('(≤10)')}  ` +
    `${paint(String(bands.watch), 'yellow')} watch ${dim('(11–20)')}  ` +
    `${paint(String(bands.complex), 'red')} complex ${dim('(21–50)')}  ` +
    `${paint(String(bands.unmaintainable), 'magenta')} unmaintainable ${dim('(>50)')}`,
  );

  if (flags.has('json')) {
    writeJson(flags.str('json', 'reports/cc.json'), {
      generatedAt: new Date().toISOString(),
      bands,
      functions: ranked.map((f: FunctionComplexity) => ({
        path: f.path, name: f.name, line: f.line, complexity: f.complexity, lines: f.lines,
      })),
    });
  }

}

// Run when invoked directly, which is how make and npx call it.
if (process.argv[1]?.endsWith('report-cc.ts')) main();
