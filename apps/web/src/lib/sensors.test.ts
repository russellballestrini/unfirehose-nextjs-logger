import { describe, it, expect } from 'vitest';
import {
  sanitizeLimitC, parseTemperatures, parseHwmon, mergeSensors, parseThrottle,
  parseGpuThrottleReasons, parseNvidiaClocks, parseCpuTopology,
} from './sensors';

// Verbatim probe output from neoblanka (ThinkPad, i7-8650U) at
// 2026-08-13T18:36Z, captured while the box was thermally saturated.
// Every quirk asserted below is real hardware, not a hypothetical.
const HWMON_FIXTURE = [
  'acpitz|hwmon1|temp1||86000|||',
  'coretemp|hwmon10|temp1|Package id 0|87000|100000|100000|',
  'coretemp|hwmon10|temp2|Core 0|84000|100000|100000|',
  'coretemp|hwmon10|temp3|Core 1|87000|100000|100000|',
  'nvme|hwmon4|temp1|Composite|40850|84850|82850|',
  'nvme|hwmon4|temp2|Sensor 1|41850||65261850|',   // 65261°C max — sentinel garbage
  'pch_skylake|hwmon7|temp1||70000|||',
  'thinkpad|hwmon8|temp1|CPU|86000|||',
  'thinkpad|hwmon8|temp2|GPU||||',                 // empty — no discrete GPU
  'thinkpad|hwmon8|temp3||0|||',                   // unpopulated header
  'thinkpad|hwmon8|temp8||0|||',
  'thinkpad|hwmon8|fan1||3957|||255',
  'iwlwifi_1|hwmon9|temp1||53000|||',
].join('\n');

const TEMPS_FIXTURE = [
  'acpitz|86000',
  'INT3400 Thermal|20000',
  'SEN1|49100',
  'pch_skylake|70000',
  'B0D4|83100',
  'iwlwifi_1|53000',
  'x86_pkg_temp|87000',
].join('\n');

const THROTTLE_FIXTURE = [
  'pkg_count|6286594',
  'core_count|2407753',
  'pkg_ms|87142392',
  'cur_khz|2199802',
  'max_khz|3600000',
  'min_khz|400000',
].join('\n');

describe('sanitizeLimitC', () => {
  it('accepts a plausible silicon limit', () => {
    expect(sanitizeLimitC('100000')).toBe(100);
    expect(sanitizeLimitC('84850')).toBe(84.9);
  });

  it('rejects the nvme 65261C sentinel', () => {
    expect(sanitizeLimitC('65261850')).toBeNull();
  });

  it('rejects limits below a temperature silicon could crit at', () => {
    expect(sanitizeLimitC('19000')).toBeNull();
  });

  it('treats missing or unparseable input as no declared limit', () => {
    expect(sanitizeLimitC('')).toBeNull();
    expect(sanitizeLimitC(undefined)).toBeNull();
    expect(sanitizeLimitC('nonsense')).toBeNull();
  });
});

describe('parseTemperatures', () => {
  it('pairs each zone with its own reading', () => {
    const zones = parseTemperatures(TEMPS_FIXTURE);
    expect(zones).toHaveLength(7);
    expect(zones[0]).toEqual({ zone: 'acpitz', tempC: 86 });
    expect(zones.find(z => z.zone === 'B0D4')?.tempC).toBe(83.1);
  });

  it('does not mispair when a zone reports no temperature', () => {
    // The old index-rejoin shape shifted every subsequent zone by one here.
    const zones = parseTemperatures('acpitz|86000\nSEN1|\nB0D4|83100');
    expect(zones).toEqual([
      { zone: 'acpitz', tempC: 86 },
      { zone: 'B0D4', tempC: 83.1 },
    ]);
  });

  it('returns empty for an absent section', () => {
    expect(parseTemperatures('')).toEqual([]);
    expect(parseTemperatures('none')).toEqual([]);
  });
});

describe('parseHwmon', () => {
  const { temps, fans } = parseHwmon(HWMON_FIXTURE);

  it('reads per-core temps that thermal_zone never exposed', () => {
    expect(temps.find(t => t.label === 'Core 0')?.tempC).toBe(84);
    expect(temps.find(t => t.label === 'Package id 0')?.critC).toBe(100);
  });

  it('drops phantom sensors reading zero or empty', () => {
    const thinkpad = temps.filter(t => t.chip === 'thinkpad');
    expect(thinkpad.map(t => t.label)).toEqual(['CPU']);
  });

  it('keeps a real reading while rejecting its garbage limit', () => {
    const s1 = temps.find(t => t.label === 'Sensor 1');
    expect(s1?.tempC).toBe(41.9);
    expect(s1?.maxC).toBeNull();
  });

  it('reads fan RPM and converts pwm duty out of 255', () => {
    expect(fans).toHaveLength(1);
    expect(fans[0].rpm).toBe(3957);
    expect(fans[0].pwmPct).toBe(100);
  });

  it('reports no pwm rather than 0% when the chip publishes none', () => {
    const { fans: f } = parseHwmon('dell_smm|hwmon0|fan1|Processor Fan|2400|||');
    expect(f[0].pwmPct).toBeNull();
    expect(f[0].label).toBe('Processor Fan');
  });

  it('returns empty for an absent section', () => {
    expect(parseHwmon('none')).toEqual({ temps: [], fans: [] });
  });
});

describe('mergeSensors', () => {
  const merged = mergeSensors(parseHwmon(HWMON_FIXTURE), parseTemperatures(TEMPS_FIXTURE));

  it('keeps ACPI zones that hwmon does not mirror', () => {
    const names = merged.temps.map(t => t.name);
    expect(names).toContain('INT3400 Thermal');
    expect(names).toContain('SEN1');
    expect(names).toContain('B0D4');
  });

  it('suppresses x86_pkg_temp when coretemp already reported the package', () => {
    expect(merged.temps.map(t => t.name)).not.toContain('x86_pkg_temp');
    expect(merged.temps.find(t => t.name === 'Package id 0')).toBeDefined();
  });

  it('keeps x86_pkg_temp on a box with no coretemp to shadow it', () => {
    const solo = mergeSensors(parseHwmon('none'), parseTemperatures('x86_pkg_temp|87000'));
    expect(solo.temps.map(t => t.name)).toEqual(['x86_pkg_temp']);
  });

  it('does not duplicate a chip present in both sources', () => {
    const acpitz = merged.temps.filter(t => t.name === 'acpitz');
    expect(acpitz).toHaveLength(1);
    expect(acpitz[0].source).toBe('hwmon');
  });

  it('labels every entry with the source it came from', () => {
    expect(merged.temps.find(t => t.name === 'Core 0')?.source).toBe('hwmon');
    expect(merged.temps.find(t => t.name === 'SEN1')?.source).toBe('acpi');
  });
});

describe('parseThrottle', () => {
  it('reports the clock as a fraction of rated max', () => {
    const t = parseThrottle(THROTTLE_FIXTURE)!;
    expect(t.curMhz).toBe(2200);
    expect(t.maxMhz).toBe(3600);
    expect(t.clockPct).toBe(61.1);
  });

  it('carries the cumulative counters through', () => {
    const t = parseThrottle(THROTTLE_FIXTURE)!;
    expect(t.packageCount).toBe(6286594);
    expect(t.packageMs).toBe(87142392);
  });

  it('returns null when a box exposes no counters or cpufreq', () => {
    expect(parseThrottle('')).toBeNull();
    expect(parseThrottle('pkg_count|\ncur_khz|\nmax_khz|')).toBeNull();
  });

  it('omits clockPct rather than dividing by a missing max', () => {
    const t = parseThrottle('pkg_count|12\ncur_khz|2000000\nmax_khz|')!;
    expect(t.packageCount).toBe(12);
    expect(t.clockPct).toBeNull();
  });
});

describe('parseGpuThrottleReasons', () => {
  it('reads a clean card as not throttling', () => {
    // Verbatim from 4090-ai while the card ran 99% util at 70°C.
    const r = parseGpuThrottleReasons('0x0000000000000000')!;
    expect(r.throttling).toBe(false);
    expect(r.thermal).toBe(false);
    expect(r.reasons).toEqual([]);
  });

  it('does not call an idle card throttled', () => {
    // GpuIdle. A resting card is not a card defending itself, and treating
    // it as throttling is precisely the false alarm this decoder replaces.
    const r = parseGpuThrottleReasons('0x0000000000000001')!;
    expect(r.reasons).toEqual(['idle']);
    expect(r.throttling).toBe(false);
  });

  it('does not call an operator-set clock target throttled', () => {
    const r = parseGpuThrottleReasons('0x0000000000000002')!;
    expect(r.throttling).toBe(false);
  });

  it('flags thermal slowdown as both throttling and thermal', () => {
    const sw = parseGpuThrottleReasons('0x0000000000000020')!;
    expect(sw.throttling).toBe(true);
    expect(sw.thermal).toBe(true);
    const hw = parseGpuThrottleReasons('0x0000000000000040')!;
    expect(hw.thermal).toBe(true);
  });

  it('separates a power cap from a thermal cap', () => {
    const r = parseGpuThrottleReasons('0x0000000000000004')!;
    expect(r.throttling).toBe(true);
    expect(r.thermal).toBe(false);
    expect(r.reasons).toContain('sw power cap');
  });

  it('decodes several simultaneous reasons', () => {
    // 0x45 = idle (0x01) + sw power cap (0x04) + hw thermal slowdown (0x40)
    const r = parseGpuThrottleReasons('0x0000000000000045')!;
    expect(r.reasons).toEqual(['idle', 'sw power cap', 'hw thermal slowdown']);
    expect(r.throttling).toBe(true);
    expect(r.thermal).toBe(true);
  });

  it('returns null when a driver does not report the field', () => {
    expect(parseGpuThrottleReasons(undefined)).toBeNull();
    expect(parseGpuThrottleReasons('')).toBeNull();
    expect(parseGpuThrottleReasons('[Not Supported]')).toBeNull();
    expect(parseGpuThrottleReasons('[N/A]')).toBeNull();
    expect(parseGpuThrottleReasons('garbage')).toBeNull();
  });
});

describe('parseNvidiaClocks', () => {
  it('keys clocks and throttle state by GPU index', () => {
    const m = parseNvidiaClocks('0, 2760, 3150, 0x0000000000000000\n1, 1400, 1980, 0x0000000000000040');
    expect(m.get(0)).toMatchObject({ clockMhz: 2760, clockMaxMhz: 3150 });
    expect(m.get(0)!.throttle!.throttling).toBe(false);
    expect(m.get(1)!.throttle!.thermal).toBe(true);
  });

  it('survives a driver that omits the throttle field', () => {
    const m = parseNvidiaClocks('0, 2760, 3150, [Not Supported]');
    expect(m.get(0)!.clockMhz).toBe(2760);
    expect(m.get(0)!.throttle).toBeNull();
  });

  it('returns an empty map when nvidia-smi is absent', () => {
    expect(parseNvidiaClocks('none').size).toBe(0);
    expect(parseNvidiaClocks('').size).toBe(0);
  });
});

describe('parseCpuTopology', () => {
  // Verbatim from 4090-ai (i9-14900K): 8 P-cores each on a private L2,
  // 16 E-cores in 4 quads sharing L2. Core IDs step by 4 then run contiguous.
  const RAPTOR = [
    '0|0|0|0|0-1||5700000', '1|0|0|0|0-1||5700000',
    '2|4|0|0|2-3||5700000', '3|4|0|0|2-3||5700000',
    '4|8|0|0|4-5||5700000', '5|8|0|0|4-5||5700000',
    '6|12|0|0|6-7||5700000', '7|12|0|0|6-7||5700000',
    '8|16|0|0|8-9||6000000', '9|16|0|0|8-9||6000000',
    '10|20|0|0|10-11||6000000', '11|20|0|0|10-11||6000000',
    '12|24|0|0|12-13||5700000', '13|24|0|0|12-13||5700000',
    '14|28|0|0|14-15||5700000', '15|28|0|0|14-15||5700000',
    '16|32|0|0|16-19||4400000', '17|33|0|0|16-19||4400000',
    '18|34|0|0|16-19||4400000', '19|35|0|0|16-19||4400000',
    '20|36|0|0|20-23||4400000', '21|37|0|0|20-23||4400000',
    '22|38|0|0|20-23||4400000', '23|39|0|0|20-23||4400000',
    '24|40|0|0|24-27||4400000', '25|41|0|0|24-27||4400000',
    '26|42|0|0|24-27||4400000', '27|43|0|0|24-27||4400000',
    '28|44|0|0|28-31||4400000', '29|45|0|0|28-31||4400000',
    '30|46|0|0|28-31||4400000', '31|47|0|0|28-31||4400000',
  ].join('\n');

  // Verbatim from neoblanka (i5-8350U): homogeneous quad, SMT pairs.
  const KABY = [
    '0|0|0|0|0,4||3600000', '1|1|0|0|1,5||3600000',
    '2|2|0|0|2,6||3600000', '3|3|0|0|3,7||3600000',
    '4|0|0|0|0,4||3600000', '5|1|0|0|1,5||3600000',
    '6|2|0|0|2,6||3600000', '7|3|0|0|3,7||3600000',
  ].join('\n');

  it('collapses SMT threads onto their physical core', () => {
    const t = parseCpuTopology(KABY)!;
    expect(t.cores).toHaveLength(4);
    expect(t.cores[0].threads).toEqual([0, 4]);
  });

  it('reads a homogeneous part as non-hybrid with no tiers', () => {
    const t = parseCpuTopology(KABY)!;
    expect(t.hybrid).toBe(false);
    expect(t.cores.every(c => c.tier === null)).toBe(true);
    expect(t.cores.every(c => c.clusterSize === 1)).toBe(true);
  });

  it('splits a hybrid part into P and E tiers', () => {
    const t = parseCpuTopology(RAPTOR)!;
    expect(t.hybrid).toBe(true);
    const p = t.cores.filter(c => c.tier === 'P');
    const e = t.cores.filter(c => c.tier === 'E');
    expect(p).toHaveLength(8);
    expect(e).toHaveLength(16);
  });

  it('does not split favored boost cores into their own tier', () => {
    // Two 14900K P-cores rate 6.0GHz against their peers' 5.7. Splitting on
    // the top value instead of the range midpoint would make those a tier.
    const t = parseCpuTopology(RAPTOR)!;
    const favored = t.cores.filter(c => c.maxKhz === 6_000_000);
    expect(favored).toHaveLength(2);
    expect(favored.every(c => c.tier === 'P')).toBe(true);
  });

  it('clusters E-cores into shared-L2 quads and leaves P-cores private', () => {
    const t = parseCpuTopology(RAPTOR)!;
    expect(t.clusterLevel).toBe(2);
    expect(t.cores.filter(c => c.tier === 'P').every(c => c.clusterSize === 1)).toBe(true);
    const eClusters = new Set(t.cores.filter(c => c.tier === 'E').map(c => c.clusterKey));
    expect(eClusters.size).toBe(4);
    expect(t.cores.filter(c => c.tier === 'E').every(c => c.clusterSize === 4)).toBe(true);
  });

  it('clusters on L3 when L2 is private, as AMD reports it', () => {
    // Zen: L2 per core, L3 shared across a CCX. Two CCXs of 2 cores here.
    const zen = [
      '0|0|0|0|0-1|0-3|4200000', '1|0|0|0|0-1|0-3|4200000',
      '2|1|0|0|2-3|0-3|4200000', '3|1|0|0|2-3|0-3|4200000',
      '4|2|0|1|4-5|4-7|4200000', '5|2|0|1|4-5|4-7|4200000',
      '6|3|0|1|6-7|4-7|4200000', '7|3|0|1|6-7|4-7|4200000',
    ].join('\n');
    const t = parseCpuTopology(zen)!;
    // L2 groups exist but hold one core each, so L3 is what actually clusters.
    expect(t.clusterLevel).toBe(3);
    expect(t.cores.every(c => c.clusterSize === 2)).toBe(true);
    expect(new Set(t.cores.map(c => c.clusterKey)).size).toBe(2);
    expect(t.dies).toBe(2);
  });

  it('survives a machine with no cpufreq, as under a hypervisor', () => {
    const vm = ['0|0|0|0|||', '1|1|0|0|||'].join('\n');
    const t = parseCpuTopology(vm)!;
    expect(t.cores).toHaveLength(2);
    expect(t.hybrid).toBe(false);
    expect(t.cores[0].maxKhz).toBeNull();
    expect(t.clusterLevel).toBeNull();
  });

  it('counts packages on a multi-socket box', () => {
    const dual = ['0|0|0|0|0|0-1|3000000', '1|0|1|0|1|0-1|3000000'].join('\n');
    expect(parseCpuTopology(dual)!.packages).toBe(2);
  });

  it('returns null when a node reports no topology at all', () => {
    expect(parseCpuTopology('')).toBeNull();
    expect(parseCpuTopology('none')).toBeNull();
  });
});

describe('dual-socket boxes', () => {
  // cammy/guile shape: two Xeon E5 sockets, each with its OWN coretemp chip
  // publishing Package id N and Core 0..7. Chip name and sensor key are
  // identical across both — only the hwmon instance separates them.
  const DUAL_HWMON = [
    'coretemp|hwmon0|temp1|Package id 0|52000|85000|85000|',
    'coretemp|hwmon0|temp2|Core 0|51000|85000|85000|',
    'coretemp|hwmon0|temp3|Core 1|49000|85000|85000|',
    'coretemp|hwmon1|temp1|Package id 1|43000|85000|85000|',
    'coretemp|hwmon1|temp2|Core 0|40000|85000|85000|',
    'coretemp|hwmon1|temp3|Core 1|42000|85000|85000|',
  ].join('\n');

  it('keeps both sockets\' cores instead of collapsing them', () => {
    const { temps } = parseHwmon(DUAL_HWMON);
    expect(temps.filter(t => t.label === 'Core 0')).toHaveLength(2);
  });

  it('attributes each sensor to the socket its own chip reports', () => {
    const { temps } = parseHwmon(DUAL_HWMON);
    const c0 = temps.filter(t => t.label === 'Core 0');
    expect(c0.map(t => t.socket).sort()).toEqual([0, 1]);
    // Same label, genuinely different temperatures — collapsing them would
    // have thrown away an 11°C difference between sockets.
    expect(c0.map(t => t.tempC).sort()).toEqual([40, 51]);
  });

  it('gives same-labelled cores distinct display names', () => {
    const merged = mergeSensors(parseHwmon(DUAL_HWMON), []);
    const names = merged.temps.filter(t => /Core 0/.test(t.name)).map(t => t.name);
    expect(names.sort()).toEqual(['S0 Core 0', 'S1 Core 0']);
  });

  it('leaves a single-socket box\'s names unprefixed', () => {
    const merged = mergeSensors(parseHwmon(HWMON_FIXTURE), []);
    expect(merged.temps.find(t => t.label === 'Core 0')?.name).toBe('Core 0');
  });

  it('counts every core across sockets, not one socket\'s worth', () => {
    // Both sockets number their cores from 0. Keying topology by coreId
    // alone silently halved an entire dual-socket machine.
    const dual = [
      '0|0|0|0|0|0-7|2600000', '1|1|0|0|1|0-7|2600000',
      '2|0|1|0|2|8-15|2600000', '3|1|1|0|3|8-15|2600000',
    ].join('\n');
    const t = parseCpuTopology(dual)!;
    expect(t.cores).toHaveLength(4);
    expect(t.packages).toBe(2);
    expect(t.cores.filter(c => c.pkg === 0)).toHaveLength(2);
    expect(t.cores.filter(c => c.pkg === 1)).toHaveLength(2);
  });
});

describe('non-Intel and non-x86 hosts', () => {
  // Ryzen 9 7950X. k10temp publishes Tctl plus one Tccd per chiplet, and
  // NO per-core temperature — that granularity does not exist on AMD.
  const AMD_HWMON = [
    'k10temp|hwmon3|temp1|Tctl|61000|||',
    'k10temp|hwmon3|temp2|Tccd1|58000|||',
    'k10temp|hwmon3|temp3|Tccd2|56000|||',
  ].join('\n');

  it('reads AMD chip sensors without inventing cores', () => {
    const { temps } = parseHwmon(AMD_HWMON);
    expect(temps.map(t => t.label)).toEqual(['Tctl', 'Tccd1', 'Tccd2']);
    // The floorplan keys off this; AMD legitimately has nothing here.
    expect(temps.filter(t => /^Core \d+$/.test(t.label))).toHaveLength(0);
    // Chiplets are what AMD does expose, and they are real physical units.
    expect(temps.filter(t => /^Tccd\d+$/.test(t.label))).toHaveLength(2);
  });

  it('clusters an AMD CCX on L3 where L2 is private', () => {
    const zen = [
      '0|0|0|0|0-1|0-15|5700000', '1|0|0|0|0-1|0-15|5700000',
      '2|1|0|0|2-3|0-15|5700000', '3|1|0|0|2-3|0-15|5700000',
      '4|2|0|1|4-5|16-31|5700000', '5|2|0|1|4-5|16-31|5700000',
    ].join('\n');
    const t = parseCpuTopology(zen)!;
    expect(t.clusterLevel).toBe(3);
    expect(t.dies).toBe(2);
    expect(t.hybrid).toBe(false);
  });

  // Raspberry Pi 5: one SoC-wide thermal zone, no coretemp, no hwmon cores.
  it('reads a Pi as a single SoC zone with no floorplan', () => {
    const m = mergeSensors(parseHwmon(''), parseTemperatures('cpu-thermal|47000'));
    expect(m.temps).toEqual([
      expect.objectContaining({ name: 'cpu-thermal', tempC: 47, source: 'acpi' }),
    ]);
    expect(m.temps.filter(t => /^Core \d+$/.test(t.label))).toHaveLength(0);
  });

  it('reads ARM topology without pretending one shared L3 is a cluster', () => {
    // Pi 5: four Cortex-A76, private L2, one L3 spanning all of them. A
    // single group covering every core is not a clustering, it is the chip.
    const pi = [
      '0|0|0|0|0|0-3|2400000', '1|1|0|0|1|0-3|2400000',
      '2|2|0|0|2|0-3|2400000', '3|3|0|0|3|0-3|2400000',
    ].join('\n');
    const t = parseCpuTopology(pi)!;
    expect(t.cores).toHaveLength(4);
    expect(t.clusterLevel).toBeNull();
    expect(t.cores.every(c => c.clusterSize === 1)).toBe(true);
    expect(t.hybrid).toBe(false);
  });

  it('splits an ARM big.LITTLE part on frequency like any hybrid', () => {
    // A Pi-class SoC with two core types, e.g. an RK3588 4×A76 + 4×A55.
    const bigLittle = [
      '0|0|0|0|0|0-3|2400000', '1|1|0|0|1|0-3|2400000',
      '2|2|0|0|2|4-7|1800000', '3|3|0|0|3|4-7|1800000',
    ].join('\n');
    const t = parseCpuTopology(bigLittle)!;
    expect(t.hybrid).toBe(true);
    expect(t.cores.filter(c => c.tier === 'P')).toHaveLength(2);
    expect(t.cores.filter(c => c.tier === 'E')).toHaveLength(2);
  });

  it('omits x86 throttle counters an ARM board never exposes', () => {
    // No thermal_throttle sysfs on ARM; cpufreq still reports clocks.
    const t = parseThrottle('pkg_count|\ncore_count|\npkg_ms|\ncur_khz|1500000\nmax_khz|2400000\nmin_khz|1000000')!;
    expect(t.packageCount).toBeNull();
    expect(t.clockPct).toBe(62.5);
  });
});
