import { describe, it, expect } from 'vitest';
import { counterDeltaWh, measuredIntervalWh, parseCpuEnergyJson, gradeFor } from './energy-counters';

const RANGE = 262_143_328_850; // the 4090 and 3090 boxes, max_energy_range_uj

describe('counterDeltaWh', () => {
  it('turns a RAPL delta into watt-hours exactly', () => {
    // 80 W for 15 s = 1,200 J = 1.2e9 µJ
    const r = counterDeltaWh({ cpu: [{ uj: 1e9, max: RANGE }] }, { cpu: [{ uj: 2.2e9, max: RANGE }] });
    expect(r.cpuWh).toBeCloseTo(1200 / 3600, 9);
    expect(r.gpuWh).toBeNull();
  });

  it('adds the range once when a package wrapped mid-interval', () => {
    const r = counterDeltaWh({ cpu: [{ uj: RANGE - 500e6, max: RANGE }] }, { cpu: [{ uj: 700e6, max: RANGE }] });
    expect(r.cpuWh).toBeCloseTo(1200e6 / 3.6e9, 9);
  });

  it('sums two sockets, each with its own wrap', () => {
    const r = counterDeltaWh(
      { cpu: [{ uj: 10e9, max: RANGE }, { uj: RANGE - 100e6, max: RANGE }] },
      { cpu: [{ uj: 11e9, max: RANGE }, { uj: 100e6, max: RANGE }] },
    );
    expect(r.cpuWh).toBeCloseTo((1e9 + 200e6) / 3.6e9, 9);
  });

  it('refuses a package list that changed shape', () => {
    expect(counterDeltaWh({ cpu: [{ uj: 1, max: RANGE }] }, { cpu: [{ uj: 2, max: RANGE }, { uj: 3, max: RANGE }] }).cpuWh).toBeNull();
    expect(counterDeltaWh({ cpu: null }, { cpu: [{ uj: 2, max: RANGE }] }).cpuWh).toBeNull();
  });

  it('turns an NVML delta into watt-hours and treats a backwards step as a driver reload', () => {
    // 300 W for 15 s = 4,500 J = 4.5e6 mJ
    expect(counterDeltaWh({ gpuMj: 1e9 }, { gpuMj: 1e9 + 4.5e6 }).gpuWh).toBeCloseTo(4500 / 3600, 9);
    expect(counterDeltaWh({ gpuMj: 1e9 }, { gpuMj: 5 }).gpuWh).toBeNull();
  });
});

describe('a counter reset is not a wrap (4013 item 7)', () => {
  const pkg = (uj: number) => ({ uj, max: RANGE });
  // neoblanka, 2026-10-31 17:37: 16.1 kJ -> 0.48 kJ across a 129 s reboot on a
  // 36 W box, which the wrap rule had read as 246 kJ, 1.9 kW, 68 Wh.
  it('a reboot inside the interval, told by uptime, is unmeasured', () => {
    expect(counterDeltaWh({ cpu: [pkg(16.086e9)], uptimeS: 500_000 }, { cpu: [pkg(0.48e9)], uptimeS: 40 }, 129).cpuWh).toBeNull();
    expect(counterDeltaWh({ cpu: [pkg(16.086e9)] }, { cpu: [pkg(0.48e9)], uptimeS: 40 }, 129).cpuWh).toBeNull();
  });
  it('every package stepping back at once is a reset; one of two wrapping is not', () => {
    expect(counterDeltaWh({ cpu: [pkg(16.086e9), pkg(83.8e9)] }, { cpu: [pkg(0.48e9), pkg(1.428e9)] }, 129).cpuWh).toBeNull();
    const one = counterDeltaWh({ cpu: [pkg(RANGE - 500e6), pkg(10e9)] }, { cpu: [pkg(700e6), pkg(11e9)] }, 15);
    expect(one.cpuWh).toBeCloseTo((1200e6 + 1e9) / 3.6e9, 9);
  });
  it('a wrapped delta far above the sampled draw is a reset; a plausible one is a wrap', () => {
    expect(counterDeltaWh({ cpu: [pkg(16.086e9)], watts: 36 }, { cpu: [pkg(0.48e9)], watts: 39 }, 129).cpuWh).toBeNull();
    expect(counterDeltaWh({ cpu: [pkg(RANGE - 500e6)], watts: 90 }, { cpu: [pkg(700e6)], watts: 90 }, 15).cpuWh).toBeCloseTo(1200e6 / 3.6e9, 9);
  });
  it('with no sampled draw, a kilowatt per package is the line', () => {
    expect(counterDeltaWh({ cpu: [pkg(16.086e9)] }, { cpu: [pkg(0.48e9)] }, 129).cpuWh).toBeNull();
    expect(counterDeltaWh({ cpu: [pkg(RANGE - 500e6)] }, { cpu: [pkg(700e6)] }, 15).cpuWh).toBeCloseTo(1200e6 / 3.6e9, 9);
  });
  it('an uptime of zero means unknown, not a reboot', () => {
    expect(counterDeltaWh({ cpu: [pkg(RANGE - 500e6)], uptimeS: 0 }, { cpu: [pkg(700e6)], uptimeS: 0 }, 15).cpuWh).toBeCloseTo(1200e6 / 3.6e9, 9);
  });
  it('without an interval length the wrap rule stands as before', () => {
    expect(counterDeltaWh({ cpu: [pkg(RANGE - 500e6)] }, { cpu: [pkg(700e6)] }).cpuWh).toBeCloseTo(1200e6 / 3.6e9, 9);
  });
  it('measuredIntervalWh carries the interval through', () => {
    expect(measuredIntervalWh({ cpu: [pkg(16.086e9)], gpuWatts: 0, watts: 36 }, { cpu: [pkg(0.48e9)], gpuWatts: 0, watts: 39 }, 129)).toBeNull();
  });
});

describe('measuredIntervalWh', () => {
  const cpu = (uj: number) => [{ uj, max: RANGE }];
  it('needs both counters on a box that reports GPU power', () => {
    expect(measuredIntervalWh({ cpu: cpu(0), gpuWatts: 300 }, { cpu: cpu(1.2e9), gpuWatts: 300 })).toBeNull();
    const m = measuredIntervalWh({ cpu: cpu(0), gpuMj: 0, gpuWatts: 300 }, { cpu: cpu(1.2e9), gpuMj: 4.5e6, gpuWatts: 300 });
    expect(m?.wh).toBeCloseTo((1200 + 4500) / 3600, 9);
    expect(m?.gpuWh).toBeCloseTo(4500 / 3600, 9);
  });
  it('is RAPL alone on a box with no GPU', () => {
    const m = measuredIntervalWh({ cpu: cpu(0), gpuWatts: 0 }, { cpu: cpu(1.2e9), gpuWatts: 0 });
    expect(m).toEqual({ wh: 1200 / 3600, gpuWh: 0 });
  });
});

describe('parseCpuEnergyJson and gradeFor', () => {
  it('reads the column and rejects garbage', () => {
    expect(parseCpuEnergyJson('[{"uj":1100,"max":5}]')).toEqual([{ uj: 1100, max: 5 }]);
    expect(parseCpuEnergyJson('[{"uj":"x"}]')).toBeNull();
    expect(parseCpuEnergyJson(null)).toBeNull();
    expect(parseCpuEnergyJson('nope')).toBeNull();
  });
  it('grades by coverage of sampled time', () => {
    expect(gradeFor(0.25, 0.25)).toBe('B');
    expect(gradeFor(0.24, 0.25)).toBe('B');
    expect(gradeFor(0.2, 0.25)).toBe('C');
    expect(gradeFor(0, 0)).toBe('C');
  });
});
