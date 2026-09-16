import { describe, it, expect } from 'vitest';
import { prettifyShell, shellHasStructure } from './shell-pretty.js';

// A bash one-liner as harnesses write them, laid out for a person. Every
// case is checked twice: the layout, and that laying it out again changes
// nothing (idempotent), which is what lets a toggle re-render freely.
const same = (s: string) => expect(prettifyShell(prettifyShell(s))).toBe(prettifyShell(s));

describe('prettifyShell', () => {
  it('splits at top-level operators, continuations leading the next line', () => {
    const cmd = 'cd ~/git/x && make test 2>&1 | tail -3; echo done';
    expect(prettifyShell(cmd)).toBe(
      'cd ~/git/x\n  && make test 2>&1\n  | tail -3\necho done');
    same(cmd);
    expect(prettifyShell('a || b |& c')).toBe('a\n  || b\n  |& c');
    expect(prettifyShell('sleep 5 & wait')).toBe('sleep 5 &\nwait');
  });

  it('leaves quotes, substitutions, groups, comments and heredocs alone', () => {
    for (const [cmd, want] of [
      ['echo "a; b" && echo \'c | d\'', 'echo "a; b"\n  && echo \'c | d\''],
      ['echo $(ls | wc -l) && x=$( (cd d; ls) ) || true',
       'echo $(ls | wc -l)\n  && x=$( (cd d; ls) )\n  || true'],
      ['{ a; b; } && c', '{ a; b; }\n  && c'],
      ['echo "x" # trailing; comment', 'echo "x" # trailing; comment'],
      ["python3 - <<'EOF'\nimport os; print(\"a; b\")\nEOF\necho after | tee log",
       "python3 - <<'EOF'\nimport os; print(\"a; b\")\nEOF\necho after\n  | tee log"],
      ['cat <<-X\n\tone; two\n\tX\nls', 'cat <<-X\n\tone; two\n\tX\nls'],
      ['ls 2>&1 >/dev/null', 'ls 2>&1 >/dev/null'],
      ['x=`ls; pwd` && echo $x', 'x=`ls; pwd`\n  && echo $x'],
    ] as const) {
      expect(prettifyShell(cmd), cmd).toBe(want);
      same(cmd);
    }
  });

  it('indents if/for/while/case bodies the way a script is written', () => {
    expect(prettifyShell('if [ -f x ]; then echo yes; else echo no; fi')).toBe(
      'if [ -f x ]; then\n  echo yes\nelse\n  echo no\nfi');
    expect(prettifyShell('for f in a b; do echo "$f" && cat $f | wc -l; done; echo end')).toBe(
      'for f in a b; do\n  echo "$f"\n    && cat $f\n    | wc -l\ndone\necho end');
    expect(prettifyShell('if a; then b; elif c; then d; fi')).toBe(
      'if a; then\n  b\nelif c; then\n  d\nfi');
    expect(prettifyShell('case $x in a) echo a;; b) echo b;; esac')).toBe(
      'case $x in\n  a) echo a;;\n  b) echo b;;\nesac');
    expect(prettifyShell('while read l; do echo $l; done < f')).toBe(
      'while read l; do\n  echo $l\ndone < f');
    same('if [ -f x ]; then echo yes; else echo no; fi');
    same('for f in a b; do echo "$f" && cat $f | wc -l; done; echo end');
  });

  it('fails open on text it cannot tokenize and passes simple commands through', () => {
    expect(prettifyShell("unterminated 'quote; here")).toBe("unterminated 'quote; here");
    expect(prettifyShell('echo "open && never closed')).toBe('echo "open && never closed');
    expect(prettifyShell('cat <<EOF\nno terminator; ever')).toBe('cat <<EOF\nno terminator; ever');
    expect(prettifyShell('ls')).toBe('ls');
    expect(prettifyShell('   ')).toBe('   ');
    expect(prettifyShell(undefined as unknown as string)).toBe('');
    expect(shellHasStructure('ls -la')).toBe(false);
    expect(shellHasStructure('ls; pwd')).toBe(true);
  });
});
