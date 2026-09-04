import { describe, it, expect } from 'vitest';
import {
  CAP_WISDOM, CAP_STORAGE, CAP_EFFICIENCY, CAP_DISTANCE, CAP_DIVERSITY,
  CAP_UPTIME, CAP_GPU,
  memoryScore, wisdomScore, storageScore, efficiencyScore, uptimeScore,
  gpuComputeClass, gpuScore, haversineKm, detectGeoRegion,
  computeEgressGroups, getEffectiveIspCost, nodeTotalWatts, nodeElecMonthly,
  utcToLocalIso,
} from './mesh-score';

/**
 * The Permacomputer Node Score. None of this had a test, because it lived
 * inside a page and could not be reached without rendering one.
 */

describe('the seven lattice', () => {
  it('makes every cap a multiple of seven', () => {
    // The score is a hexagonal lattice: 42, not 40. A stray round number
    // would still look plausible in a diff, which is why this is asserted
    // rather than left to reading.
    for (const cap of [CAP_WISDOM, CAP_STORAGE, CAP_EFFICIENCY, CAP_DISTANCE,
                       CAP_DIVERSITY, CAP_UPTIME, CAP_GPU]) {
      expect(cap % 7).toBe(0);
    }
  });

  it('scores memory in lattice steps and never between them', () => {
    for (const gb of [8, 32, 64, 128, 256, 1024]) {
      expect(memoryScore(gb) % 7).toBe(0);
    }
    expect(memoryScore(16)).toBe(7);
    expect(memoryScore(32)).toBe(14);
    expect(memoryScore(64)).toBe(21);
    expect(memoryScore(128)).toBe(49);
    expect(memoryScore(256)).toBe(77);
  });

  it('scores a GPU on the lattice too, capped at 49', () => {
    for (const model of ['RTX 4090', 'RTX 3090', 'Tesla P40', 'Apple M1', undefined]) {
      expect(gpuComputeClass(model) % 7).toBe(0);
    }
    expect(gpuScore('RTX 4090', 24576).total).toBeLessThanOrEqual(CAP_GPU);
  });
});

describe('wisdomScore', () => {
  it('rewards older silicon, which is the point', () => {
    // Wisdom is the opposite of spec chasing: a machine that still works
    // after a decade has proven something a new one has not.
    expect(wisdomScore(2012)).toBeGreaterThan(wisdomScore(2020));
  });

  it('flattens with age rather than growing without bound', () => {
    // Log curve: a 15-year part must not infinitely out-score a 10-year one.
    const gap = wisdomScore(2010) - wisdomScore(2015);
    expect(gap).toBeLessThan(wisdomScore(2015) - wisdomScore(2024));
    expect(wisdomScore(1990)).toBeLessThanOrEqual(CAP_WISDOM);
  });

  it('scores an unknown CPU zero rather than guessing', () => {
    expect(wisdomScore(undefined)).toBe(0);
    expect(wisdomScore(0)).toBe(0);
  });
});

describe('storageScore', () => {
  it('counts both kinds of disk', () => {
    expect(storageScore(2, 2)).toBe(storageScore(4, 0));
  });

  it('grows on a log scale and stops at its cap', () => {
    expect(storageScore(0, 0)).toBe(0);
    expect(storageScore(0, 1)).toBeGreaterThan(0);
    expect(storageScore(0, 100)).toBeLessThanOrEqual(CAP_STORAGE);
    // Ten times the disks is not ten times the usefulness.
    expect(storageScore(0, 40)).toBeLessThan(storageScore(0, 4) * 10);
  });
});

describe('efficiencyScore', () => {
  it('rewards watts per core, not raw core count', () => {
    expect(efficiencyScore(30, 10).capped).toBeGreaterThan(efficiencyScore(200, 10).capped);
  });

  it('keeps the raw figure beside the capped one', () => {
    // The cap is a soft ceiling on the score, not a claim about the machine,
    // so the uncapped number stays visible on the card.
    const hyperEfficient = efficiencyScore(3, 64);
    expect(hyperEfficient.capped).toBe(CAP_EFFICIENCY);
    expect(hyperEfficient.raw).toBeGreaterThan(CAP_EFFICIENCY);
  });

  it('assumes a poor ratio when it has no reading', () => {
    // Absent data must not read as a perfect score.
    expect(efficiencyScore(0, 0).raw).toBe(efficiencyScore(20, 1).raw);
  });
});

describe('uptimeScore', () => {
  it('stops rewarding uptime once a machine has proven itself', () => {
    const sevenWeeks = uptimeScore(49 * 86400);
    const twoYears = uptimeScore(730 * 86400);
    expect(twoYears).toBe(CAP_UPTIME);
    expect(sevenWeeks).toBeGreaterThan(0);
  });

  it('scores a node that never reported zero', () => {
    expect(uptimeScore(undefined)).toBe(0);
  });
});

describe('gpuComputeClass', () => {
  it('ranks by tensor generation, not by model number', () => {
    expect(gpuComputeClass('NVIDIA GeForce RTX 4090')).toBe(28);
    expect(gpuComputeClass('NVIDIA GeForce RTX 3090')).toBe(21);
    expect(gpuComputeClass('Tesla T4')).toBe(14);
    expect(gpuComputeClass('Tesla P40')).toBe(7);
  });

  it('counts an Apple neural engine as a tensor equivalent', () => {
    expect(gpuComputeClass('Apple M3 Max')).toBe(21);
    expect(gpuComputeClass('Apple M1')).toBe(14);
  });

  it('gives an unrecognised GPU the floor, not zero', () => {
    // Present but unknown is still worth something; absent is not.
    expect(gpuComputeClass('Some Future GPU')).toBe(7);
    expect(gpuComputeClass(undefined)).toBe(0);
  });
});

describe('haversineKm', () => {
  it('measures a known distance', () => {
    // Boston to San Francisco is about 4,300 km.
    const km = haversineKm(42.36, -71.06, 37.77, -122.42);
    expect(km).toBeGreaterThan(4200);
    expect(km).toBeLessThan(4400);
  });

  it('measures nothing between a point and itself', () => {
    expect(haversineKm(42.36, -71.06, 42.36, -71.06)).toBe(0);
  });
});

describe('detectGeoRegion', () => {
  it('places coordinates in their region', () => {
    expect(detectGeoRegion(42.36, -71.06)).toBe('us-east');
    expect(detectGeoRegion(37.77, -122.42)).toBe('us-west');
    expect(detectGeoRegion(51.5, -0.12)).toBe('eu-west');
  });

  it('returns nothing for the middle of an ocean', () => {
    expect(detectGeoRegion(0, -30)).toBeNull();
  });
});

describe('egress grouping', () => {
  const geoip = [
    { hostname: 'alpha', ip: '203.0.113.7' },
    { hostname: 'beta', ip: '203.0.113.7' },
    { hostname: 'gamma', ip: '198.51.100.2' },
  ];

  it('groups nodes that leave through the same pipe', () => {
    const groups = computeEgressGroups(
      [{ hostname: 'alpha' }, { hostname: 'beta' }, { hostname: 'gamma' }], geoip,
    );
    expect(groups.get('203.0.113.7')).toEqual(['alpha', 'beta']);
    expect(groups.get('198.51.100.2')).toEqual(['gamma']);
  });

  it('splits one bill between the nodes actually sharing it', () => {
    // Two machines behind one connection are not two connections, and
    // charging each the full line rate double-counts the mesh's cost.
    const groups = computeEgressGroups(
      [{ hostname: 'alpha' }, { hostname: 'beta' }, { hostname: 'gamma' }], geoip,
    );
    expect(getEffectiveIspCost('alpha', 110, groups)).toBe(55);
    expect(getEffectiveIspCost('gamma', 110, groups)).toBe(110);
  });

  it('keeps a node with no geoip reading in its own group', () => {
    const groups = computeEgressGroups([{ hostname: 'lonely' }], []);
    expect(groups.get('lonely')).toEqual(['lonely']);
  });
});

describe('power and cost', () => {
  it('adds up what a node draws', () => {
    expect(nodeTotalWatts(undefined)).toBe(0);
    expect(nodeTotalWatts({ powerWatts: 60, gpuPowerWatts: 40 })).toBe(100);
  });

  it('prices a month of that draw at the rate for that node', () => {
    const econ = { electricityCostKwh: 0.10 } as never;
    // 100W for 720 hours is 72 kWh, so $7.20 at a dime.
    expect(nodeElecMonthly(econ, { powerWatts: 100 })).toBeCloseTo(7.2, 2);
  });
});

describe('utcToLocalIso', () => {
  it('reads a SQLite timestamp as UTC rather than as local time', () => {
    // SQLite writes "YYYY-MM-DD HH:MM:SS" with no zone marker. Parsing that
    // as local time shifts every mesh chart by the operator's offset.
    expect(utcToLocalIso('2026-09-04 12:00:00').toISOString()).toBe('2026-09-04T12:00:00.000Z');
    expect(utcToLocalIso('2026-09-04 12:00').toISOString()).toBe('2026-09-04T12:00:00.000Z');
  });
});
