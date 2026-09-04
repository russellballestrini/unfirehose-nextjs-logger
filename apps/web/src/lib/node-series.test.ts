import { describe, it, expect } from 'vitest';
import { toNodeSeries, seriesBounds } from './node-series';

const snapshot = (timestamp: string, values: Record<string, number>) => ({
  timestamp,
  nodes: { cammy: values, other: { watts: 999 } },
});

const opts = { memTotalGB: 31.3, memCapGB: 32, kwhRate: 0.31 };

describe('toNodeSeries', () => {
  it('keeps only the snapshots that mention this host', () => {
    // A gap in a node's history is missing data. Plotting it as 0W would
    // claim the machine was off.
    const rows = toNodeSeries(
      [snapshot('2026-09-04 12:00:00', { watts: 100 }),
       { timestamp: '2026-09-04 12:01:00', nodes: { other: { watts: 50 } } }],
      'cammy', opts,
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].watts).toBe(100);
  });

  it('splits power so the two lines stack to the total', () => {
    // cpuWatts is what is left after the GPU; adding them must give back
    // the reading rather than counting the GPU twice.
    const [row] = toNodeSeries([snapshot('2026-09-04 12:00:00', { watts: 250, gpuWatts: 180 })], 'cammy', opts);
    expect(row.cpuWatts).toBe(70);
    expect(row.cpuWatts + row.gpuWatts).toBe(row.watts);
  });

  it('prices an hour of that draw', () => {
    // 250W at 31c/kWh is 7.75c an hour.
    const [row] = toNodeSeries([snapshot('2026-09-04 12:00:00', { watts: 250 })], 'cammy', opts);
    expect(row.elecCostPerHour).toBeCloseTo(0.08, 2);
  });

  it('falls back to the claude count for history recorded before agents were counted', () => {
    const [old] = toNodeSeries([snapshot('2026-09-04 12:00:00', { claudes: 3 })], 'cammy', opts);
    expect(old.agents).toBe(3);

    const [now] = toNodeSeries([snapshot('2026-09-04 12:00:00', { claudes: 3, agents: 7 })], 'cammy', opts);
    expect(now.agents).toBe(7);
  });

  it('scales GPU memory to gigabytes at one decimal', () => {
    const [row] = toNodeSeries(
      [snapshot('2026-09-04 12:00:00', { gpuMemUsedMB: 8192, gpuMemTotalMB: 24576 })], 'cammy', opts,
    );
    expect(row.gpuMemUsedGB).toBe(8);
    expect(row.gpuMemTotalGB).toBe(24);
  });

  it('reads timestamps as UTC, which is how SQLite wrote them', () => {
    const [row] = toNodeSeries([snapshot('2026-09-04 12:00:00', { watts: 1 })], 'cammy', opts);
    expect(row.tsMs).toBe(Date.parse('2026-09-04T12:00:00Z'));
  });

  it('carries the memory bounds onto every row, for the chart watermark', () => {
    const [row] = toNodeSeries([snapshot('2026-09-04 12:00:00', { watts: 1 })], 'cammy', opts);
    expect(row.memTotalGB).toBe(31.3);
    expect(row.memCapGB).toBe(32);
  });

  it('reads zeros for fields a snapshot never carried', () => {
    // An older snapshot is missing fields, not reporting nulls; a chart
    // cannot plot undefined.
    const [row] = toNodeSeries([snapshot('2026-09-04 12:00:00', {})], 'cammy', opts);
    for (const key of ['watts', 'gpuWatts', 'load', 'cores', 'memUsedGB', 'gpuUtil']) {
      expect(row[key], key).toBe(0);
    }
  });

  it('returns nothing when there is no timeline yet', () => {
    expect(toNodeSeries(undefined, 'cammy', opts)).toEqual([]);
    expect(toNodeSeries([], 'cammy', opts)).toEqual([]);
  });
});

describe('seriesBounds', () => {
  it('spans first to last', () => {
    expect(seriesBounds([{ tsMs: 10 }, { tsMs: 20 }, { tsMs: 30 }])).toEqual({ min: 10, max: 30 });
  });

  it('reports nothing rather than a zero span for an empty series', () => {
    // A {min: 0, max: 0} would read as real data and send the chart to 1970.
    expect(seriesBounds([])).toBeNull();
  });
});
