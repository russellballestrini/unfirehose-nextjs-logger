import { describe, it, expect } from 'vitest';
import { tokenise } from './duplication.ts';

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
