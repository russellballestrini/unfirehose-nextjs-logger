import { describe, it, expect } from 'vitest';
import {
  parseRemoteProbe, parseCpuModel, countSpinningDisks, memCapGB,
  formatUptime, round, lookupCpuTdp, lookupCpuYear, deduplicateNodes,
  calcNonCpuWatts, countSsds, parseMeminfo, parseLoadavg,
} from './mesh-probe';

/**
 * The wire a real node produces, trimmed. Everything the Permacomputer
 * page shows about a machine — its power draw, its score, its uptime — is
 * computed from this text, and until now none of it could be checked
 * without an SSH connection to a live host. The format is documented in
 * userland/types.ts; the per-userland fixtures live in userland/parse.test.ts.
 */
const probe = ({ rapl = '', gpu = '' } = {}) => [
  'uf=1',
  'os=Linux',
  'userland=linux-gnu',
  'hostname=neoblanka.foxhop.net',
  'now=1789253256',
  'osrel=6.8.0',
  'arch=x86_64',
  'nproc=16',
  'cpu=model name\t: AMD Ryzen 7 5800X 8-Core Processor',
  'mem_total=32791234 kB',
  'mem_avail=20000000 kB',
  'swap_total=8000000 kB',
  'swap_free=7000000 kB',
  'load=0.52 0.41 0.38 1/900 12345',
  'uptime_s=864000.00',
  'DISK sda 1',
  'DISK nvme0n1 0',
  'HPROC fox 1234 2.0 1.0 123456 65432 ?  Sl   09:00   0:12 /home/fox/.local/bin/claude',
  rapl ? `RAPL ${rapl}` : '',
  ...gpu.split('\n').filter(Boolean).map(g => `GPU ${g}`),
  'END',
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

  it('names a CPU from whichever cpuinfo field its architecture uses', () => {
    // aarch64 Pi 4: per-core blocks with no model name, then Hardware
    // (misleadingly BCM2835) and, last, the device-tree Model.
    const pi4 = [
      'processor\t: 0', 'BogoMIPS\t: 108.00', 'CPU implementer\t: 0x41', 'CPU part\t: 0xd08',
      'Hardware\t: BCM2835', 'Revision\t: c03114', 'Model\t\t: Raspberry Pi 4 Model B Rev 1.4',
    ].join('\n');
    expect(parseCpuModel(pi4)).toBe('Raspberry Pi 4 Model B Rev 1.4');
    // A generic ARM server: only implementer + part.
    expect(parseCpuModel('CPU implementer\t: 0x41\nCPU architecture: 8\nCPU part\t: 0xd0c')).toBe('ARM Neoverse N1');
    expect(parseCpuModel('CPU implementer\t: 0xc0\nCPU part\t: 0xac3')).toBe('Ampere Altra');
    // As the remote probe sends it: both fields pasted onto one line.
    expect(parseCpuModel('CPU implementer\t: 0xc0 CPU part\t: 0xac3')).toBe('Ampere Altra');
    expect(parseCpuModel('CPU implementer\t: 0x41\nCPU part\t: 0xfff')).toBe('ARM aarch64 part 0xfff');
    // ppc64le and MIPS.
    expect(parseCpuModel('cpu\t\t: POWER9 (raw), altivec supported\nclock\t\t: 3800.000000MHz')).toBe('POWER9');
    expect(parseCpuModel('cpu model\t\t: Loongson-3A R4 (Loongson-3A4000) @ 1800MHz')).toBe('Loongson-3A R4 (Loongson-3A4000) @ 1800MHz');
    // The remote probe's last-resort line.
    expect(parseCpuModel('model name : unknown')).toBe('unknown');
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

  it('knows the pre-Broadwell mobile suffixes', () => {
    // blanka's i5-3320M had no TDP, so its card priced electricity at $0.
    expect(lookupCpuTdp('Intel(R) Core(TM) i5-3320M CPU @ 2.60GHz')).toBe(35);
    expect(lookupCpuTdp('Intel(R) Core(TM) i7-3520M CPU @ 2.90GHz')).toBe(35);
    expect(lookupCpuTdp('Intel(R) Core(TM) i5-520M CPU @ 2.40GHz')).toBe(35);
    expect(lookupCpuTdp('Intel(R) Core(TM) i7-2670QM CPU @ 2.20GHz')).toBe(45);
    expect(lookupCpuTdp('Intel(R) Core(TM) i7-4700MQ CPU @ 2.40GHz')).toBe(47);
    expect(lookupCpuTdp('Intel(R) Core(TM) i7-4700HQ CPU @ 2.40GHz')).toBe(47);
    expect(lookupCpuTdp('Intel(R) Core(TM) i7-3940XM CPU @ 3.00GHz')).toBe(55);
    expect(lookupCpuTdp('Intel(R) Core(TM) i5-520UM CPU @ 1.07GHz')).toBe(18);
    // A U-series part is still a U-series part.
    expect(lookupCpuTdp('Intel(R) Core(TM) i5-8350U CPU @ 1.70GHz')).toBe(15);
  });

  // Strings verbatim from /proc/cpuinfo where known. Each row is
  // [model, watts, year]; a null year means we do not claim one.
  const CATALOG: [string, number, number | null][] = [
    // Intel Core — every naming era
    ['Intel(R) Core(TM) Ultra 9 285K', 125, 2024],
    ['Intel(R) Core(TM) Ultra 7 265F', 65, 2024],
    ['Intel(R) Core(TM) Ultra 7 258V', 17, 2024],
    ['Intel(R) Core(TM) Ultra 7 155H', 28, 2023],
    ['Intel(R) Core(TM) Ultra 9 185H', 45, 2023],
    ['Intel(R) Core(TM) 7 150U', 15, 2024],
    ['Intel(R) Core(TM) i9-14900K', 125, 2024],
    ['12th Gen Intel(R) Core(TM) i9-12900K', 125, 2022],
    ['Intel(R) Core(TM) i9-9900K CPU @ 3.60GHz', 95, 2018],
    ['Intel(R) Core(TM) i7-4790K CPU @ 4.00GHz', 95, 2013],
    ['Intel(R) Core(TM) i9-10980XE CPU @ 3.00GHz', 140, 2020],
    ['Intel(R) Core(TM) i7-1260P', 28, 2022],
    ['Intel(R) Core(TM) i7-1065G7 CPU @ 1.30GHz', 15, 2020],
    ['Intel(R) Core(TM) i5-8350U CPU @ 1.70GHz', 15, 2018],
    ['Intel(R) Core(TM) i5-3320M CPU @ 2.60GHz', 35, 2012],
    ['Intel(R) Core(TM) i7 CPU         920  @ 2.67GHz', 130, 2009],
    ['Intel(R) Core(TM) i5 CPU       M 520  @ 2.40GHz', 35, 2009],
    ['Intel(R) Core(TM) m3-7Y30 CPU @ 1.00GHz', 5, 2015],
    ['Intel(R) Core(TM)2 Duo CPU     E8400  @ 3.00GHz', 65, 2008],
    ['Intel(R) Core(TM)2 Quad CPU    Q6600  @ 2.40GHz', 95, 2007],
    ['Intel(R) Core(TM)2 Duo CPU     P8400  @ 2.26GHz', 25, 2008],
    ['Genuine Intel(R) CPU           T2300  @ 1.66GHz', 65, null],
    // Intel Xeon — every naming era
    ['Intel(R) Xeon(R) 6980P', 500, 2024],
    ['Intel(R) Xeon(R) Platinum 8592+', 350, 2023],
    ['Intel(R) Xeon(R) Platinum 8375C CPU @ 2.90GHz', 270, 2021],
    ['Intel(R) Xeon(R) Gold 6248R CPU @ 3.00GHz', 150, 2019],
    ['Intel(R) Xeon(R) Silver 4514Y', 150, 2023],
    ['Intel(R) Xeon(R) CPU Max 9480', 350, 2023],
    ['Intel(R) Xeon(R) w9-3495X', 350, 2023],
    ['Intel(R) Xeon(R) W-2295 CPU @ 3.00GHz', 140, 2019],
    ['Intel(R) Xeon(R) W-1290P CPU @ 3.70GHz', 80, 2020],
    ['Intel(R) Xeon(R) CPU E5-2650 v2 @ 2.60GHz', 95, 2013],
    ['Intel(R) Xeon(R) CPU E5-2670 0 @ 2.60GHz', 115, 2012],
    ['Intel(R) Xeon(R) CPU E5-2680 v4 @ 2.40GHz', 105, 2016],
    ['Intel(R) Xeon(R) CPU E7-8890 v4 @ 2.20GHz', 165, 2016],
    ['Intel(R) Xeon(R) CPU E3-1230 v3 @ 3.30GHz', 80, 2013],
    ['Intel(R) Xeon(R) CPU E3-1240L v5 @ 2.10GHz', 25, 2015],
    ['Intel(R) Xeon(R) E-2288G CPU @ 3.70GHz', 80, 2019],
    ['Intel(R) Xeon(R) D-2146NT CPU @ 2.30GHz', 90, 2018],
    ['Intel(R) Xeon(R) CPU D-1541 @ 2.10GHz', 45, 2015],
    ['Intel(R) Xeon(R) CPU           X5650  @ 2.67GHz', 95, 2010],
    ['Intel(R) Xeon(R) CPU           L5640  @ 2.27GHz', 60, 2010],
    ['Intel(R) Xeon(R) CPU           E5520  @ 2.27GHz', 80, 2009],
    ['Intel(R) Xeon(R) CPU           E5450  @ 3.00GHz', 95, 2007],
    // Intel small cores
    ['Intel(R) N100', 6, 2023],
    ['Intel(R) Celeron(R) N5105 @ 2.00GHz', 6, 2021],
    ['Intel(R) Celeron(R) J4125 CPU @ 2.00GHz', 10, 2018],
    ['Intel(R) Pentium(R) Silver N6005 @ 2.00GHz', 10, 2021],
    ['Intel(R) Pentium(R) Gold G6400 CPU @ 4.00GHz', 54, 2021],
    ['Intel(R) Atom(TM) CPU C3758 @ 2.20GHz', 25, 2017],
    ['Intel(R) Atom(TM) CPU  C2750  @ 2.40GHz', 20, 2013],
    ['Intel(R) Atom(TM) CPU N270   @ 1.60GHz', 10, 2010],
    ['Intel(R) Atom(TM) x5-Z8350  CPU @ 1.44GHz', 4, 2016],
    ['Intel(R) Pentium(R) 4 CPU 3.00GHz', 95, 2002],
    // AMD Ryzen — desktop by generation
    ['AMD Ryzen 9 9950X 16-Core Processor', 170, 2024],
    ['AMD Ryzen 9 5950X 16-Core Processor', 105, 2020],
    ['AMD Ryzen 9 7900 12-Core Processor', 65, 2022],
    ['AMD Ryzen 7 9800X3D 8-Core Processor', 120, 2024],
    ['AMD Ryzen 7 5800X 8-Core Processor', 105, 2020],
    ['AMD Ryzen 5 7600X 6-Core Processor', 105, 2022],
    ['AMD Ryzen 5 5600X 6-Core Processor', 65, 2020],
    ['AMD Ryzen 5 5600G with Radeon Graphics', 65, 2020],
    ['AMD Ryzen 5 PRO 4650G with Radeon Graphics', 65, 2020],
    ['AMD Ryzen 3 3200GE with Radeon Vega Graphics', 35, 2019],
    // AMD Ryzen — mobile
    ['AMD Ryzen 7 7840U w/ Radeon 780M Graphics', 15, 2022],
    ['AMD Ryzen 9 7945HX with Radeon Graphics', 55, 2022],
    ['AMD Ryzen 7 8845HS w/ Radeon 780M Graphics', 35, 2024],
    ['AMD Ryzen AI 9 HX 370 w/ Radeon 890M', 55, 2024],
    ['AMD Ryzen AI 7 350 w/ Radeon 860M', 28, 2024],
    ['AMD Ryzen Z1 Extreme', 15, 2023],
    ['AMD Ryzen Embedded V1605B with Radeon Vega Gfx', 25, 2018],
    ['AMD Ryzen 5 PRO 5650U with Radeon Graphics', 15, 2020],
    // AMD Threadripper / EPYC
    ['AMD Ryzen Threadripper PRO 7995WX 96-Cores', 350, 2023],
    ['AMD Ryzen Threadripper 7980X 64-Cores', 350, 2023],
    ['AMD Ryzen Threadripper 3970X 32-Core Processor', 280, 2019],
    ['AMD Ryzen Threadripper 1950X 16-Core Processor', 180, 2017],
    ['AMD EPYC 9755 128-Core Processor', 400, 2024],
    ['AMD EPYC 9355P 32-Core Processor', 280, 2024],
    ['AMD EPYC 9654 96-Core Processor', 360, 2022],
    ['AMD EPYC 9124 16-Core Processor', 200, 2022],
    ['AMD EPYC 8324P 32-Core Processor', 150, 2023],
    ['AMD EPYC 4564P 16-Core Processor', 105, 2024],
    ['AMD EPYC 7773X 64-Core Processor', 280, 2021],
    ['AMD EPYC 7763 64-Core Processor', 225, 2021],
    ['AMD EPYC 7551P 32-Core Processor', 155, 2017],
    ['AMD EPYC 7302 16-Core Processor', 155, 2019],
    ['AMD EPYC 7282 16-Core Processor', 120, 2019],
    ['AMD EPYC 3251 8-Core Processor', 45, 2018],
    // AMD legacy
    ['AMD FX(tm)-8350 Eight-Core Processor', 125, 2012],
    ['AMD Phenom(tm) II X4 955 Processor', 95, 2009],
    ['AMD Athlon(tm) II X2 250 Processor', 65, 2009],
    ['AMD Athlon 3000G with Radeon Vega Graphics', 35, 2019],
    ['AMD Opteron(tm) Processor 6272', 115, 2012],
    ['AMD A10-7850K Radeon R7, 12 Compute Cores 4C+8G', 95, 2015],
    ['AMD E-350 Processor', 18, 2012],
    ['AMD GX-412TC SOC', 6, 2012],
    // Apple
    ['Apple M1', 20, 2020],
    ['Apple M2 Pro', 30, 2022],
    ['Apple M3 Max', 60, 2023],
    ['Apple M4 Ultra', 120, 2024],
    // ARM servers
    ['AmpereOne A192-32X', 350, 2023],
    ['Ampere Altra Max M128-30', 250, 2020],
    ['Neoverse-N1', 60, 2019],
    ['AWS Graviton3', 100, 2021],
    // SBCs — the Model line, and the SoC when that is all there is
    ['Raspberry Pi 5 Model B Rev 1.0', 8, 2023],
    ['Raspberry Pi 4 Model B Rev 1.4', 6, 2019],
    ['Raspberry Pi 3 Model B Plus Rev 1.3', 4, 2016],
    ['Raspberry Pi Zero 2 W Rev 1.0', 2, 2021],
    ['BCM2835', 2, 2012],
    ['Rockchip RK3588', 8, 2022],
    ['Radxa ROCK Pi 4B', 5, null],
    ['Amlogic Meson G12B (A311D) Revision 29:b (10:2)', 4, 2019],
    ['NVIDIA Jetson AGX Orin Developer Kit', 30, 2022],
    ['ARM Cortex-A72', 5, 2015],
    ['ARM Cortex-A53', 3, 2014],
    // Virtual
    ['QEMU Virtual CPU version 2.5+', 65, null],
    ['Common KVM processor', 65, null],
    // Long tail
    ['POWER9 (raw), altivec supported', 190, 2017],
    ['Hygon C86 7285 32-core Processor', 180, 2018],
    ['ZHAOXIN KaiXian KX-6640MA@2.2+GHz', 70, 2019],
    ['HiSilicon Kunpeng 920', 150, 2019],
    ['Loongson-3A5000', 35, 2021],
    ['Phytium D2000/8', 60, 2020],
    ['SiFive U74-MC', 10, 2020],
    ['StarFive JH7110', 5, 2022],
    ['VIA Nano U2250', 15, 2008],
    ['Intel(R) Pentium(R) M processor 1.73GHz', 25, 2004],
  ];

  it('knows the catalog — mainstream first, long tail after', () => {
    const misses = CATALOG
      .map(([m, w, y]) => ({ m, w, y, gotW: lookupCpuTdp(m), gotY: lookupCpuYear(m) }))
      .filter(r => r.gotW !== r.w || r.gotY !== r.y);
    expect(misses).toEqual([]);
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
