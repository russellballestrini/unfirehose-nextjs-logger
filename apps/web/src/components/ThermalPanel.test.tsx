// @vitest-environment jsdom
/**
 * Our thermal panel draws a floorplan of a CPU die from sensor labels.
 *
 * Every layout rule in it exists because some real machine reports its
 * silicon in a way that breaks the obvious drawing: a dual-socket box that
 * numbers both sockets' cores from 0, a Ryzen that publishes one sensor per
 * chiplet and none per core, a hybrid part whose P and E cores must not be
 * mixed into one block. Those are the cases below.
 */

import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import { ThermalPanel } from './ThermalPanel';
import type { MergedTemp, ThrottleInfo, CpuTopology, TopoCore } from '@/lib/sensors';

vi.mock('@/components/UPlotTimeChart', () => ({
  UPlotTimeChart: () => <div data-testid="chart" />,
}));

function temp(label: string, tempC: number, over: Partial<MergedTemp> = {}): MergedTemp {
  return {
    chip: 'coretemp-isa-0000', instance: 'hwmon0',
    key: label.toLowerCase().replace(/\s+/g, '_'),
    label, name: label, tempC, critC: 100, maxC: 80,
    socket: 0, source: 'hwmon', ...over,
  };
}

function topoCore(coreId: number, over: Partial<TopoCore> = {}): TopoCore {
  return {
    coreId, pkg: 0, die: 0, clusterKey: 'l3:0', clusterSize: 1,
    maxKhz: 4_800_000, tier: null, threads: [coreId, coreId + 8], ...over,
  };
}

function topology(cores: TopoCore[], over: Partial<CpuTopology> = {}): CpuTopology {
  return { cores, hybrid: false, clusterLevel: 3, packages: 1, dies: 1, ...over };
}

const THROTTLE: ThrottleInfo = {
  packageCount: 6_200_000, coreCount: 12_000, packageMs: 480,
  curMhz: 3200, maxMhz: 4800, minMhz: 800, clockPct: 67,
};

beforeEach(() => {
  localStorage.clear();
});

// This config does not run testing-library's global cleanup, so a second
// render would leave the first panel's tiles in the document and every
// count below would be a sum of two machines.
afterEach(cleanup);

describe('ThermalPanel', () => {
  it('draws one tile per core, in core order rather than sensor order', () => {
    // hwmon hands back Core 0, Core 10, Core 1… because it sorts its keys as
    // strings. A floorplan in that order is not a floorplan.
    const temps = [0, 10, 1, 2].map(i => temp(`Core ${i}`, 50 + i));
    render(
      <ThermalPanel
        host="cammy" temps={temps} fans={[]} throttle={THROTTLE}
        topology={topology([0, 1, 2, 10].map(i => topoCore(i)))}
      />,
    );
    const tiles = screen.getAllByText(/^c\d+$/).map(el => el.textContent);
    expect(tiles).toEqual(['c0', 'c1', 'c2', 'c10']);
  });

  it('gives each socket its own die', () => {
    // Both sockets number their cores from 0, so a single block would draw
    // two different physical cores on top of each other.
    const temps = [
      ...[0, 1].map(i => temp(`Core ${i}`, 60 + i, { socket: 0, instance: 'hwmon0' })),
      ...[0, 1].map(i => temp(`Core ${i}`, 70 + i, { socket: 1, instance: 'hwmon1' })),
    ];
    render(
      <ThermalPanel host="dual" temps={temps} fans={[]} throttle={null}
        topology={topology([
          topoCore(0), topoCore(1),
          topoCore(0, { pkg: 1 }), topoCore(1, { pkg: 1 }),
        ], { packages: 2 })}
      />,
    );
    expect(screen.getByText('socket 0')).toBeInTheDocument();
    expect(screen.getByText('socket 1')).toBeInTheDocument();
    // Four cores drawn, not two overwritten.
    expect(screen.getAllByText(/^c[01]$/)).toHaveLength(4);
  });

  it('falls back to chiplets when the chip publishes no per-core sensor', () => {
    // AMD's k10temp stops at one Tccd per chiplet. There is no core-level
    // reading to draw, so the die units are the chiplets themselves.
    const temps = [
      temp('Tccd1', 61, { chip: 'k10temp-pci-00c3' }),
      temp('Tccd2', 58, { chip: 'k10temp-pci-00c3' }),
      temp('Tctl', 64, { chip: 'k10temp-pci-00c3' }),
    ];
    render(<ThermalPanel host="ryzen" temps={temps} fans={[]} throttle={null} />);
    expect(screen.getByText(/2 chiplets/)).toBeInTheDocument();
    expect(screen.queryByText(/cpu cores/)).not.toBeInTheDocument();
  });

  it('says nothing about cores on a machine that has no die sensors at all', () => {
    // A Pi or a VM reports one SoC zone and no floorplan is drawable. The
    // panel still has to render its bars rather than throw on an empty die.
    render(
      <ThermalPanel host="vm" temps={[temp('acpitz', 44, { chip: 'acpitz-acpi-0', source: 'acpi', critC: null, maxC: null })]}
        fans={[]} throttle={null} />,
    );
    expect(screen.getByText('Thermal & Cooling')).toBeInTheDocument();
    expect(screen.queryByText(/chiplet/)).not.toBeInTheDocument();
  });

  it('prefers a sensor that declared its own limit when two are near-tied', () => {
    // acpitz is an alias of the same die, graded against our assumed 100°C.
    // Letting it win the headline over coretemp's real Tjmax reports the
    // same silicon through the less trustworthy of two sensors.
    render(
      <ThermalPanel host="tie" fans={[]} throttle={null}
        temps={[
          temp('acpitz', 82, { chip: 'acpitz-acpi-0', source: 'acpi', critC: null, maxC: null }),
          temp('Package id 0', 81),
        ]}
      />,
    );
    // The headline reads the cooler of the two, because that is the one
    // whose ceiling the chip actually declared.
    expect(screen.getByText('81.0°C')).toBeInTheDocument();
    expect(screen.getByText(/Package id 0 · 81% of 100°$/)).toBeInTheDocument();
  });

  it('names the card, not the CPU, when a GPU reports an active throttle', () => {
    // NVML's bitmask is ground truth for the card and says nothing about the
    // package. An unqualified badge would read as a claim about both.
    render(
      <ThermalPanel host="gpubox" temps={[temp('Core 0', 55)]} fans={[]} throttle={THROTTLE}
        gpus={[{
          index: 0, name: 'NVIDIA GeForce RTX 3090', tempC: 78, gpuUtil: 99, memUtil: 60,
          memTotalMB: 24576, memUsedMB: 14000, powerDrawW: 350, powerLimitW: 350,
          fanPct: 80, pstate: 'P0', clockMhz: 1600, clockMaxMhz: 1950,
          throttle: { mask: '0x4', reasons: ['SwPowerCap'], throttling: true, thermal: false },
        }]}
      />,
    );
    expect(screen.getByText(/POWER CAP/)).toBeInTheDocument();
    expect(screen.queryByText(/CPU THROTTLING NOW/)).not.toBeInTheDocument();
  });

  it('keeps P and E cores in separate clusters on a hybrid part', () => {
    // Their frequency ceilings differ by GHz, so one block of tiles graded
    // together makes an idle P core and a pinned E core look alike.
    const temps = [0, 1, 2, 3].map(i => temp(`Core ${i}`, 50 + i * 4));
    render(
      <ThermalPanel host="hybrid" temps={temps} fans={[]} throttle={null}
        topology={topology([
          topoCore(0, { tier: 'P', clusterKey: 'l2:0' }),
          topoCore(1, { tier: 'P', clusterKey: 'l2:1' }),
          topoCore(2, { tier: 'E', clusterKey: 'l2:2', clusterSize: 2, maxKhz: 3_600_000 }),
          topoCore(3, { tier: 'E', clusterKey: 'l2:2', clusterSize: 2, maxKhz: 3_600_000 }),
        ], { hybrid: true, clusterLevel: 2 })}
      />,
    );
    expect(screen.getAllByText(/^c[0-3]$/)).toHaveLength(4);
    expect(screen.getByText(/4 cpu cores/)).toBeInTheDocument();
  });
});
