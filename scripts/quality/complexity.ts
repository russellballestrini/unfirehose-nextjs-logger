/**
 * McCabe cyclomatic complexity, read off our TypeScript AST.
 *
 * One decision point, one path. A function starts at 1 and gains a point for
 * every branch a reader has to hold in their head: `if`, each loop, each
 * `case` that does something, each `catch`, each ternary, and each `&&`,
 * `||` or `??` — those short-circuit, so they are branches too.
 *
 * A nested function keeps its own score rather than inflating its parent's;
 * that is what makes the number mean "paths through this body". Code sitting
 * at module level is scored as a function called `<module>`, because a file
 * that branches on import is doing work like any other.
 *
 * We use the compiler already in this repo instead of adding a dependency
 * that would have to be kept honest against the TypeScript we actually write.
 */

import ts from 'typescript';
import fs from 'fs';
import { rel } from './workspaces.ts';

export interface FunctionComplexity {
  file: string;
  /** Relative to our repo root — what a report prints. */
  path: string;
  name: string;
  line: number;
  endLine: number;
  complexity: number;
  /** Physical lines the body spans. */
  lines: number;
}

type FunctionNode =
  | ts.FunctionDeclaration
  | ts.FunctionExpression
  | ts.ArrowFunction
  | ts.MethodDeclaration
  | ts.ConstructorDeclaration
  | ts.GetAccessorDeclaration
  | ts.SetAccessorDeclaration;

function isFunctionNode(node: ts.Node): node is FunctionNode {
  return (
    ts.isFunctionDeclaration(node) ||
    ts.isFunctionExpression(node) ||
    ts.isArrowFunction(node) ||
    ts.isMethodDeclaration(node) ||
    ts.isConstructorDeclaration(node) ||
    ts.isGetAccessor(node) ||
    ts.isSetAccessor(node)
  );
}

/**
 * What kind of decision a node is, or null if it is not one.
 *
 * Named rather than merely counted, because "10,371" is a number you cannot
 * act on and "2,139 ifs, 1,355 ternaries, 1,280 ??" is a plan. Reducing
 * complexity means knowing which of those is redundant defensiveness that
 * belongs at a boundary and which is the logic itself.
 */
export function branchKind(node: ts.Node): string | null {
  switch (node.kind) {
    case ts.SyntaxKind.IfStatement: return 'if';
    case ts.SyntaxKind.ForStatement:
    case ts.SyntaxKind.ForInStatement:
    case ts.SyntaxKind.ForOfStatement:
    case ts.SyntaxKind.WhileStatement:
    case ts.SyntaxKind.DoStatement: return 'loop';
    case ts.SyntaxKind.CatchClause: return 'catch';
    case ts.SyntaxKind.ConditionalExpression: return 'ternary';
    case ts.SyntaxKind.CaseClause:
      // An empty `case` falls through to the next one — same path, no branch.
      return (node as ts.CaseClause).statements.length > 0 ? 'case' : null;
    case ts.SyntaxKind.BinaryExpression: {
      const op = (node as ts.BinaryExpression).operatorToken.kind;
      if (op === ts.SyntaxKind.AmpersandAmpersandToken) return '&&';
      if (op === ts.SyntaxKind.BarBarToken) return '||';
      if (op === ts.SyntaxKind.QuestionQuestionToken) return '??';
      return null;
    }
    default: return null;
  }
}

/** Count each kind of decision across these files. */
export function branchKinds(files: string[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const file of files) {
    const src = ts.createSourceFile(file, fs.readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true);
    const walk = (n: ts.Node) => {
      const kind = isFunctionNode(n) ? 'function baseline' : branchKind(n);
      if (kind) counts.set(kind, (counts.get(kind) ?? 0) + 1);
      ts.forEachChild(n, walk);
    };
    walk(src);
  }
  return counts;
}

/** A decision point: one more path through the body. */
function isBranch(node: ts.Node): boolean {
  switch (node.kind) {
    case ts.SyntaxKind.IfStatement:
    case ts.SyntaxKind.ForStatement:
    case ts.SyntaxKind.ForInStatement:
    case ts.SyntaxKind.ForOfStatement:
    case ts.SyntaxKind.WhileStatement:
    case ts.SyntaxKind.DoStatement:
    case ts.SyntaxKind.CatchClause:
    case ts.SyntaxKind.ConditionalExpression:
      return true;
    // An empty `case` falls through to the next one — same path, no branch.
    case ts.SyntaxKind.CaseClause:
      return (node as ts.CaseClause).statements.length > 0;
    case ts.SyntaxKind.BinaryExpression: {
      const op = (node as ts.BinaryExpression).operatorToken.kind;
      return (
        op === ts.SyntaxKind.AmpersandAmpersandToken ||
        op === ts.SyntaxKind.BarBarToken ||
        op === ts.SyntaxKind.QuestionQuestionToken
      );
    }
    default:
      return false;
  }
}

/** The name a reader would use for this function. */
function nameOf(node: FunctionNode): string {
  if (ts.isConstructorDeclaration(node)) {
    const owner = node.parent;
    const cls = ts.isClassLike(owner) && owner.name ? owner.name.text : 'anonymous';
    return `${cls}.constructor`;
  }
  if ((ts.isMethodDeclaration(node) || ts.isGetAccessor(node) || ts.isSetAccessor(node)) && node.name) {
    const owner = node.parent;
    const cls = ts.isClassLike(owner) && owner.name ? `${owner.name.text}.` : '';
    const prefix = ts.isGetAccessor(node) ? 'get ' : ts.isSetAccessor(node) ? 'set ' : '';
    return `${cls}${prefix}${node.name.getText()}`;
  }
  if ((ts.isFunctionDeclaration(node) || ts.isFunctionExpression(node)) && node.name) {
    return node.name.text;
  }
  // An arrow or anonymous function borrows the name it is bound to.
  const parent = node.parent;
  if (ts.isVariableDeclaration(parent) && ts.isIdentifier(parent.name)) return parent.name.text;
  if (ts.isPropertyAssignment(parent) && parent.name) return parent.name.getText();
  if (ts.isPropertyDeclaration(parent) && parent.name) return parent.name.getText();
  if (ts.isExportAssignment(parent)) return 'default';
  if (ts.isCallExpression(parent) && ts.isIdentifier(parent.expression)) {
    return `${parent.expression.text}(…)`;
  }
  return '<anonymous>';
}

/**
 * Every function in one file, plus a `<module>` entry for its top level.
 *
 * Pass `source` to score text we never wrote to disk — that is what the
 * tests do.
 */
export function complexityOf(file: string, source?: string): FunctionComplexity[] {
  const text = source ?? fs.readFileSync(file, 'utf8');
  const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const out: FunctionComplexity[] = [];
  const path = rel(file);

  const lineOf = (pos: number) => sf.getLineAndCharacterOfPosition(pos).line + 1;

  /** Walk a body, counting its branches and recursing into nested functions. */
  const score = (node: ts.Node): number => {
    let count = 0;
    node.forEachChild((child) => {
      if (isFunctionNode(child)) {
        collect(child);
        return;
      }
      if (isBranch(child)) count += 1;
      count += score(child);
    });
    return count;
  };

  const collect = (node: FunctionNode) => {
    const line = lineOf(node.getStart(sf));
    const endLine = lineOf(node.getEnd());
    out.push({
      file,
      path,
      name: nameOf(node),
      line,
      endLine,
      complexity: 1 + score(node),
      lines: endLine - line + 1,
    });
  };

  const moduleBranches = score(sf);
  if (moduleBranches > 0) {
    out.push({
      file,
      path,
      name: '<module>',
      line: 1,
      endLine: lineOf(sf.getEnd()),
      complexity: 1 + moduleBranches,
      lines: lineOf(sf.getEnd()),
    });
  }

  return out.sort((a, b) => a.line - b.line);
}

/** Complexity for a set of files, flattened. */
export function complexityOfAll(files: string[]): FunctionComplexity[] {
  return files.flatMap((f) => complexityOf(f));
}

/**
 * Our bands. A function over 10 wants a second look; over 20 it is hard to
 * test exhaustively, and over 50 nobody holds it in their head at all.
 */
type Band = 'simple' | 'watch' | 'complex' | 'unmaintainable';

export function bandOf(complexity: number): Band {
  if (complexity <= 10) return 'simple';
  if (complexity <= 20) return 'watch';
  if (complexity <= 50) return 'complex';
  return 'unmaintainable';
}
