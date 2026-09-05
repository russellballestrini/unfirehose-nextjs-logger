import { describe, it, expect } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { table, bar, grade, args, paint, writeJson } from './render.ts';
import { ROOT } from './workspaces.ts';

// Colour is off under NO_COLOR / non-TTY, which is how tests and CI run, so
// these assert the text these tools actually emit into a log.
describe('table', () => {
  it('sizes each column to its widest cell', () => {
    const out = table(
      [{ header: 'file' }, { header: 'n', align: 'right' }],
      [['short', '1'], ['much-longer-name', '250']],
    );
    const [head, rule, first] = out.split('\n');
    expect(head.startsWith('file')).toBe(true);
    expect(rule).toMatch(/^─+ {2}─+$/);
    // The right-aligned column ends where the widest number ends.
    expect(first.endsWith('  1')).toBe(true);
  });

  it('measures width by visible text, not by escape codes', () => {
    // Cells arrive already coloured. Counting the escapes would push every
    // later column out by the length of an invisible sequence.
    const plain = table([{ header: 'x' }, { header: 'y' }], [['ab', 'z']]);
    const painted = table([{ header: 'x' }, { header: 'y' }], [[paint('ab', 'red'), 'z']]);
    expect(painted.split('\n')[2].replace(/\x1b\[[0-9;]*m/g, '')).toBe(plain.split('\n')[2]);
  });

  it('trims the trailing padding of the last column', () => {
    const out = table([{ header: 'a' }, { header: 'b' }], [['x', 'y'], ['x', 'longer']]);
    for (const line of out.split('\n')) expect(line).toBe(line.trimEnd());
  });

  it('renders a header with no rows rather than throwing', () => {
    expect(table([{ header: 'nothing' }], []).split('\n')).toHaveLength(2);
  });

  it('tolerates a row shorter than the header', () => {
    expect(() => table([{ header: 'a' }, { header: 'b' }], [['only']])).not.toThrow();
  });
});

describe('bar', () => {
  it('fills in proportion to the fraction', () => {
    const filled = (f: number) => (bar(f, 10).match(/█/g) ?? []).length;
    expect(filled(0)).toBe(0);
    expect(filled(0.5)).toBe(5);
    expect(filled(1)).toBe(10);
  });

  it('clamps rather than overflowing its width', () => {
    // A percentage computed from an empty denominator can arrive as >1.
    expect((bar(2, 10).match(/█/g) ?? []).length).toBe(10);
    expect((bar(-1, 10).match(/█/g) ?? []).length).toBe(0);
  });
});

describe('grade', () => {
  it('returns the text it was given, whatever the verdict', () => {
    // Colour is decoration; a report piped to a file must still read.
    expect(grade('42', 42, 10, 20)).toContain('42');
    expect(grade('1', 1, 10, 20)).toContain('1');
  });
});

describe('args', () => {
  it('reads --flag=value, --flag value, and a bare --flag', () => {
    const a = args(['--top=5', '--dir', 'apps/web', '--exports']);
    expect(a.num('top', 0)).toBe(5);
    expect(a.str('dir', '')).toBe('apps/web');
    expect(a.has('exports')).toBe(true);
  });

  it('falls back when a flag is absent or not a number', () => {
    const a = args(['--top', 'lots']);
    expect(a.num('top', 25)).toBe(25);
    expect(a.num('missing', 7)).toBe(7);
    expect(a.str('missing', 'default')).toBe('default');
    expect(a.has('missing')).toBe(false);
  });

  it('does not read the next flag as a value', () => {
    const a = args(['--json', '--top', '5']);
    expect(a.has('json')).toBe(true);
    expect(a.num('top', 0)).toBe(5);
  });
});

describe('writeJson', () => {
  it('resolves a relative path against the repository, not the cwd', async () => {
    // Four of our five reports resolved against ROOT and one did not, so the
    // same `--json reports/x.json` landed in two different places depending
    // on which report ran and which directory make happened to be in. Under
    // `make test -j4` that surfaced as EACCES on a path four levels above
    // the repo — a wrong answer that only showed up in parallel.
    const rel = `reports/.render-test-${process.pid}.json`;
    writeJson(rel, { ok: true });
    const abs = path.resolve(ROOT, rel);
    expect(fs.existsSync(abs)).toBe(true);
    expect(JSON.parse(fs.readFileSync(abs, 'utf8'))).toEqual({ ok: true });
    fs.rmSync(abs);
  });

  it('writes an absolute path where it was told to', () => {
    const abs = path.join(os.tmpdir(), `render-test-${process.pid}.json`);
    writeJson(abs, { ok: true });
    expect(fs.existsSync(abs)).toBe(true);
    fs.rmSync(abs);
  });

  it('creates the directory rather than failing on a fresh checkout', () => {
    const dir = path.join(os.tmpdir(), `render-test-dir-${process.pid}`, 'deep', 'er');
    const file = path.join(dir, 'out.json');
    writeJson(file, { ok: true });
    expect(fs.existsSync(file)).toBe(true);
    fs.rmSync(path.join(os.tmpdir(), `render-test-dir-${process.pid}`), { recursive: true });
  });

  it('ends the file with a newline, so a diff of two runs is one line', () => {
    const abs = path.join(os.tmpdir(), `render-test-nl-${process.pid}.json`);
    writeJson(abs, { ok: true });
    expect(fs.readFileSync(abs, 'utf8').endsWith('}\n')).toBe(true);
    fs.rmSync(abs);
  });
});

