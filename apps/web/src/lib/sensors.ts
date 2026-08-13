/**
 * Thermal, fan, and throttle parsing for our node probe.
 *
 * Lives outside the route handler because Next validates the export surface
 * of a `route.ts` — extra named exports there fail our build — and because
 * every rule below encodes a specific piece of real hardware misbehaviour
 * worth pinning with tests rather than rediscovering.
 *
 * Probe emits three sections, all pipe-delimited:
 *   TEMPS     zoneType|millidegrees                     (ACPI thermal zones)
 *   HWMON     chip|key|label|value|crit|max|pwm         (hwmon temps + fans)
 *   THROTTLE  name|value                                (counters + cpufreq)
 */

export interface SensorTemp {
  chip: string;
  key: string;
  label: string;
  tempC: number;
  critC: number | null;
  maxC: number | null;
}

export interface SensorFan {
  chip: string;
  key: string;
  label: string;
  rpm: number;
  pwmPct: number | null;
}

export interface MergedTemp extends SensorTemp {
  name: string;
  source: 'hwmon' | 'acpi';
}

export interface ThermalZone {
  zone: string;
  tempC: number;
}

export interface ThrottleInfo {
  packageCount: number | null;
  coreCount: number | null;
  packageMs: number | null;
  curMhz: number | null;
  maxMhz: number | null;
  minMhz: number | null;
  clockPct: number | null;
}

function round(n: number, d = 1): number {
  const f = Math.pow(10, d);
  return Math.round(n * f) / f;
}

/**
 * A sensor limit is only believable inside the range a silicon die lives in.
 * Real hardware publishes junk here: a ThinkPad T480's nvme reports
 * temp2_max = 65261850 millidegrees, i.e. 65261°C. A sentinel like that
 * flattens every gauge scaled against it, so anything outside 20..150°C is
 * treated as "no limit declared" rather than trusted.
 */
export function sanitizeLimitC(milli: string | undefined): number | null {
  if (!milli) return null;
  const c = parseFloat(milli) / 1000;
  if (!Number.isFinite(c) || c < 20 || c > 150) return null;
  return round(c);
}

/**
 * ACPI thermal zones, as `type|millidegrees` pairs.
 *
 * The previous shape printed every temp then every type as two separate
 * runs and rejoined them by index, which mispaired silently the moment one
 * glob returned fewer lines than the other — a zone can appear or vanish
 * between the two reads.
 */
export function parseTemperatures(raw: string): ThermalZone[] {
  if (!raw || raw === 'none') return [];
  const out: ThermalZone[] = [];
  raw.split('\n').forEach((line, i) => {
    if (!line.includes('|')) return;
    const [type, milli] = line.split('|');
    const tempC = parseFloat(milli) / 1000;
    if (!Number.isFinite(tempC)) return;
    out.push({ zone: type?.trim() || `zone${i}`, tempC: round(tempC) });
  });
  return out;
}

/**
 * hwmon sweep → { temps, fans }.
 *
 * Drops sensors reading exactly 0 or empty: a ThinkPad's `thinkpad` chip
 * exposes temp3..temp8 as unpopulated headers that read 0, and temp2 (GPU)
 * reads empty on a machine with no discrete GPU. Those are absent sensors,
 * not cold ones, and charting them at 0°C buries the real curves.
 */
export function parseHwmon(raw: string): { temps: SensorTemp[]; fans: SensorFan[] } {
  const temps: SensorTemp[] = [];
  const fans: SensorFan[] = [];
  if (!raw || raw === 'none') return { temps, fans };

  for (const line of raw.split('\n')) {
    if (!line.includes('|')) continue;
    const [chip, key, label, value, crit, max, pwm] = line.split('|');
    const v = parseFloat(value);
    if (!Number.isFinite(v) || v === 0) continue;

    if (key?.startsWith('temp')) {
      const tempC = v / 1000;
      if (tempC < -50 || tempC > 200) continue;
      temps.push({
        chip,
        key,
        label: label?.trim() || '',
        tempC: round(tempC),
        critC: sanitizeLimitC(crit),
        maxC: sanitizeLimitC(max),
      });
    } else if (key?.startsWith('fan')) {
      // pwm is 0-255 duty, not a percentage.
      const duty = parseFloat(pwm);
      fans.push({
        chip,
        key,
        label: label?.trim() || '',
        rpm: Math.round(v),
        pwmPct: Number.isFinite(duty) ? round((duty / 255) * 100) : null,
      });
    }
  }
  return { temps, fans };
}

/**
 * Merge hwmon temps with ACPI thermal zones into one list.
 *
 * The two sources overlap — `x86_pkg_temp` and coretemp's `Package id 0`
 * are the same die — but neither is a superset. hwmon alone misses
 * INT3400/SEN1/B0D4; thermal_zone alone misses per-core, nvme, and every
 * label and limit. hwmon wins a collision because it carries the limits.
 */
export function mergeSensors(
  hwmon: { temps: SensorTemp[]; fans: SensorFan[] },
  zones: ThermalZone[],
): { temps: MergedTemp[]; fans: SensorFan[] } {
  const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, '');
  const seen = new Set<string>();
  const temps: MergedTemp[] = hwmon.temps.map(t => {
    const name = t.label || t.chip;
    seen.add(norm(name));
    seen.add(norm(t.chip));
    return { ...t, name, source: 'hwmon' };
  });

  // x86_pkg_temp is coretemp's package sensor under another name. Suppress
  // it only when coretemp already reported a package reading, so a box
  // without coretemp still shows its package zone.
  const hasPkg = hwmon.temps.some(t => /package/i.test(t.label));
  for (const z of zones) {
    if (!z.zone) continue;
    if (hasPkg && norm(z.zone) === 'x86pkgtemp') continue;
    if (seen.has(norm(z.zone))) continue;
    seen.add(norm(z.zone));
    temps.push({
      chip: 'acpi',
      key: z.zone,
      label: z.zone,
      tempC: z.tempC,
      critC: null,
      maxC: null,
      name: z.zone,
      source: 'acpi',
    });
  }
  return { temps, fans: hwmon.fans };
}

/**
 * Throttle counters + current clock.
 *
 * The counts are monotonic since boot, so an absolute value says little on
 * its own (a long-lived ThinkPad sits in the millions). What matters is the
 * delta between two polls — the caller computes that — plus `clockPct`,
 * which is legible alone: a box parked at 61% of rated clock is being held
 * down right now.
 */
export function parseThrottle(raw: string): ThrottleInfo | null {
  if (!raw) return null;
  const kv: Record<string, number> = {};
  for (const line of raw.split('\n')) {
    const [k, v] = line.split('|');
    const n = parseFloat(v);
    if (k && Number.isFinite(n)) kv[k.trim()] = n;
  }
  const curKhz = kv.cur_khz ?? 0;
  const maxKhz = kv.max_khz ?? 0;
  if (!curKhz && !maxKhz && kv.pkg_count === undefined) return null;
  return {
    packageCount: kv.pkg_count ?? null,
    coreCount: kv.core_count ?? null,
    packageMs: kv.pkg_ms ?? null,
    curMhz: curKhz ? Math.round(curKhz / 1000) : null,
    maxMhz: maxKhz ? Math.round(maxKhz / 1000) : null,
    minMhz: kv.min_khz ? Math.round(kv.min_khz / 1000) : null,
    clockPct: curKhz && maxKhz ? round((curKhz / maxKhz) * 100) : null,
  };
}
