/**
 * Run one git command and return its stdout.
 *
 * Seven API routes each defined their own copy of this, differing only in
 * default timeout and buffer size, and every one of them paid the same
 * hidden cost: spawning from the Next server process takes ~400ms here,
 * because fork copies the page tables of a large, busy process. git itself
 * answers in 0.00s. That is why the file browser now reads the working tree
 * from disk and the branch from `.git/HEAD` — a spawn avoided is worth more
 * than any flag.
 *
 * One copy so the accounting has somewhere to live, and so a future cache or
 * queue has one place to sit.
 */

import { execFile } from 'child_process';

export interface GitExecOptions {
  /** Milliseconds before the child is killed. */
  timeout?: number;
  /** Bytes of stdout to accept. A diff of a large change is not small. */
  maxBuffer?: number;
  /**
   * Written to the child's stdin, which is then closed.
   *
   * Not optional for commands that read stdin: `cat-file --batch-check`
   * hangs until the stream closes, so a call without this waits out the
   * whole timeout and looks like git being slow.
   */
  stdin?: string;
}

export function gitExec(
  cwd: string,
  args: string[],
  opts: GitExecOptions = {},
): Promise<string> {
  const { timeout = 10_000, maxBuffer = 5 * 1024 * 1024, stdin } = opts;
  return new Promise((resolve, reject) => {
    const child = execFile('git', args, { cwd, timeout, maxBuffer }, (err, stdout) => {
      if (err) reject(err);
      else resolve(stdout);
    });
    // Always close stdin: a child left waiting on it never exits.
    if (stdin !== undefined) child.stdin?.end(stdin);
    else child.stdin?.end();
  });
}
