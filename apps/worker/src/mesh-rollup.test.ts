import { describe, it, expect, beforeEach } from 'vitest';
import type Database from 'better-sqlite3';
import { createTestDb } from '@unturf/unfirehose/test/db-helper';
import { rollupDrain, measuredEnergy } from './mesh-rollup';

/**
 * Folding 15 s samples into a cold quarter hour keeps the counter-measured
 * energy (ticket 4013): summed joules and a grade, beside the smoothed means.
 */

const RANGE = 262_143_328_850;
let db: Database.Database;
beforeEach(() => { db = createTestDb(); });

const sqlTime = (ms: number) => new Date(ms).toISOString().replace('T', ' ').slice(0, 19);
/** Sixty samples 15 s apart starting at `start`, 80 W CPU and 300 W GPU on the counters. */
function seed(start: number, counters = true) {
  const ins = db.prepare(`INSERT INTO mesh_snapshots (timestamp, hostname, power_watts, gpu_power_watts, cpu_energy_json, gpu_energy_mj) VALUES (?, 'gpu-box', 90, 280, ?, ?)`);
  for (let i = 0; i < 60; i++) {
    ins.run(sqlTime(start + i * 15_000),
      counters ? JSON.stringify([{ uj: 5e9 + i * 1.2e9, max: RANGE }]) : null,
      counters ? 7e9 + i * 4.5e6 : null);
  }
}

describe('measuredEnergy', () => {
  it('sums counter deltas over consecutive samples and grades coverage', () => {
    const rows = Array.from({ length: 4 }, (_, i) => ({
      timestamp: sqlTime(Date.UTC(2026, 8, 1, 0, 0, 15 * i)), gpu_power_watts: 280,
      cpu_energy_json: JSON.stringify([{ uj: i * 1.2e9, max: RANGE }]), gpu_energy_mj: i * 4.5e6,
    }));
    const m = measuredEnergy(rows as never);
    expect(m.wh).toBeCloseTo(3 * (1200 + 4500) / 3600, 9);
    expect(m.gpuWh).toBeCloseTo(3 * 4500 / 3600, 9);
    expect(m.grade).toBe('B');
  });
  it('is unmeasured, grade C, without counters', () => {
    const rows = [0, 1].map((i) => ({ timestamp: sqlTime(Date.UTC(2026, 8, 1, 0, 0, 15 * i)), gpu_power_watts: 280, cpu_energy_json: null, gpu_energy_mj: null }));
    expect(measuredEnergy(rows as never)).toEqual({ wh: null, gpuWh: null, grade: 'C' });
  });
});

describe('rollup keeps measured energy', () => {
  it('writes the bucket\'s measured watt-hours and grade into the cold row', () => {
    // 29 days ago: past the 28-day hot retention, so the bucket folds.
    const start = Math.floor((Date.now() - 29 * 86_400_000) / 900_000) * 900_000;
    seed(start);
    expect(rollupDrain(db, 1)).toBe(1);
    const cold = db.prepare('SELECT measured_wh, measured_gpu_wh, energy_grade, sample_count FROM mesh_snapshots_15m').get() as Record<string, number | string>;
    expect(cold.sample_count).toBe(60);
    expect(cold.energy_grade).toBe('B');
    // 59 intervals of 15 s at 380 W.
    expect(cold.measured_wh as number).toBeCloseTo(59 * 15 * 380 / 3600, 6);
    expect(cold.measured_gpu_wh as number).toBeCloseTo(59 * 15 * 300 / 3600, 6);
  });
  it('leaves them null, grade C, for samples without counters', () => {
    const start = Math.floor((Date.now() - 29 * 86_400_000) / 900_000) * 900_000;
    seed(start, false);
    rollupDrain(db, 1);
    expect(db.prepare('SELECT measured_wh, energy_grade FROM mesh_snapshots_15m').get()).toEqual({ measured_wh: null, energy_grade: 'C' });
  });
});
