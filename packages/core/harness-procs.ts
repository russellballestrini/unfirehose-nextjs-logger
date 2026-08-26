// Recognizing a running harness in `ps` output.
//
// The mesh probes counted exactly one thing: a process whose cmdline basename
// was `claude`. Every other harness was invisible — measured 2026-08-25 on
// fox's box, 5 uncloseai-cli agents were running and the permacomputer pages
// reported none, because uncloseai-cli is a Python console script and shows up
// as `python3 /home/fox/.local/bin/unclose`. Its basename is `python3`.
//
// So matching the interpreter is not enough and matching the whole line is
// worse: an earlier version grepped case-insensitively for "claude" anywhere
// in the line and counted every process that merely mentioned CLAUDE.md,
// inflating counts ~3x on hosts running the lumbda factory monitors. The rule
// has to be: basename of the executable, and when that executable is an
// interpreter, basename of the script it was handed.

/** Interpreters that run a harness as a script rather than as a binary. */
export const INTERPRETERS = /^(python[0-9.]*|node|nodejs|ruby|perl|deno|bun)$/;

/**
 * Executable (or script) names that mean "an agent harness is running here",
 * mapped to the harness key used everywhere else — see HARNESSES.
 */
export const HARNESS_PROC_NAMES: Record<string, string> = {
  'claude':        'claude',
  'unclose':       'uncloseai',
  'uncloseai-cli': 'uncloseai',
  'uncloseai_cli.py': 'uncloseai',
  'gemini':        'gemini',
  'codex':         'codex',
  'opencode':      'open-code',
  'aider':         'aider',
  'agnt':          'agnt',
  'cursor':        'cursor',
  'crossbench':    'uncloseai',
};

function basename(p: string): string {
  if (!p) return '';
  const i = p.lastIndexOf('/');
  return i === -1 ? p : p.slice(i + 1);
}

/**
 * Which harness, if any, a cmdline belongs to.
 *
 * `argv` is the command portion of a `ps aux` line, already split. Kernel
 * threads (bracketed) and empty commands are never harnesses.
 */
export function harnessForCmdline(argv: string[]): string | null {
  const exe = argv[0] ?? '';
  if (!exe || exe.startsWith('[')) return null;

  const exeBase = basename(exe);
  if (HARNESS_PROC_NAMES[exeBase]) return HARNESS_PROC_NAMES[exeBase];

  if (INTERPRETERS.test(exeBase)) {
    // Skip interpreter flags (`python3 -u script`) to reach the script itself.
    for (let i = 1; i < argv.length; i++) {
      const a = argv[i];
      if (!a || a.startsWith('-')) continue;
      const hit = HARNESS_PROC_NAMES[basename(a)];
      return hit ?? null;   // first non-flag arg is the script; stop either way
    }
  }
  return null;
}

export interface HarnessProc {
  user: string;
  pid: number;
  cpu: number;
  mem: number;
  rss: number;
  start: string;
  time: string;
  command: string;
  /** Harness key: 'claude', 'uncloseai', … */
  harness: string;
}

/**
 * Parse `ps aux` lines into harness processes.
 *
 * Deliberately parses the WHOLE ps table and filters here rather than shipping
 * a per-harness awk expression to each node: one probe section, one rule, and
 * adding a harness never means editing a shell string embedded in two routes.
 */
export function parseHarnessProcesses(raw: string): HarnessProc[] {
  if (!raw || raw === 'none') return [];
  const out: HarnessProc[] = [];
  for (const line of raw.split('\n')) {
    const t = line.trim();
    if (!t || t.startsWith('===SECTION:')) continue;
    const parts = t.split(/\s+/);
    if (parts.length < 11) continue;
    if (parts[0] === 'USER' || !/^\d+$/.test(parts[1])) continue;   // header row

    const argv = parts.slice(10);
    const harness = harnessForCmdline(argv);
    if (!harness) continue;

    out.push({
      user: parts[0],
      pid: parseInt(parts[1], 10),
      cpu: parseFloat(parts[2]),
      mem: parseFloat(parts[3]),
      rss: parseInt(parts[5], 10),
      start: parts[8],
      time: parts[9],
      command: argv.join(' '),
      harness,
    });
  }
  return out;
}

/** Count per harness key, e.g. { claude: 2, uncloseai: 5 }. */
export function countByHarness(procs: HarnessProc[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const p of procs) out[p.harness] = (out[p.harness] ?? 0) + 1;
  return out;
}

/**
 * awk program that emits full `ps aux` lines for harness processes only.
 *
 * Used by the lightweight mesh summary, which cannot ship the whole ps table
 * for every node on every poll. Kept beside the TypeScript rule it mirrors so
 * the two cannot drift apart unnoticed; parseHarnessProcesses re-applies the
 * real rule to whatever comes back.
 */
export function harnessPsAwk(): string {
  const names = Object.keys(HARNESS_PROC_NAMES).join('|');
  return (
    `NR>1 { ` +
    `cmd=$11; ` +
    `if (cmd == "" || substr(cmd,1,1) == "[") next; ` +
    `n=split(cmd, p, "/"); b=p[n]; ` +
    `if (b ~ /^(${names})$/) { print; next } ` +
    `if (b ~ /^(python[0-9.]*|node|nodejs|ruby|perl|deno|bun)$/) { ` +
    `for (i=12; i<=NF; i++) { a=$i; if (a == "" || substr(a,1,1) == "-") continue; ` +
    `m=split(a, q, "/"); if (q[m] ~ /^(${names})$/) print; break } } ` +
    `}`
  );
}
