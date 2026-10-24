import { describe, it, expect } from 'vitest';
import {
  HARDCODED_DEFAULTS, type NodeEcon,
  getDefaultEcon, applyGeoRegionElectricity, continentOf, computeMeshScore, haversineKm,
} from './mesh-score';

/**
 * The mesh as a whole: what each node defaults to, what rate its region
 * charges, and the fleet-level bonuses computeMeshScore hands the page.
 * mesh-score.test.ts covers the per-node components; this covers how the
 * fleet adds up.
 */

const econ = (over: Partial<NodeEcon> = {}): NodeEcon => ({ ...HARDCODED_DEFAULTS, ...over });

const BOSTON = { lat: 42.36, lon: -71.06 };
const CAMBRIDGE = { lat: 42.37, lon: -71.11 };   // a few km from Boston
const LONDON = { lat: 51.5, lon: -0.12 };
const TOKYO = { lat: 35.68, lon: 139.69 };

describe('getDefaultEcon', () => {
  it('takes each default from settings when set', () => {
    expect(getDefaultEcon({
      mesh_default_isp_cost: '80', mesh_default_electricity_kwh: '0.2',
      mesh_default_provider: 'colo', mesh_default_link_mbps: '1000',
    })).toMatchObject({ ispCostMonthly: 80, electricityCostKwh: 0.2, provider: 'colo', linkMbps: 1000, lat: 0, lon: 0 });
  });

  it('falls back to our built-in defaults for missing or unparseable settings', () => {
    expect(getDefaultEcon(undefined)).toEqual(HARDCODED_DEFAULTS);
    expect(getDefaultEcon({ mesh_default_isp_cost: 'lots' }).ispCostMonthly).toBe(HARDCODED_DEFAULTS.ispCostMonthly);
  });
});

describe('applyGeoRegionElectricity', () => {
  it('leaves a node with no location alone', () => {
    const e = econ();
    expect(applyGeoRegionElectricity(e, { 'mesh_region_electricity_us-east': '0.5' })).toBe(e);
  });

  it('prices a node at its region rate when one is set', () => {
    const out = applyGeoRegionElectricity(econ({ ...BOSTON, electricityCostKwh: 0.3 }), { 'mesh_region_electricity_us-east': '0.25' });
    expect(out.electricityCostKwh).toBe(0.25);
  });

  it('keeps the node rate outside every region, with no region rate, or an unparseable one', () => {
    const mid = econ({ lat: 0, lon: -30, electricityCostKwh: 0.3 });
    expect(applyGeoRegionElectricity(mid, { 'mesh_region_electricity_us-east': '0.25' })).toBe(mid);
    const boston = econ({ ...BOSTON, electricityCostKwh: 0.3 });
    expect(applyGeoRegionElectricity(boston, {})).toBe(boston);
    expect(applyGeoRegionElectricity(boston, { 'mesh_region_electricity_us-east': 'cheap' }).electricityCostKwh).toBe(0.3);
  });
});

describe('continentOf', () => {
  it('boxes the continents', () => {
    expect(continentOf(BOSTON.lat, BOSTON.lon)).toBe('NA');
    expect(continentOf(-23.55, -46.63)).toBe('SA');      // São Paulo
    expect(continentOf(LONDON.lat, LONDON.lon)).toBe('EU');
    expect(continentOf(-1.29, 36.82)).toBe('AF');        // Nairobi
    expect(continentOf(TOKYO.lat, TOKYO.lon)).toBe('AS');
    expect(continentOf(0, -20)).toBe('OTHER');           // mid-Atlantic
  });

  it('reads Oceania as Asia (a known defect, scored that way today)', () => {
    expect(continentOf(-33.87, 151.21)).toBe('AS');      // Sydney
  });
});

describe('computeMeshScore', () => {
  it('scores nothing until a node has a location, but still groups egress', () => {
    const r = computeMeshScore([{ hostname: 'a', econ: econ() }], [{ hostname: 'a', ip: '203.0.113.1' }]);
    expect(r.totalScore).toBe(0);
    expect(r.nodeScores).toEqual([]);
    expect(r.egressGroups.get('203.0.113.1')).toEqual(['a']);
  });

  it('adds a bonus per extra continent and per extra provider, and averages the distances', () => {
    const r = computeMeshScore([
      { hostname: 'bos', econ: econ({ ...BOSTON, provider: 'home' }) },
      { hostname: 'lon', econ: econ({ ...LONDON, provider: 'hetzner' }) },
      { hostname: 'tyo', econ: econ({ ...TOKYO, provider: 'hetzner' }) },
    ]);
    expect(r.geoDiversityBonus).toBe(40);   // three continents
    expect(r.ispDiversityBonus).toBe(10);   // two providers
    const pairs = [
      haversineKm(BOSTON.lat, BOSTON.lon, LONDON.lat, LONDON.lon),
      haversineKm(BOSTON.lat, BOSTON.lon, TOKYO.lat, TOKYO.lon),
      haversineKm(LONDON.lat, LONDON.lon, TOKYO.lat, TOKYO.lon),
    ];
    expect(r.avgDistance).toBe(Math.round(pairs.reduce((a, b) => a + b) / 3));
    expect(r.nodeScores.map((n) => n.hostname)).toEqual(['bos', 'lon', 'tyo']);
    expect(r.sameLocationPenalty).toBe(0);
    expect(r.pipeDiversityBonus).toBe(0);
  });

  it('rewards two pipes at one location and penalises one shared pipe', () => {
    const nodes = [
      { hostname: 'x', econ: econ({ ...BOSTON }) },
      { hostname: 'y', econ: econ({ ...CAMBRIDGE }) },
    ];
    const twoPipes = computeMeshScore(nodes, [{ hostname: 'x', ip: '203.0.113.1' }, { hostname: 'y', ip: '198.51.100.9' }]);
    expect(twoPipes.pipeDiversityBonus).toBe(15);
    expect(twoPipes.sameLocationPenalty).toBe(0);

    const onePipe = computeMeshScore(nodes, [{ hostname: 'x', ip: '203.0.113.1' }, { hostname: 'y', ip: '203.0.113.1' }]);
    expect(onePipe.pipeDiversityBonus).toBe(0);
    expect(onePipe.sameLocationPenalty).toBe(5);
    // ...and that shared pipe is billed once, split between them.
    expect(onePipe.totalIspCost).toBeCloseTo(HARDCODED_DEFAULTS.ispCostMonthly, 6);
    expect(twoPipes.totalIspCost).toBeCloseTo(2 * HARDCODED_DEFAULTS.ispCostMonthly, 6);

    // Unknown egress reads as the same pipe: no evidence of resilience.
    expect(computeMeshScore(nodes).sameLocationPenalty).toBe(5);
  });

  it('prices the fleet draw and derives one blended rate from it', () => {
    const r = computeMeshScore([
      { hostname: 'a', econ: econ({ ...BOSTON, electricityCostKwh: 0.1 }), meshNode: { powerWatts: 100 } },
      { hostname: 'b', econ: econ({ ...LONDON, electricityCostKwh: 0.3 }), meshNode: { powerWatts: 60, gpuPowerWatts: 40 } },
    ]);
    expect(r.totalWatts).toBe(200);
    expect(r.totalGpuWatts).toBe(40);
    // Equal draw at 0.1 and 0.3 blends to 0.2.
    expect(r.blendedKwhRate).toBeCloseTo(0.2, 6);
    expect(r.totalMonthlyCost).toBeCloseTo(r.totalIspCost + r.totalElecCost, 6);
  });
});
