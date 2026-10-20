import { describe, it, expect } from 'vitest';
import { phaseOffsetMs, MESH_POLL_INTERVAL_MS, reconcileMeshHosts } from './sampler';
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

describe('reconcileMeshHosts', () => {
  const harness = () => {
    const started: string[] = [];
    const stopped: string[] = [];
    const start = (host: string) => { started.push(host); return { host }; };
    const stop = (t: { host: string }) => { stopped.push(t.host); };
    return { started, stopped, start, stop };
  };

  it('starts every host on an empty set', () => {
    const h = harness();
    const active = new Map<string, { host: string }>();
    const r = reconcileMeshHosts(active, ['localhost', 'cammy.foxhop.net'], h.start, h.stop);
    expect(r).toEqual({ added: ['localhost', 'cammy.foxhop.net'], removed: [] });
    expect([...active.keys()]).toEqual(['localhost', 'cammy.foxhop.net']);
    expect(h.stopped).toEqual([]);
  });

  it('a host that appears in ssh config later is started, nothing else is touched', () => {
    const h = harness();
    const active = new Map<string, { host: string }>();
    reconcileMeshHosts(active, ['localhost', 'cammy.foxhop.net'], h.start, h.stop);
    const cammyBefore = active.get('cammy.foxhop.net');
    const r = reconcileMeshHosts(active, ['localhost', 'cammy.foxhop.net', 'ai-3060.foxhop.net'], h.start, h.stop);
    expect(r).toEqual({ added: ['ai-3060.foxhop.net'], removed: [] });
    expect(active.get('cammy.foxhop.net')).toBe(cammyBefore);
    expect(h.stopped).toEqual([]);
  });

  it('a host removed from ssh config is stopped and forgotten', () => {
    const h = harness();
    const active = new Map<string, { host: string }>();
    reconcileMeshHosts(active, ['localhost', 'old.foxhop.net'], h.start, h.stop);
    const r = reconcileMeshHosts(active, ['localhost'], h.start, h.stop);
    expect(r).toEqual({ added: [], removed: ['old.foxhop.net'] });
    expect(h.stopped).toEqual(['old.foxhop.net']);
    expect(active.has('old.foxhop.net')).toBe(false);
  });

  it('an unchanged list is a no-op', () => {
    const h = harness();
    const active = new Map<string, { host: string }>();
    reconcileMeshHosts(active, ['localhost'], h.start, h.stop);
    const r = reconcileMeshHosts(active, ['localhost'], h.start, h.stop);
    expect(r).toEqual({ added: [], removed: [] });
    expect(h.started).toEqual(['localhost']);
    expect(h.stopped).toEqual([]);
  });
});
