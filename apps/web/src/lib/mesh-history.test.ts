import { describe, it, expect } from 'vitest';
import {
  bucketTimestamp, rollupTimeline, decimatePeaks, distinctHostnames,
  type TimelinePoint,
} from './mesh-history';

const row = (over: Partial<Parameters<typeof rollupTimeline>[0][number]> = {}) => ({
  timestamp: '2026-09-04 12:00:00',
  hostname: 'cammy',
  cpu_cores: 8,
  load_avg_1: 2,
  power_watts: 100,
  ...over,
});

describe('bucketTimestamp', () => {
  it('rounds down to the bucket', () => {
    expect(bucketTimestamp('2026-09-04 12:00:07', 15)).toBe('2026-09-04 12:00:00');
    expect(bucketTimestamp('2026-09-04 12:00:29', 15)).toBe('2026-09-04 12:00:15');
  });

  it('reads the timestamp as UTC, which is how SQLite wrote it', () => {
    // Parsing as local time would shift every bucket by the operator's offset.
    expect(bucketTimestamp('2026-09-04 12:00:00', 60)).toBe('2026-09-04 12:00:00');
  });
});

describe('rollupTimeline', () => {
  it('counts a node once per bucket however often it reported', () => {
    // The dashboard POSTs from every open page, so a node lands in a bucket
    // several times. Summing every row multiplies the fleet's wattage by the
    // number of tabs someone happens to have open.
    const [point] = rollupTimeline([
      row({ timestamp: '2026-09-04 12:00:01' }),
      row({ timestamp: '2026-09-04 12:00:06' }),
      row({ timestamp: '2026-09-04 12:00:11' }),
    ]);
    expect(point.nodeCount).toBe(1);
    expect(point.totalWatts).toBe(100);
  });

  it('keeps the last reading in a bucket, rows arriving oldest first', () => {
    const [point] = rollupTimeline([
      row({ power_watts: 100 }),
      row({ timestamp: '2026-09-04 12:00:09', power_watts: 250 }),
    ]);
    expect(point.totalWatts).toBe(250);
  });

  it('adds up the fleet across nodes', () => {
    const [point] = rollupTimeline([
      row({ hostname: 'cammy', power_watts: 100 }),
      row({ hostname: 'guile', power_watts: 150, gpu_power_watts: 200 }),
    ]);
    expect(point.nodeCount).toBe(2);
    expect(point.cpuWatts).toBe(250);
    expect(point.gpuWatts).toBe(200);
    expect(point.totalWatts).toBe(450);
  });

  it('averages load per core, not per node', () => {
    // A 32-core box at load 4 is idle; a 2-core box at load 4 is drowning.
    // Averaging the load figures themselves would call both the same.
    const [point] = rollupTimeline([
      row({ hostname: 'big', cpu_cores: 32, load_avg_1: 4 }),
      row({ hostname: 'small', cpu_cores: 2, load_avg_1: 4 }),
    ]);
    expect(point.totalCores).toBe(34);
    expect(point.avgLoad).toBeCloseTo(8 / 34, 2);
  });

  it('averages GPU use over the machines that have one', () => {
    // Counting the CPU-only nodes as 0% would report a busy GPU as idle.
    const [point] = rollupTimeline([
      row({ hostname: 'gpu', gpu_util: 80, gpu_mem_total_mb: 24576 }),
      row({ hostname: 'cpu-only' }),
    ]);
    expect(point.gpuUtil).toBe(80);
  });

  it('reads agent counts from the claude count for older snapshots', () => {
    const [before] = rollupTimeline([row({ claude_processes: 3 })]);
    expect(before.nodes!.cammy.agents).toBe(3);

    const [after] = rollupTimeline([row({ claude_processes: 3, agent_processes: 7 })]);
    expect(after.nodes!.cammy.agents).toBe(7);
  });

  it('survives harness counts that will not parse', () => {
    const [point] = rollupTimeline([row({ harness_counts: '{ truncated' })]);
    expect(point.nodes!.cammy.harnessCounts).toBeUndefined();
  });

  it('reports nothing for no rows', () => {
    expect(rollupTimeline([])).toEqual([]);
  });
});

describe('decimatePeaks', () => {
  const series = (watts: number[]): TimelinePoint[] =>
    watts.map((w, i) => ({ timestamp: `t${i}`, totalWatts: w } as TimelinePoint));

  it('leaves a series that already fits', () => {
    const s = series([1, 2, 3]);
    expect(decimatePeaks(s, 10)).toBe(s);
  });

  it('keeps the spike rather than averaging it away', () => {
    // The whole reason this chart exists is to show the spike. An average
    // would report the ten-second burst as a barely-raised floor.
    const picked = decimatePeaks(series([10, 10, 900, 10, 10, 10, 10, 10]), 2);
    expect(picked.map((p) => p.totalWatts)).toContain(900);
  });

  it('returns real samples, never a computed one', () => {
    const source = series([5, 9, 3, 7, 1, 8]);
    for (const p of decimatePeaks(source, 3)) {
      expect(source.some((s) => s.timestamp === p.timestamp && s.totalWatts === p.totalWatts)).toBe(true);
    }
  });

  it('holds to the point budget', () => {
    expect(decimatePeaks(series(Array.from({ length: 5646 }, (_, i) => i)), 600)).toHaveLength(600);
  });
});

describe('distinctHostnames', () => {
  it('drops the short name of a host we also have in full', () => {
    // One machine reached two ways is still one machine; offering both
    // splits its own history across two filters.
    expect(distinctHostnames([
      { hostname: 'cammy' }, { hostname: 'cammy.foxhop.net' }, { hostname: 'guile' },
    ])).toEqual(['cammy.foxhop.net', 'guile']);
  });

  it('keeps names that merely start alike', () => {
    expect(distinctHostnames([{ hostname: 'node1' }, { hostname: 'node10' }]))
      .toEqual(['node1', 'node10']);
  });
});
