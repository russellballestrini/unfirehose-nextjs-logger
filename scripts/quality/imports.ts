/**
 * Who imports whom, resolved to files on disk.
 *
 * Everything an orphan report claims rests on this: a file is dead only if
 * nothing reaches it, so a specifier we fail to resolve becomes a file we
 * wrongly call dead. Resolution therefore handles every form this monorepo
 * actually uses — relative paths with and without extensions, directory
 * `index` files, the `@/` alias in apps/web, and the published
 * `@unturf/*` names that point at sibling workspaces — and anything still
 * unresolved is reported rather than silently dropped.
 */

import fs from 'fs';
import path from 'path';
import ts from 'typescript';
import { ROOT } from './workspaces.ts';

/** Package name → directory, for the workspaces that import each other. */
const PACKAGE_DIRS: Record<string, string> = {
  '@unturf/unfirehose': 'packages/core',
  '@unturf/unfirehose-ui': 'packages/ui',
  '@unturf/unfirehose-schema': 'packages/schema',
  '@unturf/unfirehose-router': 'packages/router',
  '@unturf/unfirehose-config': 'packages/config',
};

/**
 * A package's `exports` map is its published surface — the one authority on
 * what `@unturf/unfirehose/db/schema` means and, for the orphan report, on
 * which files are reachable from outside this repo entirely.
 */
function exportMap(dir: string): Record<string, string> {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, dir, 'package.json'), 'utf8'));
    const raw = pkg.exports;
    if (!raw || typeof raw !== 'object') return {};
    const out: Record<string, string> = {};
    for (const [key, value] of Object.entries(raw)) {
      const target = typeof value === 'string'
        ? value
        : (value as Record<string, string>)?.import ?? (value as Record<string, string>)?.default;
      if (typeof target === 'string') out[key] = target;
    }
    return out;
  } catch {
    return {};
  }
}

const EXPORT_MAPS = new Map<string, Record<string, string>>(
  Object.values(PACKAGE_DIRS).map((dir) => [dir, exportMap(dir)]),
);

/** Absolute paths every package publishes — never orphans, whoever imports them. */
export function publicEntries(): string[] {
  const out: string[] = [];
  for (const [dir, map] of EXPORT_MAPS) {
    for (const target of Object.values(map)) {
      const resolved = resolveFile(path.resolve(ROOT, dir, target));
      if (resolved) out.push(resolved);
    }
  }
  return out;
}

const EXTENSIONS = ['.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.d.ts'];

/** A specifier that could name a file of ours, so failing to resolve it matters. */
function isOurs(specifier: string): boolean {
  return (
    specifier.startsWith('.') ||
    specifier.startsWith('@/') ||
    Object.keys(PACKAGE_DIRS).some((pkg) => specifier === pkg || specifier.startsWith(`${pkg}/`))
  );
}

interface FileImports {
  /** Absolute paths this file pulls in. */
  targets: string[];
  /** Names taken from each target: `{ resolved path → names }`. */
  names: Map<string, Set<string>>;
  /** Specifiers we could not turn into a file — node_modules, or a gap. */
  unresolved: string[];
  /** `export * from './x'` keeps everything x exports alive. */
  starReexports: string[];
}

/** Try a specifier as a file, as a file with an extension, as a directory. */
function resolveFile(candidate: string): string | undefined {
  if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) return candidate;
  for (const ext of EXTENSIONS) {
    if (fs.existsSync(candidate + ext)) return candidate + ext;
  }
  // `./foo.js` in ESM TypeScript means `./foo.ts` on disk.
  const swapped = candidate.replace(/\.js$/, '.ts').replace(/\.jsx$/, '.tsx');
  if (swapped !== candidate && fs.existsSync(swapped)) return swapped;
  for (const ext of EXTENSIONS) {
    const index = path.join(candidate, `index${ext}`);
    if (fs.existsSync(index)) return index;
  }
  return undefined;
}

/** A specifier as written, from a file, to an absolute path or nothing. */
export function resolveSpecifier(specifier: string, from: string): string | undefined {
  if (specifier.startsWith('.')) {
    return resolveFile(path.resolve(path.dirname(from), specifier));
  }
  if (specifier.startsWith('@/')) {
    return resolveFile(path.join(ROOT, 'apps/web/src', specifier.slice(2)));
  }
  for (const [pkg, dir] of Object.entries(PACKAGE_DIRS)) {
    if (specifier !== pkg && !specifier.startsWith(`${pkg}/`)) continue;
    const subpath = specifier === pkg ? '.' : `./${specifier.slice(pkg.length + 1)}`;
    const mapped = EXPORT_MAPS.get(dir)?.[subpath];
    if (mapped) return resolveFile(path.resolve(ROOT, dir, mapped));
    // Not in the map: still resolve it, so an import that only works because
    // we are in one tree shows up as a file in use rather than as a gap.
    return resolveFile(path.join(ROOT, dir, subpath));
  }
  return undefined;
}

const namesFromClause = (clause: ts.ImportClause | undefined): string[] => {
  if (!clause) return [];
  const names: string[] = [];
  if (clause.name) names.push('default');
  const bindings = clause.namedBindings;
  if (bindings && ts.isNamespaceImport(bindings)) names.push('*');
  if (bindings && ts.isNamedImports(bindings)) {
    for (const el of bindings.elements) names.push((el.propertyName ?? el.name).text);
  }
  return names;
};

/** Everything one file reaches for. */
export function importsOf(file: string): FileImports {
  const sf = ts.createSourceFile(
    file, fs.readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX,
  );
  const targets = new Set<string>();
  const names = new Map<string, Set<string>>();
  const unresolved: string[] = [];
  const starReexports: string[] = [];

  const record = (specifier: string, taken: string[]) => {
    const resolved = resolveSpecifier(specifier, file);
    if (!resolved) {
      if (isOurs(specifier)) unresolved.push(specifier);
      return undefined;
    }
    targets.add(resolved);
    const set = names.get(resolved) ?? new Set<string>();
    for (const name of taken) set.add(name);
    names.set(resolved, set);
    return resolved;
  };

  const visit = (node: ts.Node) => {
    if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
      record(node.moduleSpecifier.text, namesFromClause(node.importClause));
    } else if (ts.isExportDeclaration(node) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) {
      const clause = node.exportClause;
      if (clause && ts.isNamedExports(clause)) {
        record(node.moduleSpecifier.text, clause.elements.map((el) => (el.propertyName ?? el.name).text));
      } else {
        // `export * from` — every name over there stays reachable.
        const resolved = record(node.moduleSpecifier.text, ['*']);
        if (resolved) starReexports.push(resolved);
      }
    } else if (
      ts.isCallExpression(node) &&
      (node.expression.kind === ts.SyntaxKind.ImportKeyword ||
        (ts.isIdentifier(node.expression) && node.expression.text === 'require')) &&
      node.arguments.length > 0 &&
      ts.isStringLiteral(node.arguments[0])
    ) {
      record(node.arguments[0].text, ['*']);
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);

  return { targets: [...targets], names, unresolved, starReexports };
}

interface ExportedSymbol {
  name: string;
  line: number;
  kind: string;
}

/** Names a file offers to the rest of our tree. */
export function exportsOf(file: string): ExportedSymbol[] {
  const sf = ts.createSourceFile(
    file, fs.readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX,
  );
  const out: ExportedSymbol[] = [];
  const lineOf = (pos: number) => sf.getLineAndCharacterOfPosition(pos).line + 1;
  const exported = (node: ts.Node) =>
    ts.canHaveModifiers(node) &&
    ts.getModifiers(node)?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword);

  for (const node of sf.statements) {
    if (ts.isExportAssignment(node)) {
      out.push({ name: 'default', line: lineOf(node.getStart(sf)), kind: 'default' });
      continue;
    }
    if (ts.isExportDeclaration(node) && !node.moduleSpecifier && node.exportClause && ts.isNamedExports(node.exportClause)) {
      for (const el of node.exportClause.elements) {
        out.push({ name: el.name.text, line: lineOf(el.getStart(sf)), kind: 'named' });
      }
      continue;
    }
    if (!exported(node)) continue;
    const isDefault = ts.getModifiers(node)?.some((m) => m.kind === ts.SyntaxKind.DefaultKeyword);
    const push = (name: string, kind: string) =>
      out.push({ name: isDefault ? 'default' : name, line: lineOf(node.getStart(sf)), kind });

    if (ts.isVariableStatement(node)) {
      for (const decl of node.declarationList.declarations) {
        if (ts.isIdentifier(decl.name)) push(decl.name.text, 'const');
        // A destructured export offers each bound name.
        else decl.name.forEachChild((el) => {
          if (ts.isBindingElement(el) && ts.isIdentifier(el.name)) push(el.name.text, 'const');
        });
      }
    } else if (ts.isFunctionDeclaration(node)) push(node.name?.text ?? 'default', 'function');
    else if (ts.isClassDeclaration(node)) push(node.name?.text ?? 'default', 'class');
    else if (ts.isInterfaceDeclaration(node)) push(node.name.text, 'interface');
    else if (ts.isTypeAliasDeclaration(node)) push(node.name.text, 'type');
    else if (ts.isEnumDeclaration(node)) push(node.name.text, 'enum');
  }

  return out;
}

export interface DeadFunction {
  name: string;
  line: number;
  endLine: number;
}

/**
 * Functions a file declares, does not export, and never calls.
 *
 * Export-level analysis cannot see these: the file is reachable, so nothing
 * flags the sixty lines inside it that nothing reaches. Found the first one
 * by hand — a canonical-form converter in db/ingest.ts with no callers — and
 * looking for the rest by hand across two hundred files is how they stay.
 *
 * Only top-level declarations count. A nested helper is scoped to its
 * parent, and a method could be called through an object we cannot follow.
 */
export function deadPrivateFunctions(file: string): DeadFunction[] {
  const text = fs.readFileSync(file, 'utf8');
  const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const lineOf = (pos: number) => sf.getLineAndCharacterOfPosition(pos).line + 1;

  const declared = new Map<string, { line: number; endLine: number }>();
  for (const node of sf.statements) {
    const exported = ts.canHaveModifiers(node) &&
      ts.getModifiers(node)?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword);
    if (exported) continue;

    if (ts.isFunctionDeclaration(node) && node.name) {
      declared.set(node.name.text, {
        line: lineOf(node.getStart(sf)), endLine: lineOf(node.getEnd()),
      });
    } else if (ts.isVariableStatement(node)) {
      for (const decl of node.declarationList.declarations) {
        if (!ts.isIdentifier(decl.name) || !decl.initializer) continue;
        if (!ts.isArrowFunction(decl.initializer) && !ts.isFunctionExpression(decl.initializer)) continue;
        declared.set(decl.name.text, {
          line: lineOf(node.getStart(sf)), endLine: lineOf(node.getEnd()),
        });
      }
    }
  }
  if (declared.size === 0) return [];

  // Count every identifier that is not the declaration itself.
  const used = new Set<string>();
  const visit = (node: ts.Node) => {
    if (ts.isIdentifier(node)) {
      const parent = node.parent;
      const isOwnName =
        (ts.isFunctionDeclaration(parent) || ts.isVariableDeclaration(parent)) && parent.name === node;
      if (!isOwnName) used.add(node.text);
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);

  return [...declared.entries()]
    .filter(([name]) => !used.has(name))
    .map(([name, where]) => ({ name, ...where }))
    .sort((a, b) => a.line - b.line);
}
