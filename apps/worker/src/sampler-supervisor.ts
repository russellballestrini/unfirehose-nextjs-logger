/**
 * Keeps the sampler child alive for as long as the worker is. A child that
 * exits is started again after a delay that doubles from a second to half
 * a minute, so a sampler that cannot start — a missing binary, a database
 * it cannot open — logs at a readable rate rather than a tight loop.
 */

import { fork, type ChildProcess } from 'child_process';

export const RESPAWN_MIN_MS = 1_000;
export const RESPAWN_MAX_MS = 30_000;

/** Delay before the n-th restart (n from 0): 1 s, 2 s, 4 s … capped. */
export function respawnDelayMs(attempt: number): number {
  return Math.min(RESPAWN_MAX_MS, RESPAWN_MIN_MS * 2 ** Math.max(0, attempt));
}

/** A child that ran this long counts as having started; the backoff resets. */
export const HEALTHY_AFTER_MS = 60_000;

export interface Supervised {
  /** Stop the child and do not restart it. */
  stop(): void;
}

export function startSampler(entry: string, log: (line: string) => void = console.log): Supervised {
  let child: ChildProcess | null = null;
  let attempt = 0;
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | null = null;

  const spawnOnce = () => {
    if (stopped) return;
    const startedAt = Date.now();
    // execArgv carries the tsx loader in development, so a .ts entry runs.
    child = fork(entry, [], { env: { ...process.env, UNFIREHOSE_SAMPLER_CHILD: '1' } });
    log(`[worker] sampler started (pid ${child.pid})`);
    child.on('exit', (code, signal) => {
      child = null;
      if (stopped) return;
      if (Date.now() - startedAt >= HEALTHY_AFTER_MS) attempt = 0;
      const delay = respawnDelayMs(attempt++);
      log(`[worker] sampler exited (${signal ?? `code ${code}`}); restarting in ${delay / 1000}s`);
      timer = setTimeout(spawnOnce, delay);
    });
  };
  spawnOnce();

  return {
    stop() {
      stopped = true;
      if (timer) clearTimeout(timer);
      child?.kill('SIGTERM');
    },
  };
}
