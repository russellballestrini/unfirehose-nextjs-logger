/**
 * Copy-paste, found by shape rather than by text.
 *
 * Two blocks that differ only in their variable names are the same block,
 * and a text diff will never say so. This tokenises with the TypeScript
 * scanner and replaces every identifier, string and number with a
 * placeholder, so `const rows = db.prepare(A).all()` and
 * `const items = db.prepare(B).all()` hash identically. What survives is
 * structure: the sequence of operations, which is the thing worth extracting.
 *
 * Clones are found as runs of matching tokens, then merged so a 300-token
 * duplicate is reported once rather than as 250 overlapping windows.
 */

import ts from 'typescript';
import fs from 'fs';
import { rel } from './workspaces.ts';

/** Shorter than this and a match is a coincidence, not a copy. */
export const MIN_TOKENS = 60;

interface Token {
  /** The normalised form: keywords and punctuation kept, names blanked. */
  shape: string;
  line: number;
}

/** Trivia carries no structure, and neither do the names we chose. */
export function tokenise(source: string, fileName = 'x.tsx'): Token[] {
  const sf = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const scanner = ts.createScanner(ts.ScriptTarget.Latest, true, ts.LanguageVariant.JSX, source);
  const out: Token[] = [];

  while (true) {
    const kind = scanner.scan();
    if (kind === ts.SyntaxKind.EndOfFileToken) break;
    if (kind === ts.SyntaxKind.NewLineTrivia || kind === ts.SyntaxKind.WhitespaceTrivia) continue;
    const line = sf.getLineAndCharacterOfPosition(scanner.getTokenStart()).line + 1;

    let shape: string;
    if (kind === ts.SyntaxKind.Identifier) shape = 'ID';
    else if (kind === ts.SyntaxKind.StringLiteral || kind === ts.SyntaxKind.NoSubstitutionTemplateLiteral) shape = 'STR';
    else if (kind === ts.SyntaxKind.NumericLiteral) shape = 'NUM';
    else shape = String(kind);

    out.push({ shape, line });
  }
  return out;
}

interface CloneInstance {
  path: string;
  startLine: number;
  endLine: number;
}

interface Clone {
  tokens: number;
  instances: CloneInstance[];
  /** Tokens a reader would stop having to read if this were extracted once. */
  redundant: number;
}

interface Indexed {
  path: string;
  tokens: Token[];
}

/** Rolling hash over a window of shapes — cheap, and collisions are re-checked. */
function windowKeys(tokens: Token[], size: number): string[] {
  const keys: string[] = [];
  for (let i = 0; i + size <= tokens.length; i += 1) {
    keys.push(tokens.slice(i, i + size).map((t) => t.shape).join(','));
  }
  return keys;
}

/**
 * Every clone across a set of files.
 *
 * `minTokens` is the window we look for; anything longer is grown from a
 * match rather than searched for separately.
 */
export function findClones(files: string[], minTokens = MIN_TOKENS): Clone[] {
  const indexed: Indexed[] = files
    .map((path) => ({ path: rel(path), tokens: tokenise(fs.readFileSync(path, 'utf8'), path) }))
    .filter((f) => f.tokens.length >= minTokens);

  // Window → every place it occurs.
  const seen = new Map<string, { file: number; at: number }[]>();
  indexed.forEach((file, fileIndex) => {
    windowKeys(file.tokens, minTokens).forEach((key, at) => {
      const hits = seen.get(key);
      if (hits) hits.push({ file: fileIndex, at });
      else seen.set(key, [{ file: fileIndex, at }]);
    });
  });

  // Grow each repeated window as far as every instance keeps matching, then
  // record the extent so overlapping windows inside it can be skipped.
  const covered = indexed.map(() => new Set<number>());
  const clones: Clone[] = [];

  for (const hits of seen.values()) {
    if (hits.length < 2) continue;
    if (hits.some((h) => covered[h.file].has(h.at))) continue;

    // A repetitive structure — a long table of same-shaped rows — matches
    // itself at every offset. Those shifted windows are one pattern, not N
    // copies, so keep only occurrences that do not overlap one already kept.
    const ordered = [...hits].sort((a, b) => a.file - b.file || a.at - b.at);
    const distinct: typeof hits = [];
    for (const hit of ordered) {
      const last = distinct[distinct.length - 1];
      if (last && last.file === hit.file && hit.at < last.at + minTokens) continue;
      distinct.push(hit);
    }
    if (distinct.length < 2) continue;

    let length = minTokens;
    const shapeAt = (h: { file: number; at: number }, offset: number) =>
      indexed[h.file].tokens[h.at + offset]?.shape;
    const gap = Math.min(
      ...distinct.map((h, i) => {
        const next = distinct[i + 1];
        return next && next.file === h.file ? next.at - h.at : Infinity;
      }),
    );
    while (length < gap) {
      const next = shapeAt(distinct[0], length);
      if (next === undefined) break;
      if (!distinct.every((h) => shapeAt(h, length) === next)) break;
      length += 1;
    }

    for (const hit of distinct) {
      for (let i = 0; i < length; i += 1) covered[hit.file].add(hit.at + i);
    }

    // A run of back-to-back matches inside one file is a table, not a
    // copy. Fifty currency rows or sixteen harness rows are all the same
    // shape by design — that is what a table IS — and tiling a 60-token
    // window across them reports eighteen copies of something nobody
    // duplicated. Copy-paste is separated by other code; periodic
    // structure is not, so a run collapses to the one place it lives.
    // Group back-to-back matches in one file into runs, then keep one
    // member of any run long enough to be periodic. Three or more
    // instances tiling a region is a table — fifty currency rows share a
    // shape because that is what a table IS — while two adjacent copies
    // is somebody pasting a function and editing it, which is exactly
    // what we want reported.
    const runs: (typeof distinct)[] = [];
    for (const hit of distinct) {
      const run = runs[runs.length - 1];
      const prev = run?.[run.length - 1];
      if (prev && prev.file === hit.file && hit.at - prev.at <= length * 2) run.push(hit);
      else runs.push([hit]);
    }
    const collapsed = runs.flatMap((run) => (run.length >= 3 ? [run[0]] : run));
    if (collapsed.length < 2) continue;

    const instances = collapsed.map((h) => ({
      path: indexed[h.file].path,
      startLine: indexed[h.file].tokens[h.at].line,
      endLine: indexed[h.file].tokens[Math.min(h.at + length - 1, indexed[h.file].tokens.length - 1)].line,
    }));

    clones.push({ tokens: length, instances, redundant: length * (instances.length - 1) });
  }

  return clones.sort((a, b) => b.redundant - a.redundant);
}
