import { describe, it, expect } from 'vitest';
import { phaseOffsetMs, MESH_POLL_INTERVAL_MS } from './sampler';
import { respawnDelayMs, RESPAWN_MAX_MS } from './sampler-supervisor';

describe('phaseOffsetMs', () => {
  it('lands every host inside the poll window, the same place every time', () => {
    for (const host of ['localhost', 'cammy.foxhop.net', '4090-ai.foxhop.net', '']) {
      const a = phaseOffsetMs(host, MESH_POLL_INTERVAL_MS);
      expect(a).toBeGreaterThanOrEqual(0);
      expect(a).toBeLessThan(MESH_POLL_INTERVAL_MS);
      expect(phaseOffsetMs(host, MESH_POLL_INTERVAL_MS)).toBe(a);
    }
  });

  it('spreads different hosts apart', () => {
    const offsets = new Set(['a', 'b', 'c', 'd'].map((h) => phaseOffsetMs(h, MESH_POLL_INTERVAL_MS)));
    expect(offsets.size).toBeGreaterThan(1);
  });
});

describe('respawnDelayMs', () => {
  it('doubles from a second and stops at the cap', () => {
    expect([0, 1, 2, 3, 4, 5, 6].map(respawnDelayMs)).toEqual([1000, 2000, 4000, 8000, 16000, 30000, 30000]);
    expect(respawnDelayMs(50)).toBe(RESPAWN_MAX_MS);
  });
});
