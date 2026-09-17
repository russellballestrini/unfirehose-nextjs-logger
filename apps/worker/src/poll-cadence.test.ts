import { describe, it, expect } from 'vitest';
import { nextPollDelayMs, POLL_INTERVAL_MS, POLL_QUIET_MAX_MS } from './poll-cadence';

describe('nextPollDelayMs', () => {
  it('stays at a minute while something is landing', () => {
    expect(nextPollDelayMs(POLL_INTERVAL_MS, true)).toBe(POLL_INTERVAL_MS);
    expect(nextPollDelayMs(POLL_QUIET_MAX_MS, true)).toBe(POLL_INTERVAL_MS);
  });
  it('doubles while quiet and stops at five minutes', () => {
    let d = POLL_INTERVAL_MS;
    const seen: number[] = [];
    for (let i = 0; i < 5; i++) { d = nextPollDelayMs(d, false); seen.push(d); }
    expect(seen).toEqual([120_000, 240_000, 300_000, 300_000, 300_000]);
  });
  it('never waits less than a minute', () => {
    expect(nextPollDelayMs(1, false)).toBe(120_000);
  });
});
