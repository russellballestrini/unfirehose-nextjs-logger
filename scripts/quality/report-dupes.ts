/**
 * Copy-paste we are still carrying — `make dupes`.
 *
 * Matched on structure, not text, so renamed variables do not hide a clone.
 * Ranked by what extraction would actually save: a 300-token block appearing
 * twice is worth more than a 60-token block appearing three times.
 *
 *   make dupes
 *   make dupes ARGS="--min 100"        only substantial clones
 *   make dupes ARGS="--dir apps/web"
 */

import path from 'path';
import { ROOT, WORKSPACES, sourcesOf } from './workspaces.ts';
import { findClones, MIN_TOKENS } from './duplication.ts';
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
  const min = flags.num('min', MIN_TOKENS);
  const top = flags.num('top', 20);
  const only = flags.str('dir', '');

  const files = WORKSPACES
    .filter((ws) => !only || ws.dir.startsWith(only))
    .flatMap((ws) => sourcesOf(ws));

  const clones = findClones(files, min);
  const withinFile = clones.filter((c) => new Set(c.instances.map((i) => i.path)).size === 1);
  const acrossFiles = clones.filter((c) => new Set(c.instances.map((i) => i.path)).size > 1);

  // One row per instance reads better than a newline stuffed into a cell.
  const flatten = (list: typeof clones) =>
    list.slice(0, top).flatMap((c, index) =>
      c.instances.map((i, j) => [
        j === 0 ? String(c.tokens) : '',
        j === 0 ? String(c.instances.length) : '',
        j === 0 ? grade(String(c.redundant), c.redundant, 100, 400) : '',
        dim(`${i.path}:${i.startLine}-${i.endLine}`),
        j === 0 ? dim(`#${index + 1}`) : '',
      ]),
    );

  const render = (title: string, list: typeof clones) => {
    if (list.length === 0) return;
    console.log(heading(`${title} (${Math.min(top, list.length)} of ${list.length})`));
    console.log(table(
      [
        { header: 'tokens', align: 'right' },
        { header: 'copies', align: 'right' },
        { header: 'saved', align: 'right' },
        { header: 'where' },
        { header: '' },
      ],
      flatten(list),
    ));
  };

  render('Duplicated across files', acrossFiles);
  render('Duplicated within one file', withinFile);

  const saved = clones.reduce((sum, c) => sum + c.redundant, 0);
  console.log(
    `\n  ${bold('redundant')} ${saved} tokens across ${clones.length} clones ` +
    `${dim(`· ${files.length} files · windows of ${min}+ tokens`)}`,
  );

  if (flags.has('json')) {
    writeJson(path.resolve(ROOT, flags.str('json', 'reports/dupes.json')), {
      generatedAt: new Date().toISOString(),
      minTokens: min,
      redundantTokens: saved,
      clones,
    });
  }

  // A ceiling, for CI. Every duplicate this repo has grown was eventually
  // found to have drifted — one copy fixed, the other not — so the number
  // worth watching is whether it is growing at all.
  checkBudget('redundant tokens', saved, flags);

}

// Run when invoked directly, which is how make and npx call it.
if (process.argv[1]?.endsWith('report-dupes.ts')) main();
