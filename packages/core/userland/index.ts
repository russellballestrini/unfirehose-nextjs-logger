import { PRELUDE } from './prelude';
import { USERLANDS } from './registry';
import type { Userland } from './types';

export type { Userland } from './types';
export { USERLANDS } from './registry';
export { POWERSHELL_SCRIPT } from './powershell';
export {
  readWire, parseWireProbe, type WireProbe,
  sizeToGB, parseLoad, parseEtime, parseUptimeText, parseUptimeSeconds, parseSwap, parseMemory,
} from './parse';

/**
 * One Bourne-shell script that identifies the userland it is running in
 * and runs that plugin's branch. Piped to `ssh host sh` on stdin, so the
 * remote login shell — csh on an old BSD, fish, whatever — never parses it.
 *
 * Detection is a `case` on `uname -s`. Where several plugins claim one
 * sysname (GNU, busybox and toybox all say Linux) their `refine` tests
 * run in registry order, and the first plugin without one is the else.
 */
export function buildProbeScript(userlands: Userland[] = USERLANDS): string {
  // Group by sysname pattern, keeping first-seen order; `*` is generic, last.
  const groups = new Map<string, Userland[]>();
  for (const u of userlands) {
    for (const s of u.sysnames) {
      if (!groups.has(s)) groups.set(s, []);
      groups.get(s)!.push(u);
    }
  }
  const detect: string[] = ['ul=generic', 'case "$S" in'];
  // A pattern with a space ("Windows NT") must be quoted; a glob must not be.
  const pat = (p: string) => (/\s/.test(p) ? `"${p}"` : p);
  for (const [pattern, list] of groups) {
    const refined = list.filter(u => u.refine);
    const plain = list.find(u => !u.refine) ?? list[list.length - 1]!;
    if (refined.length === 0) {
      detect.push(`  ${pat(pattern)}) ul=${plain.id};;`);
      continue;
    }
    const chain = refined.map((u, i) => `${i === 0 ? 'if' : 'elif'} ${u.refine}; then ul=${u.id}`);
    detect.push(`  ${pat(pattern)}) ${chain.join('; ')}; else ul=${plain.id}; fi;;`);
  }
  detect.push('esac');

  const run: string[] = ['case "$ul" in'];
  for (const u of userlands) {
    if (!u.body || u.sysnames.length === 0) continue;   // spoken by PowerShell, not sh
    run.push(`  ${u.id})`, u.body.replace(/\n$/, ''), '  ;;');
  }
  run.push('esac');

  return [
    PRELUDE,
    'echo uf=1',
    // UF_SYSNAME is a test hook: run any plugin's branch on any box.
    'S=${UF_SYSNAME:-`uname -s 2>/dev/null`}; O=`uname -o 2>/dev/null`',
    'kv os "$S"',
    ...detect,
    'kv userland "$ul"',
    'common',
    ...run,
    'echo END',
    '',
  ].join('\n');
}

/** The plugin a `userland=` wire value names, for labels and errors. */
export function userlandById(id: string, userlands: Userland[] = USERLANDS): Userland | undefined {
  return userlands.find(u => u.id === id);
}
