/**
 * Code nothing reaches — `make orphans`.
 *
 * Dead files and dead exports cost more than the disk they sit on: they get
 * read during a search, updated during a refactor, and reviewed during an
 * audit, all for a path that never executes. This walks our import graph out
 * from every real entry point — Next.js route conventions, package export
 * maps, the worker's main, our scripts — and reports what is left over.
 *
 * Three findings, in descending confidence:
 *
 *   orphaned      nothing imports it and it is no entry point
 *   test-only     alive solely because its own test imports it
 *   unused export a name offered to nobody
 *
 * A specifier we cannot resolve is printed rather than ignored, because an
 * unresolved import is exactly how a live file gets called dead.
 *
 *   make orphans
 *   make orphans ARGS="--exports"     also list unused exports
 *   npx tsx scripts/quality/report-orphans.ts --json reports/orphans.json
 */

import fs from 'fs';
import path from 'path';
import { ROOT, WORKSPACES, walk, isTest, isSource, rel } from './workspaces.ts';
import { importsOf, exportsOf, publicEntries, deadPrivateFunctions } from './imports.ts';
import { args, table, heading, dim, bold, grade, writeJson } from './render.ts';

const flags = args();
const showExports = flags.has('exports') || flags.has('all');

/** Next.js runs these by name; nothing imports them. */
const NEXT_CONVENTIONS = new Set([
  'page', 'layout', 'route', 'loading', 'error', 'not-found', 'template',
  'default', 'global-error', 'sitemap', 'robots', 'manifest',
  'opengraph-image', 'twitter-image', 'icon', 'apple-icon',
]);

/** Entry points by path, relative to our repo root. */
const ENTRY_FILES = [
  'apps/web/src/middleware.ts',
  'apps/web/src/instrumentation.ts',
  'apps/worker/src/main.ts',
  'packages/router/src/cli.ts',
];

/**
 * Anything our Makefile runs is an entry point, and our Makefile is the one
 * authority on that — hard-coding a second list here would drift from it on
 * the first target anyone adds.
 */
function makefileEntries(): Set<string> {
  const makefile = fs.readFileSync(path.join(ROOT, 'Makefile'), 'utf8');
  return new Set(makefile.match(/[\w./-]+\.(?:ts|tsx|mjs|py)/g) ?? []);
}
const RUN_BY_MAKE = makefileEntries();

function isEntry(file: string): boolean {
  const relative = rel(file);
  if (ENTRY_FILES.includes(relative)) return true;
  if (RUN_BY_MAKE.has(relative)) return true;
  // A file sitting directly in a scripts directory is meant to be run. One
  // nested deeper is a library and has to earn its keep like any other.
  if (path.basename(path.dirname(file)) === 'scripts') return true;
  // An extension is copied into another program's plugin directory and run
  // by that program. Nothing here imports it, and nothing should.
  if (relative.includes('/extensions/')) return true;
  if (/\.(config|d)\.(ts|tsx)$/.test(relative)) return true;
  const base = path.basename(file).replace(/\.(ts|tsx)$/, '');
  return relative.includes('/app/') && NEXT_CONVENTIONS.has(base);
}

/**
 * Fixtures, helpers and vitest setup exist for the suites and are reached
 * only from them by design. Calling them dead would bury the finding that
 * matters: production code kept alive by nothing but its own test.
 */
function isTestSupport(file: string): boolean {
  const relative = rel(file);
  return /(^|\/)(test|tests|__tests__|__mocks__|fixtures)\//.test(relative);
}

// Every file we own, tests included: a test is not an orphan, but it does
// keep what it imports alive, and that distinction is the report.
const all = [...new Set(WORKSPACES.flatMap((ws) => walk(path.join(ROOT, ws.dir))))]
  .filter((f) => isSource(f) || isTest(f));

const graph = new Map<string, ReturnType<typeof importsOf>>();
for (const file of all) graph.set(file, importsOf(file));

/** Who imports each file, split by whether the importer is a test. */
const importedBy = new Map<string, { source: string[]; test: string[] }>();
for (const file of all) {
  for (const target of graph.get(file)!.targets) {
    const entry = importedBy.get(target) ?? { source: [], test: [] };
    (isTest(file) ? entry.test : entry.source).push(file);
    importedBy.set(target, entry);
  }
}

const published = new Set(publicEntries());

const classify = (file: string) => {
  const seen = importedBy.get(file) ?? { source: [], test: [] };
  if (published.has(file)) return 'published';
  if (isEntry(file) || isTestSupport(file)) return 'entry';
  if (seen.source.length > 0) return 'used';
  if (seen.test.length > 0) return 'test-only';
  return 'orphaned';
};

const sources = all.filter(isSource);
const orphaned = sources.filter((f) => classify(f) === 'orphaned');
const testOnly = sources.filter((f) => classify(f) === 'test-only');

const linesOf = (file: string) => fs.readFileSync(file, 'utf8').split('\n').length;

/** Name the first couple of tests and count the rest — the table has to fit. */
const keptBy = (files: string[]) => {
  const names = files.map(rel);
  return names.length <= 2 ? names.join(', ') : `${names.slice(0, 2).join(', ')} +${names.length - 2} more`;
};

console.log(heading('Reachability by workspace'));
console.log(table(
  [
    { header: 'workspace' },
    { header: 'files', align: 'right' },
    { header: 'used', align: 'right' },
    { header: 'published', align: 'right' },
    { header: 'entry', align: 'right' },
    { header: 'test-only', align: 'right' },
    { header: 'orphaned', align: 'right' },
  ],
  WORKSPACES.map((ws) => {
    const mine = sources.filter((f) => rel(f).startsWith(`${ws.dir}/`));
    const count = (kind: string) => mine.filter((f) => classify(f) === kind).length;
    const dead = count('orphaned');
    return [
      ws.dir,
      String(mine.length),
      String(count('used')),
      String(count('published')),
      String(count('entry')),
      grade(String(count('test-only')), count('test-only'), 1, 10),
      grade(String(dead), dead, 1, 10),
    ];
  }),
));

if (orphaned.length > 0) {
  console.log(heading(`Orphaned files (${orphaned.length})`));
  console.log(table(
    [{ header: 'lines', align: 'right' }, { header: 'file' }, { header: 'exports', align: 'right' }],
    orphaned
      .map((f) => ({ f, lines: linesOf(f), exports: exportsOf(f).length }))
      .sort((a, b) => b.lines - a.lines)
      .map(({ f, lines, exports }) => [String(lines), rel(f), dim(String(exports))]),
  ));
  console.log(dim(`\n  ${orphaned.reduce((n, f) => n + linesOf(f), 0)} lines nothing imports.`));
}

if (testOnly.length > 0) {
  console.log(heading(`Alive only through their own tests (${testOnly.length})`));
  console.log(table(
    [{ header: 'lines', align: 'right' }, { header: 'file' }, { header: 'kept by' }],
    testOnly.map((f) => [
      String(linesOf(f)),
      rel(f),
      dim(keptBy(importedBy.get(f)?.test ?? [])),
    ]),
  ));
}

/** Names offered to nobody. `export *` re-exports keep a whole file's surface. */
const starred = new Set(all.flatMap((f) => graph.get(f)!.starReexports));
const unusedExports: { path: string; name: string; line: number; kind: string }[] = [];
for (const file of sources) {
  if (published.has(file) || isEntry(file) || isTestSupport(file) || starred.has(file)) continue;
  const taken = new Set<string>();
  for (const importer of [...(importedBy.get(file)?.source ?? []), ...(importedBy.get(file)?.test ?? [])]) {
    for (const name of graph.get(importer)!.names.get(file) ?? []) taken.add(name);
  }
  if (taken.has('*')) continue;
  for (const sym of exportsOf(file)) {
    if (!taken.has(sym.name)) unusedExports.push({ path: rel(file), ...sym });
  }
}

if (showExports && unusedExports.length > 0) {
  console.log(heading(`Exported but never imported (${unusedExports.length})`));
  console.log(table(
    [{ header: 'kind' }, { header: 'name' }, { header: 'where' }],
    unusedExports
      .sort((a, b) => a.path.localeCompare(b.path) || a.line - b.line)
      .map((s) => [dim(s.kind), s.name, dim(`${s.path}:${s.line}`)]),
  ));
} else if (unusedExports.length > 0) {
  console.log(dim(`\n  ${unusedExports.length} exported names nothing imports — \`make orphans ARGS=--exports\` to list them.`));
}

// Dead code inside a live file. Export-level analysis cannot see this: the
// file is reached, so nothing flags the function inside it that is not.
const dead = sources
  .flatMap((file) => deadPrivateFunctions(file).map((fn) => ({ path: rel(file), ...fn })))
  .sort((a, b) => (b.endLine - b.line) - (a.endLine - a.line));

if (dead.length > 0) {
  const lines = dead.reduce((n, d) => n + (d.endLine - d.line + 1), 0);
  console.log(heading(`Declared, never called, never exported (${dead.length})`));
  console.log(table(
    [{ header: 'lines', align: 'right' }, { header: 'function' }, { header: 'where' }],
    dead.slice(0, 30).map((d) => [
      String(d.endLine - d.line + 1), d.name, dim(`${d.path}:${d.line}`),
    ]),
  ));
  console.log(dim(`\n  ${lines} lines nothing calls.`));
}

const unresolved = new Map<string, string[]>();
for (const file of all) {
  for (const spec of graph.get(file)!.unresolved) {
    unresolved.set(spec, [...(unresolved.get(spec) ?? []), rel(file)]);
  }
}
if (unresolved.size > 0) {
  console.log(heading(`Unresolved specifiers (${unresolved.size})`));
  console.log(dim('  A file reached only through one of these would be called dead here.'));
  console.log(table(
    [{ header: 'specifier' }, { header: 'imported by' }],
    [...unresolved.entries()].map(([spec, files]) => [spec, dim(files.slice(0, 3).join(', '))]),
  ));
}

console.log(
  `\n  ${bold('reachable')} ${sources.length - orphaned.length - testOnly.length}` +
  ` ${dim('of')} ${sources.length} files  ${dim('·')} ` +
  `${grade(`${orphaned.length} orphaned`, orphaned.length, 1, 10)} ${dim('·')} ` +
  `${grade(`${testOnly.length} test-only`, testOnly.length, 1, 10)}`,
);

if (flags.has('json')) {
  writeJson(path.resolve(ROOT, flags.str('json', 'reports/orphans.json')), {
    generatedAt: new Date().toISOString(),
    files: sources.length,
    orphaned: orphaned.map((f) => ({ path: rel(f), lines: linesOf(f) })),
    testOnly: testOnly.map((f) => ({ path: rel(f), lines: linesOf(f) })),
    unusedExports,
    deadFunctions: dead,
    unresolved: [...unresolved.entries()].map(([specifier, files]) => ({ specifier, files })),
  });
}

if (flags.has('fail-on-orphans') && orphaned.length > 0) process.exit(1);
