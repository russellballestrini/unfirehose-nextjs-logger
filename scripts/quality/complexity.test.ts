import { describe, it, expect } from 'vitest';
import { complexityOf, bandOf } from './complexity.ts';

/** Score a snippet without writing it to disk. */
const cc = (source: string, name = 'f') => {
  const found = complexityOf('/virtual/sample.ts', source).find((f) => f.name === name);
  if (!found) throw new Error(`no function named ${name} in:\n${source}`);
  return found.complexity;
};

describe('cyclomatic complexity', () => {
  it('scores a straight line as one path', () => {
    expect(cc('function f() { return 1; }')).toBe(1);
  });

  it('counts each branching statement', () => {
    expect(cc('function f(a) { if (a) return 1; return 2; }')).toBe(2);
    expect(cc('function f(a) { for (const x of a) g(x); }')).toBe(2);
    expect(cc('function f(a) { while (a) a--; }')).toBe(2);
    expect(cc('function f(a) { do { a--; } while (a); }')).toBe(2);
    expect(cc('function f(a) { return a ? 1 : 2; }')).toBe(2);
    expect(cc('function f() { try { g(); } catch { h(); } }')).toBe(2);
  });

  it('counts short-circuits, because they are branches', () => {
    // `a && b` runs b only sometimes. A reader has to hold both cases.
    expect(cc('function f(a, b) { return a && b; }')).toBe(2);
    expect(cc('function f(a, b) { return a || b; }')).toBe(2);
    expect(cc('function f(a, b) { return a ?? b; }')).toBe(2);
    expect(cc('function f(a, b, c) { return a && b && c; }')).toBe(3);
  });

  it('counts a case that acts, and not one that falls through', () => {
    const source = `function f(a) {
      switch (a) {
        case 1:
        case 2: return 'low';
        default: return 'high';
      }
    }`;
    // `case 1:` falls straight into `case 2:` — same path, one decision.
    expect(cc(source)).toBe(2);
  });

  it('gives a nested function its own score rather than its parent', () => {
    const source = `function outer(a) {
      const inner = (b) => (b ? 1 : 2);
      return a ? inner(a) : 0;
    }`;
    expect(cc(source, 'outer')).toBe(2);
    expect(cc(source, 'inner')).toBe(2);
  });

  it('names an arrow after whatever it is bound to', () => {
    const found = complexityOf('/virtual/s.ts', 'export const handler = (a) => (a ? 1 : 2);');
    expect(found.map((f) => f.name)).toContain('handler');
  });

  it('names a method for its class', () => {
    const found = complexityOf('/virtual/s.ts', 'class Poller { poll(a) { return a || 1; } }');
    expect(found.find((f) => f.name === 'Poller.poll')?.complexity).toBe(2);
  });

  it('scores branching at module level as <module>', () => {
    // A file that decides things on import is doing work like any other.
    const found = complexityOf('/virtual/s.ts', 'const x = process.env.A ?? "b";\nif (x) console.log(x);');
    expect(found.find((f) => f.name === '<module>')?.complexity).toBe(3);
  });

  it('leaves a branchless file with no module entry', () => {
    const found = complexityOf('/virtual/s.ts', 'export const x = 1;\n');
    expect(found).toHaveLength(0);
  });

  it('records where a function starts and how far it runs', () => {
    const [fn] = complexityOf('/virtual/s.ts', '\n\nfunction f() {\n  return 1;\n}\n');
    expect(fn.line).toBe(3);
    expect(fn.endLine).toBe(5);
    expect(fn.lines).toBe(3);
  });

  it('bands on the thresholds a reader is told about', () => {
    expect(bandOf(10)).toBe('simple');
    expect(bandOf(11)).toBe('watch');
    expect(bandOf(21)).toBe('complex');
    expect(bandOf(51)).toBe('unmaintainable');
  });

  it('reads TSX, which is most of our components', () => {
    const source = 'function Row({ a }) { return <div>{a ? <b/> : null}</div>; }';
    expect(cc(source, 'Row')).toBe(2);
  });
});
