import { describe, it, expect, vi } from 'vitest';

vi.mock('@unturf/unfirehose/db/schema', () => ({
  getDb: () => ({ prepare: () => ({ get: () => undefined, all: () => [], run: () => ({}) }) }),
  UNFIREHOSE_DIR: '/tmp/unfirehose-test',
}));

const { getLocalStats } = await import('./route');

/**
 * Reading this machine.
 *
 * getLocalStats is thirty-five branches over /proc, lsblk, nvidia-smi and
 * ps, and it is the one node in the mesh that is always present — every
 * dashboard opens on it. It had no test, because testing it means having a
 * Linux machine, and this is a tool that runs on the machine it watches.
 *
 * So it runs against the real one. The assertions are about shape and
 * plausibility rather than values, since the values are whatever this box
 * happens to be doing.
 */
const onLinux = process.platform === 'linux' ? describe : describe.skip;

onLinux('getLocalStats', () => {
  const stats = getLocalStats();

  it('reports the machine as reachable', () => {
    // It is us. If this is false something threw and was swallowed.
    expect(stats.reachable).toBe(true);
    expect(stats.error).toBeUndefined();
  });

  it('names the host', () => {
    expect(stats.hostname).toBeTruthy();
    expect(typeof stats.hostname).toBe('string');
  });

  it('counts cores and reads the CPU model', () => {
    expect(stats.cpuCores).toBeGreaterThan(0);
    expect(stats.cpuModel).toBeTruthy();
  });

  it('reads memory as gigabytes, used inside total', () => {
    expect(stats.memTotalGB).toBeGreaterThan(0);
    expect(stats.memUsedGB).toBeGreaterThanOrEqual(0);
    expect(stats.memUsedGB!).toBeLessThanOrEqual(stats.memTotalGB!);
  });

  it('rounds the memory cap up to a real DIMM size', () => {
    // /proc/meminfo reports usable RAM, short of the hardware by the
    // kernel's reserved regions.
    expect(stats.memCapGB!).toBeGreaterThanOrEqual(stats.memTotalGB!);
  });

  it('reads three load figures', () => {
    expect(stats.loadAvg).toHaveLength(3);
    for (const n of stats.loadAvg!) expect(Number.isFinite(n)).toBe(true);
  });

  it('reports uptime as both seconds and something readable', () => {
    expect(stats.uptimeSeconds).toBeGreaterThan(0);
    expect(stats.uptime).toMatch(/\d+[dhm]/);
  });

  it('says where its wattage came from', () => {
    // rapl is measured, tdp is estimated. A figure with neither is a figure
    // nobody should trust, and the page prints the source beside it.
    expect(['rapl', 'nvidia', 'tdp', undefined]).toContain(stats.powerSource);
    if (stats.powerWatts !== undefined) {
      expect(stats.powerWatts).toBeGreaterThan(0);
      expect(stats.powerWatts).toBeLessThan(10_000);
    }
  });

  it('counts disks without confusing platters for flash', () => {
    expect(stats.spinningDisks).toBeGreaterThanOrEqual(0);
    expect(stats.ssdCount).toBeGreaterThanOrEqual(0);
  });

  it('counts the harnesses running right now', () => {
    // This suite runs under one, so the count is at least honest about
    // being a number.
    expect(typeof stats.claudeProcesses).toBe('number');
    expect(stats.harnessCounts).toBeTypeOf('object');
  });

  it('reports an architecture', () => {
    expect(stats.arch).toBeTruthy();
  });
});
