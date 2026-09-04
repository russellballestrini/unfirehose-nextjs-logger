import { describe, it, expect } from 'vitest';
import {
  parseRemoteProbe, parseCpuModel, countSpinningDisks, memCapGB,
  formatUptime, round, lookupCpuTdp, lookupCpuYear, deduplicateNodes,
  calcNonCpuWatts, countSsds, parseMeminfo, parseLoadavg,
} from './mesh-probe';

/**
 * The probe output a real node produces, trimmed. Everything the
 * Permacomputer page shows about a machine — its power draw, its score, its
 * uptime — is computed from this text, and until now none of it could be
 * checked without an SSH connection to a live host.
 */
const probe = ({ rapl = '', gpu = '' } = {}) => [
  'neoblanka.foxhop.net',
  '16',
  'model name\t: AMD Ryzen 7 5800X 8-Core Processor',
  'x86_64',
  'NAME TYPE SIZE ROTA',
  'sda  disk 3.6T    1',
  'nvme0n1 disk 1.8T 0',
  '---LSBLK_END---',
  'MemTotal:       32791234 kB',
  'MemAvailable:   20000000 kB',
  'SwapTotal:       8000000 kB',
  'SwapFree:        7000000 kB',
  '0.52 0.41 0.38 1/900 12345',
  '864000.00 6000000.00',
  'HPROC fox 1234 2.0 1.0 123456 65432 ?  Sl   09:00   0:12 /home/fox/.local/bin/claude',
  '---STATS_END---',
  rapl,
  '---RAPL_END---',
  gpu,
  '---GPU_END---',
].join('\n');

describe('parseRemoteProbe', () => {
  it('reads a machine out of its own output', () => {
    const node = parseRemoteProbe('neoblanka', probe());

    expect(node.reachable).toBe(true);
    expect(node.cpuCores).toBe(16);
    expect(node.cpuModel).toBe('AMD Ryzen 7 5800X 8-Core Processor');
    expect(node.arch).toBe('x86_64');
    expect(node.spinningDisks).toBe(1);
    expect(node.ssdCount).toBe(1);
    expect(node.loadAvg).toEqual([0.52, 0.41, 0.38]);
    expect(node.uptimeSeconds).toBe(864000);
    expect(node.uptime).toBe('10d 0h');
  });

  it('prefers the name our SSH config uses when it carries a domain', () => {
    // Everything else keys on the configured name, so a machine reporting a
    // different FQDN must not split into two nodes.
    expect(parseRemoteProbe('cammy.foxhop.net', probe()).hostname).toBe('cammy.foxhop.net');
    // Bare name, machine knows its domain: take the machine's.
    expect(parseRemoteProbe('cammy', probe()).hostname).toBe('neoblanka.foxhop.net');
  });

  it('reports memory as used and available, not just total', () => {
    const node = parseRemoteProbe('n', probe());
    expect(node.memTotalGB).toBeCloseTo(31.3, 1);
    expect(node.memAvailableGB).toBeCloseTo(19.1, 1);
    expect(node.memUsedGB).toBeCloseTo(12.2, 1);
    expect(node.swapUsedGB).toBeCloseTo(1, 1);
  });

  it('turns RAPL energy counters into watts', () => {
    // Two readings 100ms apart, in microjoules: 2,000,000 uJ over 0.1s is 20W
    // on the package, plus what the rest of the machine draws.
    const node = parseRemoteProbe('n', probe({ rapl: '1000000 0 3000000 0' }));
    expect(node.powerSource).toBe('rapl');
    expect(node.powerWatts).toBeGreaterThan(20);
  });

  it('survives a counter that wrapped between readings', () => {
    // energy_uj is 32-bit and rolls over. Read naively that is a huge
    // negative delta, and a negative wattage on the mesh page.
    const node = parseRemoteProbe('n', probe({ rapl: `${2 ** 32 - 1000000} 0 1000000 0` }));
    expect(node.powerWatts).toBeGreaterThan(0);
  });

  it('adds up every GPU rather than reporting the first', () => {
    const node = parseRemoteProbe('n', probe({
      gpu: '150.5, NVIDIA GeForce RTX 3090, 24576, 8192, 45\n120.0, NVIDIA GeForce RTX 3090, 24576, 4096, 30',
    }));
    expect(node.gpuPowerWatts).toBeCloseTo(270.5, 1);
    expect(node.gpuModel).toContain('3090');
    expect(node.gpuUtil).toBe(45);
  });

  it('falls back to TDP when the machine reports no counters', () => {
    const node = parseRemoteProbe('n', probe());
    expect(node.powerSource).toBe('tdp');
    expect(node.powerWatts).toBeGreaterThan(0);
  });

  it('counts the harnesses it found running', () => {
    expect(parseRemoteProbe('n', probe()).claudeProcesses).toBe(1);
  });
});

describe('memCapGB', () => {
  it('rounds the kernel figure up to a real DIMM size', () => {
    // /proc/meminfo reports usable RAM, short of the DIMMs by reserved
    // regions — 31.3GB of hardware 32GB.
    expect(memCapGB(31.3)).toBe(32);
    expect(memCapGB(125.8)).toBe(128);
  });

  it('stops rounding once the next power of two is more than half again', () => {
    // The guard is a ratio, not a list of sizes: 40GB would have to become
    // 64 to be a power of two, which is 1.6x, so it is left alone.
    expect(memCapGB(40)).toBe(40);
    // 94GB does round to 128, at 1.36x — the doc comment's "96GB stays 96"
    // is not what the 1.5x rule actually does, and this records which one
    // is true.
    expect(memCapGB(94)).toBe(128);
  });
});

describe('the small parsers', () => {
  it('takes the model name out of a cpuinfo line', () => {
    expect(parseCpuModel('model name\t: Intel(R) Xeon(R) CPU E5-2680 v4'))
      .toBe('Intel(R) Xeon(R) CPU E5-2680 v4');
    expect(parseCpuModel('nothing useful')).toBeNull();
  });

  it('counts only spinning disks, by their rotational flag', () => {
    const lsblk = 'NAME TYPE SIZE ROTA\nsda disk 3.6T 1\nsdb disk 3.6T 1\nnvme0n1 disk 1.8T 0';
    expect(countSpinningDisks(lsblk)).toBe(2);
  });

  it('counts flash and platters as a pair, by the same flag', () => {
    const lsblk = 'NAME TYPE SIZE ROTA\nsda disk 3.6T 1\nnvme0n1 disk 1.8T 0\nnvme1n1 disk 1.8T 0';
    expect(countSpinningDisks(lsblk)).toBe(1);
    expect(countSsds(lsblk)).toBe(2);
  });

  it('reads meminfo in gigabytes, though the file speaks kilobytes', () => {
    const mem = parseMeminfo([
      'MemTotal:       32791234 kB',
      'MemAvailable:   20000000 kB',
      'SwapTotal:       8000000 kB',
      'SwapFree:        7000000 kB',
    ].join('\n'));
    expect(mem.totalGB).toBeCloseTo(31.3, 1);
    expect(mem.availableGB).toBeCloseTo(19.1, 1);
    expect(mem.swapTotalGB).toBeCloseTo(7.6, 1);
  });

  it('reads a missing meminfo field as zero rather than NaN', () => {
    // A container without swap has no SwapTotal line, and NaN would reach
    // the page as a blank where a number belongs.
    expect(parseMeminfo('MemTotal: 1048576 kB')).toEqual({
      totalGB: 1, availableGB: 0, swapTotalGB: 0, swapFreeGB: 0,
    });
  });

  it('takes the three figures at the head of loadavg', () => {
    expect(parseLoadavg('0.52 0.41 0.38 1/900 12345')).toEqual([0.52, 0.41, 0.38]);
    expect(parseLoadavg('')).toEqual([0, 0, 0]);
  });

  it('formats uptime at the scale a reader cares about', () => {
    expect(formatUptime(90)).toBe('1m');
    expect(formatUptime(3700)).toBe('1h 1m');
    expect(formatUptime(200000)).toBe('2d 7h');
  });

  it('keeps one decimal, which is all a watt reading is worth', () => {
    expect(round(12.34)).toBe(12.3);
    expect(round(12.35)).toBe(12.4);
  });

  it('knows a CPU by its family, and admits when it does not', () => {
    expect(lookupCpuTdp('AMD Ryzen 7 5800X 8-Core Processor')).toBeGreaterThan(0);
    expect(lookupCpuYear('AMD Ryzen 7 5800X 8-Core Processor')).toBeGreaterThan(2000);
    expect(lookupCpuTdp('Totally Fictional CPU')).toBeNull();
    expect(lookupCpuYear('Totally Fictional CPU')).toBeNull();
  });

  it('charges for the RAM and disks the CPU figure leaves out', () => {
    // RAPL measures the package only; DIMMs, spindles and PSU loss are real
    // watts the wall meter sees.
    const bare = calcNonCpuWatts({
      memTotalGB: 8, spinningDisks: 0, ssdCount: 1, isServer: false, isLaptop: true,
    });
    const loaded = calcNonCpuWatts({
      memTotalGB: 128, spinningDisks: 4, ssdCount: 2, isServer: true, isLaptop: false,
    });
    expect(bare).toBeGreaterThan(0);
    expect(loaded).toBeGreaterThan(bare);
  });
});

describe('deduplicateNodes', () => {
  it('keeps one entry per machine when two names resolve to it', () => {
    const nodes = deduplicateNodes([
      { hostname: 'cammy.foxhop.net', reachable: true, cpuCores: 8 },
      { hostname: 'cammy.foxhop.net', reachable: false },
    ]);
    expect(nodes).toHaveLength(1);
    expect(nodes[0].reachable).toBe(true);
  });
});
