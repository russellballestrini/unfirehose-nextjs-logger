import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { tokenise, findClones } from './duplication.ts';

describe('structural tokenising', () => {
  it('reads two blocks that differ only in names as the same shape', () => {
    // The whole reason this matches on structure: a rename is not a rewrite.
    const a = tokenise('const rows = db.prepare("A").all();').map((t) => t.shape);
    const b = tokenise('const items = store.query("B").all();').map((t) => t.shape);
    expect(a).toEqual(b);
  });

  it('keeps operators and keywords, which are the structure', () => {
    const a = tokenise('if (x) return 1;').map((t) => t.shape);
    const b = tokenise('for (x) return 1;').map((t) => t.shape);
    expect(a).not.toEqual(b);
  });

  it('drops comments and whitespace, which are not', () => {
    const bare = tokenise('const a = 1;').map((t) => t.shape);
    const commented = tokenise('// explain\nconst a = 1;   // more\n').map((t) => t.shape);
    expect(commented).toEqual(bare);
  });

  it('remembers the line each token came from, so a report can point at it', () => {
    const tokens = tokenise('const a = 1;\n\nconst b = 2;\n');
    expect(tokens[0].line).toBe(1);
    expect(tokens[tokens.length - 1].line).toBe(3);
  });
});

describe('findClones', () => {
  let dir: string;
  const write = (name: string, source: string) => {
    const file = path.join(dir, name);
    fs.writeFileSync(file, source);
    return file;
  };

  beforeAll(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'unfirehose-clones-')); });
  afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

  /**
   * A block long enough to clear the window and varied enough that it does
   * not clone itself — a run of same-shaped lines would be found repeating
   * within one file, which is a different finding.
   */
  const block = (p: string) => `
    const ${p}A = load(1);
    if (${p}A) { report(${p}A); }
    for (const item of ${p}A) { total += item.size; }
    const ${p}B = total > 10 ? 'big' : 'small';
    while (queue.length) { queue.pop(); }
    try { flush(${p}B); } catch { retry(); }
    switch (${p}B) { case 'big': grow(); break; default: shrink(); }
    const ${p}C = list.filter((x) => x.ok).map((x) => x.id);
    return ${p}C.length && ${p}A ? ${p}C : null;
  `;

  it('finds the same shape under different names', () => {
    // The whole reason it matches on structure: a rename is not a rewrite.
    const a = write('a.ts', block('alpha'));
    const b = write('b.ts', block('beta'));
    const clones = findClones([a, b], 60);

    expect(clones.length).toBeGreaterThan(0);
    expect(clones[0].instances.map((i) => i.path.split('/').pop()).sort())
      .toEqual(['a.ts', 'b.ts']);
  });

  it('says how much extracting one would save', () => {
    const clones = findClones([write('c.ts', block('gamma')), write('d.ts', block('delta'))], 60);
    // One of two copies is redundant, so the saving is one clone's length.
    expect(clones[0].redundant).toBe(clones[0].tokens);
  });

  it('reports the lines to look at', () => {
    const clones = findClones([write('e.ts', block('eps')), write('f.ts', block('zeta'))], 60);
    for (const instance of clones[0].instances) {
      expect(instance.startLine).toBeGreaterThan(0);
      expect(instance.endLine).toBeGreaterThanOrEqual(instance.startLine);
    }
  });

  it('finds nothing in files that merely share a language', () => {
    const a = write('g.ts', 'export const sum = (xs: number[]) => xs.reduce((p, c) => p + c, 0);\n');
    const b = write('h.ts', 'export function greet(name: string) { return `hello ${name}`; }\n');
    expect(findClones([a, b], 60)).toEqual([]);
  });

  it('ignores a file too short to hold a window', () => {
    expect(findClones([write('i.ts', 'const x = 1;\n')], 60)).toEqual([]);
  });

  it('ranks by what extraction would save', () => {
    const clones = findClones([
      write('j.ts', block('one')), write('k.ts', block('two')), write('l.ts', block('three')),
    ], 60);
    for (let i = 1; i < clones.length; i += 1) {
      expect(clones[i - 1].redundant).toBeGreaterThanOrEqual(clones[i].redundant);
    }
  });
});

describe('tables are not duplication', () => {
  let dir: string;
  const write = (name: string, source: string) => {
    const file = path.join(dir, name);
    fs.writeFileSync(file, source);
    return file;
  };
  beforeAll(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'unfirehose-tables-')); });
  afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

  it('reports a table of same-shaped rows once, not once per row', () => {
    // Fifty currency rows are all the same shape because that is what a
    // table is. Tiling a sixty-token window across them used to report
    // eighteen copies of something nobody had duplicated, and it was the
    // single largest entry in our duplication report.
    const rows = Array.from({ length: 40 }, (_, i) =>
      `  { code: 'C${i}', label: 'Currency ${i}', group: 'Major', symbol: 'S${i}' },`);
    const file = write('table.ts', `export const T = [\n${rows.join('\n')}\n];\n`);
    const clones = findClones([file], 60);
    expect(clones).toEqual([]);
  });

  it('still catches the same block written out twice with code between', () => {
    // Copy-paste is separated by other code; periodic structure is not.
    const block = (n: string) => `
export function ${n}(input: string[]): number {
  let total = 0;
  for (const item of input) {
    if (!item) continue;
    if (item.startsWith('#')) continue;
    const value = Number.parseFloat(item);
    if (!Number.isFinite(value)) continue;
    total += value > 0 ? value : 0;
  }
  return total;
}
`;
    const file = write('twice.ts', block('a') + '\nconst SPACER = 1;\n' + block('b'));
    const clones = findClones([file], 40);
    expect(clones.length).toBeGreaterThan(0);
    expect(clones[0].instances).toHaveLength(2);
  });
});

describe('data is not duplication', () => {
  let dir: string;
  const write = (name: string, source: string) => {
    const file = path.join(dir, name);
    fs.writeFileSync(file, source);
    return file;
  };
  beforeAll(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'unfirehose-data-')); });
  afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

  it('ignores a short table too, where a run is only two windows long', () => {
    // Twelve harness rows tile into two windows, which is under the
    // run-length rule — but they are still a table.
    const rows = Array.from({ length: 12 }, (_, i) =>
      `  { value: 'v${i}', label: 'Label ${i}', cmd: 'c${i}' },`);
    const file = write('short.ts', `export const T = [\n${rows.join('\n')}\n];\n`);
    expect(findClones([file], 60)).toEqual([]);
  });

  it('still reports the same constant list living in two files', () => {
    // That is the drift this whole report exists to find: one copy gets
    // an entry added and the other does not.
    const rows = Array.from({ length: 12 }, (_, i) =>
      `  { value: 'v${i}', label: 'Label ${i}', cmd: 'c${i}' },`);
    const body = `export const T = [\n${rows.join('\n')}\n];\n`;
    const clones = findClones([write('a.ts', body), write('b.ts', body)], 60);
    expect(clones.length).toBeGreaterThan(0);
  });

  it('still reports duplicated markup, which has tags in it', () => {
    const card = `
    <div className="card">
      <span className="title">{title}</span>
      <span className="value">{value}</span>
      <span className="unit">{unit}</span>
    </div>
`;
    const file = write('cards.tsx',
      `export const A = () => (${card});\nconst SPACER = 1;\nexport const B = () => (${card});\n`);
    expect(findClones([file], 40).length).toBeGreaterThan(0);
  });
});

describe('a template placeholder outside a template literal', () => {
  let dir: string;
  const write = (name: string, source: string) => {
    const file = path.join(dir, name);
    fs.writeFileSync(file, source);
    return file;
  };
  beforeAll(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'unfirehose-tpl-')); });
  afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

  it('tokenises a single-quoted string with ${…} in it as one literal', () => {
    // Folding a repeated SQL predicate into a shared constant means
    // substituting it into query strings, and a substitution that lands in
    // a single-quoted string is not a substitution — it reaches SQLite as
    // a dollar sign and the query fails at runtime, not at build. Two of
    // ours did exactly that.
    const wrong = tokenise(`const q = "status \${OPEN} AND x";`);
    const right = tokenise('const q = `status ${OPEN} AND x`;');
    expect(wrong.filter(t => t.shape === 'STR')).toHaveLength(1);
    expect(right.some(t => t.shape === 'ID')).toBe(true);
  });
});
