import { describe, it, expect } from 'vitest';
import {
  sanitizeLimitC, parseTemperatures, parseHwmon, mergeSensors, parseThrottle,
} from './sensors';

// Verbatim probe output from neoblanka (ThinkPad, i7-8650U) at
// 2026-08-13T18:36Z, captured while the box was thermally saturated.
// Every quirk asserted below is real hardware, not a hypothetical.
const HWMON_FIXTURE = [
  'acpitz|temp1||86000|||',
  'coretemp|temp1|Package id 0|87000|100000|100000|',
  'coretemp|temp2|Core 0|84000|100000|100000|',
  'coretemp|temp3|Core 1|87000|100000|100000|',
  'nvme|temp1|Composite|40850|84850|82850|',
  'nvme|temp2|Sensor 1|41850||65261850|',   // 65261°C max — sentinel garbage
  'pch_skylake|temp1||70000|||',
  'thinkpad|temp1|CPU|86000|||',
  'thinkpad|temp2|GPU||||',                 // empty — no discrete GPU
  'thinkpad|temp3||0|||',                   // unpopulated header
  'thinkpad|temp8||0|||',
  'thinkpad|fan1||3957|||255',
  'iwlwifi_1|temp1||53000|||',
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
    const { fans: f } = parseHwmon('dell_smm|fan1|Processor Fan|2400|||');
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
