import { describe, it, expect } from 'vitest';
import {
  harnessForCmdline,
  parseHarnessProcesses,
  countByHarness,
  harnessPsAwk,
} from './harness-procs.js';

// Real `ps aux` lines from fox's box, 2026-08-25, with paths kept and the
// command bodies trimmed. Five uncloseai agents were running at the time and
// the permacomputer pages reported zero.
const PS = [
  'USER         PID %CPU %MEM    VSZ   RSS TTY      STAT START   TIME COMMAND',
  'fox        12345  4.0  1.2 900000 250000 pts/3  Sl+  19:10   0:31 claude',
  'fox        12346  0.5  0.9 800000 190000 pts/4  Sl+  19:12   0:07 /home/fox/.local/bin/claude --resume abc',
  'fox        22001  9.1  2.1 700000 410000 pts/9  Sl+  20:53   1:12 python3 /home/fox/.local/bin/unclose',
  'fox        22002  8.7  2.0 700000 400000 pts/9  Sl+  20:55   1:05 python3 -u /home/fox/.local/bin/unclose --model qwen/qwen3.8-27b',
  'fox        22003  1.0  0.4 300000  90000 pts/2  Sl+  21:02   0:10 /usr/bin/python3 /home/fox/.local/bin/uncloseai-cli',
  'root           1  0.0  0.0  20000   9000 ?      Ss   Aug23   0:12 /sbin/init',
  'root          14  0.0  0.0      0      0 ?      I<   Aug23   0:00 [kworker/R-netns]',
  'fox        33001  0.1  0.3 200000  60000 ?      Sl   19:00   0:02 node /home/fox/.../next dev',
  // The false positive the old substring grep produced: a monitor whose
  // cmdline merely mentions CLAUDE.md.
  'fox        44001  0.2  0.1 100000  30000 ?      S    18:00   0:01 python3 /home/fox/git/lumbda/monitor.py --sop /home/fox/CLAUDE.md',
].join('\n');

describe('harnessForCmdline', () => {
  it('matches a bare binary by basename', () => {
    expect(harnessForCmdline(['claude'])).toBe('claude');
    expect(harnessForCmdline(['/home/fox/.local/bin/claude', '--resume', 'x'])).toBe('claude');
  });

  it('finds a Python console script behind its interpreter', () => {
    // The whole point: `unclose` never appears in column 11.
    expect(harnessForCmdline(['python3', '/home/fox/.local/bin/unclose'])).toBe('uncloseai');
    expect(harnessForCmdline(['/usr/bin/python3', '/home/fox/.local/bin/uncloseai-cli'])).toBe('uncloseai');
  });

  it('skips interpreter flags to reach the script', () => {
    expect(harnessForCmdline(['python3', '-u', '/home/fox/.local/bin/unclose', '--model', 'x']))
      .toBe('uncloseai');
  });

  it('does not match a process that merely mentions CLAUDE.md', () => {
    expect(harnessForCmdline(['python3', '/home/fox/git/lumbda/monitor.py', '--sop', '/home/fox/CLAUDE.md']))
      .toBeNull();
  });

  it('ignores kernel threads and empty commands', () => {
    expect(harnessForCmdline(['[kworker/R-netns]'])).toBeNull();
    expect(harnessForCmdline([''])).toBeNull();
    expect(harnessForCmdline([])).toBeNull();
  });

  it('does not treat an ordinary node or python process as a harness', () => {
    expect(harnessForCmdline(['node', '/home/fox/x/next', 'dev'])).toBeNull();
    expect(harnessForCmdline(['python3', '/usr/bin/unattended-upgrade-shutdown'])).toBeNull();
  });
});

describe('parseHarnessProcesses', () => {
  const procs = parseHarnessProcesses(PS);

  it('finds every harness, not just claude', () => {
    expect(countByHarness(procs)).toEqual({ claude: 2, uncloseai: 3 });
  });

  it('drops the ps header row', () => {
    expect(procs.every((p) => p.user !== 'USER')).toBe(true);
  });

  it('keeps the fields the node pages render', () => {
    const p = procs.find((x) => x.pid === 22001)!;
    expect(p.harness).toBe('uncloseai');
    expect(p.user).toBe('fox');
    expect(p.cpu).toBeCloseTo(9.1);
    expect(p.mem).toBeCloseTo(2.1);
    expect(p.rss).toBe(410000);
    expect(p.command).toContain('unclose');
  });

  it('excludes init, kernel threads and the CLAUDE.md monitor', () => {
    const pids = procs.map((p) => p.pid);
    expect(pids).not.toContain(1);
    expect(pids).not.toContain(14);
    expect(pids).not.toContain(44001);
    expect(pids).not.toContain(33001);
  });

  it('returns nothing for empty or sentinel input', () => {
    expect(parseHarnessProcesses('')).toEqual([]);
    expect(parseHarnessProcesses('none')).toEqual([]);
  });
});

describe('harnessPsAwk mirrors the TypeScript rule', () => {
  const awk = harnessPsAwk();

  it('names every harness binary it must match', () => {
    for (const n of ['claude', 'unclose', 'uncloseai-cli', 'aider', 'codex']) {
      expect(awk).toContain(n);
    }
  });

  it('handles interpreters and skips kernel threads', () => {
    expect(awk).toContain('python');
    expect(awk).toContain('substr(cmd,1,1) == "["');
  });

  it('is a single-quote-safe shell fragment', () => {
    // Embedded in `awk '...'`, so a literal single quote would break the probe.
    expect(awk).not.toContain("'");
  });
});
