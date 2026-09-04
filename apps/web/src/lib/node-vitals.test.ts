import { describe, it, expect } from 'vitest';
import { nodeVitals, nodeMonthlyCost, estimateContainerWatts } from './node-vitals';
import type { NodeEcon } from './mesh-score';

const econ = {
  ispCostMonthly: 110, electricityCostKwh: 0.31, location: '', provider: 'home',
  linkMbps: 100, lat: 0, lon: 0, notes: '',
} as NodeEcon;

describe('nodeVitals', () => {
  it('reads a healthy probe', () => {
    const v = nodeVitals({
      hostname: 'cammy', reachable: true, cpuCores: 32, loadAvg: [8, 6, 4],
      memTotalGB: 377.8, memUsedGB: 94.4, uptime: '10d 0h',
    });
    expect(v.reachable).toBe(true);
    expect(v.loadPct).toBe(25);
    expect(v.memPct).toBe(25);
    expect(v.uptime).toBe('10d 0h');
  });

  it('caps load at 100%, because a card cannot draw more', () => {
    // Load above core count is real and common; a 400%-wide bar is not.
    expect(nodeVitals({ cpuCores: 4, loadAvg: [16] }).loadPct).toBe(100);
  });

  it('reads a node that told us nothing as zeros, not NaN', () => {
    const v = nodeVitals(undefined);
    expect(v.reachable).toBe(false);
    expect(v.cpuCores).toBe(0);
    expect(v.memPct).toBe(0);
    expect(v.loadPct).toBe(0);
    expect(v.name).toBe('?');
  });

  it('counts every harness, not only claude', () => {
    // claudeProcesses is claude-only, so a node running five uncloseai-cli
    // agents reported none until harnessCounts arrived.
    const v = nodeVitals({ harnessCounts: { claude: 2, 'uncloseai-cli': 5 }, claudeProcesses: 2 });
    expect(v.agents).toBe(7);
    expect(v.agentLabel).toBe('2 claude, 5 uncloseai-cli');
  });

  it('falls back to the claude count for a payload recorded before that', () => {
    expect(nodeVitals({ claudeProcesses: 3 }).agents).toBe(3);
  });

  it('shows GPU gauges only for a machine that has one', () => {
    // A CPU-only node reports 0% utilisation, which is not the same as
    // having a card that is idle.
    expect(nodeVitals({ gpuUtil: 0, gpuMemTotalMB: 0 }).hasGpu).toBe(false);
    expect(nodeVitals({ gpuMemTotalMB: 24576 }).hasGpu).toBe(true);
    expect(nodeVitals({ gpuUtil: 45 }).hasGpu).toBe(true);
  });

  it('links to the name SSH knows the node by', () => {
    // The detail page probes over SSH, so the link has to carry the
    // configured name rather than whatever the machine calls itself.
    const v = nodeVitals({ hostname: 'localhost' }, { name: 'cammy', hostname: 'cammy.foxhop.net' });
    expect(v.probeHost).toBe('cammy.foxhop.net');
    expect(v.name).toBe('cammy');
  });
});

describe('nodeMonthlyCost', () => {
  it('adds CPU and GPU watts and prices the month', () => {
    // 300W for 720 hours is 216 kWh, $66.96 at 31c, plus $110 of ISP.
    const cost = nodeMonthlyCost({ powerWatts: 100, gpuPowerWatts: 200 }, econ, 'cammy');
    expect(cost.watts).toBe(300);
    expect(cost.elecMonthly).toBeCloseTo(66.96, 2);
    expect(cost.monthly).toBeCloseTo(176.96, 2);
  });

  it('splits one ISP bill between the nodes sharing the line', () => {
    const groups = new Map([['203.0.113.7', ['cammy', 'guile']]]);
    const cost = nodeMonthlyCost({ powerWatts: 0 }, econ, 'cammy', groups);
    expect(cost.ispMonthly).toBe(55);
    expect(cost.ispShared).toBe(true);
  });

  it('charges the full line to a node that does not share it', () => {
    const groups = new Map([['198.51.100.2', ['guile']]]);
    const cost = nodeMonthlyCost({ powerWatts: 0 }, econ, 'guile', groups);
    expect(cost.ispMonthly).toBe(110);
    expect(cost.ispShared).toBe(false);
  });

  it('says where the wattage came from, including nowhere', () => {
    expect(nodeMonthlyCost({ powerSource: 'rapl' }, econ, 'n').source).toBe('rapl');
    expect(nodeMonthlyCost({ powerSource: 'tdp' }, econ, 'n').source).toBe('tdp');
    expect(nodeMonthlyCost({}, econ, 'n').source).toBe('n/a');
  });

  it('reports no cost per watt rather than dividing by zero', () => {
    const cost = nodeMonthlyCost({ powerWatts: 0 }, econ, 'n');
    expect(cost.perWatt).toBe(0);
    expect(Number.isFinite(cost.monthly)).toBe(true);
  });
});

describe('estimateContainerWatts', () => {
  it('scales with cores and how busy they are', () => {
    const idle = estimateContainerWatts({ cpuCores: 8, loadAvg: [0], memTotalGB: 16 });
    const busy = estimateContainerWatts({ cpuCores: 8, loadAvg: [8], memTotalGB: 16 });
    expect(busy).toBeGreaterThan(idle);
  });

  it('never bills an idle container as free', () => {
    // A container doing nothing still occupies a host that is running. The
    // 20% floor is why the fleet total does not collapse when it is quiet.
    expect(estimateContainerWatts({ cpuCores: 8, loadAvg: [0], memTotalGB: 0 })).toBeGreaterThan(0);
  });

  it('adds the GPU draw the container actually reported', () => {
    const withGpu = estimateContainerWatts({ cpuCores: 4, loadAvg: [1], gpuPowerWatts: 150 });
    const without = estimateContainerWatts({ cpuCores: 4, loadAvg: [1] });
    expect(withGpu - without).toBe(150);
  });

  it('estimates nothing for a container that reported no cores', () => {
    // No probe yet. A guess from no data is worse than an honest zero.
    expect(estimateContainerWatts({ cpuCores: 0 })).toBe(0);
    expect(estimateContainerWatts(undefined)).toBe(0);
  });
});
