import { int } from '@/lib/num';

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

interface SensorTemp {
  chip: string;
  /** hwmon instance (hwmon0…) — the only thing separating two sockets'
   *  coretemp chips, which otherwise share chip name AND sensor key. */
  instance: string;
  key: string;
  label: string;
  tempC: number;
  critC: number | null;
  maxC: number | null;
  /** Package this sensor's chip reports, from its own "Package id N". */
  socket: number | null;
}

export interface SensorFan {
  chip: string;
  instance: string;
  key: string;
  label: string;
  rpm: number;
  pwmPct: number | null;
}

export interface MergedTemp extends SensorTemp {
  name: string;
  source: 'hwmon' | 'acpi';
}

interface ThermalZone {
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
    const [chip, instance, key, label, value, crit, max, pwm] = line.split('|');
    const v = parseFloat(value);
    if (!Number.isFinite(v) || v === 0) continue;

    if (key?.startsWith('temp')) {
      const tempC = v / 1000;
      if (tempC < -50 || tempC > 200) continue;
      temps.push({
        chip,
        instance: instance || chip,
        key,
        label: label?.trim() || '',
        tempC: round(tempC),
        critC: sanitizeLimitC(crit),
        maxC: sanitizeLimitC(max),
        socket: null,
      });
    } else if (key?.startsWith('fan')) {
      // pwm is 0-255 duty, not a percentage.
      const duty = parseFloat(pwm);
      fans.push({
        chip,
        instance: instance || chip,
        key,
        label: label?.trim() || '',
        rpm: Math.round(v),
        pwmPct: Number.isFinite(duty) ? round((duty / 255) * 100) : null,
      });
    }
  }

  // Each coretemp instance carries exactly one "Package id N", which names
  // the socket every core sensor on that instance belongs to. Without this,
  // socket 1's Core 0 is indistinguishable from socket 0's.
  const socketOfInstance = new Map<string, number>();
  for (const t of temps) {
    const m = /^Package id (\d+)$/.exec(t.label);
    if (m) socketOfInstance.set(t.instance, parseInt(m[1]));
  }
  for (const t of temps) {
    const s = socketOfInstance.get(t.instance);
    if (s !== undefined) t.socket = s;
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
  // On a multi-socket box the same label arrives once per socket, so the
  // socket has to be part of the display name or two real, differently-hot
  // cores render as one.
  const multiSocket = new Set(
    hwmon.temps.map(t => t.socket).filter(s => s !== null),
  ).size > 1;

  const temps: MergedTemp[] = hwmon.temps.map(t => {
    const base = t.label || t.chip;
    const name = multiSocket && t.socket !== null && /^Core \d+$/.test(t.label)
      ? `S${t.socket} ${base}`
      : base;
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
      instance: 'acpi',
      key: z.zone,
      label: z.zone,
      tempC: z.tempC,
      critC: null,
      maxC: null,
      socket: null,
      name: z.zone,
      source: 'acpi',
    });
  }
  return { temps, fans: hwmon.fans };
}

export interface TopoCore {
  coreId: number;
  pkg: number;
  die: number;
  /** Cores sharing this core's cluster cache, as a stable group key. */
  clusterKey: string;
  /** Cores in that cluster — 1 means a private cluster cache. */
  clusterSize: number;
  maxKhz: number | null;
  /** 'P'/'E' only when a machine genuinely has two frequency tiers. */
  tier: 'P' | 'E' | null;
  threads: number[];
}

export interface CpuTopology {
  cores: TopoCore[];
  hybrid: boolean;
  /** Which cache level produced our clustering, for display. */
  clusterLevel: 2 | 3 | null;
  packages: number;
  dies: number;
}


/**
 * CPU topology → physical cores with cluster and tier.
 *
 * Deliberately derived from sysfs rather than a model-name table: every
 * Linux box publishes this, and a lookup table is wrong the day a node we
 * have never seen joins our mesh.
 *
 * Clustering picks whichever cache level actually groups cores. Intel
 * hybrid shares L2 across an E-core quad; AMD keeps L2 private and shares
 * L3 across a CCX. Choosing a level up front would draw one vendor's
 * floorplan correctly and flatten the other's.
 */
export function parseCpuTopology(raw: string): CpuTopology | null {
  if (!raw || raw === 'none') return null;

  const byCore = new Map<string, TopoCore & { l2: string; l3: string }>();
  const pkgs = new Set<number>();
  const dies = new Set<string>();

  for (const line of raw.split('\n')) {
    if (!line.includes('|')) continue;
    const [cpuS, coreS, pkgS, dieS, l2, l3, khzS] = line.split('|');
    const cpu = parseInt(cpuS);
    const coreId = parseInt(coreS);
    if (!Number.isFinite(cpu) || !Number.isFinite(coreId)) continue;
    const pkg = int(pkgS);
    const die = int(dieS);
    const khz = parseFloat(khzS);
    pkgs.add(pkg);
    dies.add(`${pkg}/${die}`);

    // Keyed by package+die+core, NOT core alone. Every socket numbers its
    // cores from 0, so a dual-socket Xeon collapses to a single socket's
    // worth of cores under a coreId-only key — half our fleet's cores
    // silently vanishing.
    const key = `${pkg}/${die}/${coreId}`;
    // Threads collapse onto their physical core — a core has one sensor.
    const existing = byCore.get(key);
    if (existing) {
      existing.threads.push(cpu);
      continue;
    }
    byCore.set(key, {
      coreId, pkg, die,
      clusterKey: '', clusterSize: 1,
      maxKhz: Number.isFinite(khz) ? khz : null,
      tier: null,
      threads: [cpu],
      l2: (l2 || '').trim(),
      l3: (l3 || '').trim(),
    });
  }
  if (!byCore.size) return null;

  const cores = [...byCore.values()].sort(
    (a, b) => a.pkg - b.pkg || a.die - b.die || a.coreId - b.coreId,
  );

  // Count distinct physical cores behind each cache group, at both levels.
  const coresPerGroup = (pick: (c: typeof cores[number]) => string) => {
    const m = new Map<string, Set<string>>();
    for (const c of cores) {
      const k = pick(c);
      if (!k) continue;
      (m.get(k) ?? m.set(k, new Set()).get(k)!).add(`${c.pkg}/${c.die}/${c.coreId}`);
    }
    return m;
  };
  const l2Groups = coresPerGroup(c => c.l2);
  const l3Groups = coresPerGroup(c => c.l3);

  // A level clusters usefully when it puts >1 core in a group AND does not
  // simply swallow every core into one group.
  const useful = (m: Map<string, Set<string>>) =>
    m.size > 1 && [...m.values()].some(s => s.size > 1);

  let clusterLevel: 2 | 3 | null = null;
  let groups: Map<string, Set<string>> | null = null;
  if (useful(l2Groups)) { clusterLevel = 2; groups = l2Groups; }
  else if (useful(l3Groups)) { clusterLevel = 3; groups = l3Groups; }

  for (const c of cores) {
    const key = clusterLevel === 2 ? c.l2 : clusterLevel === 3 ? c.l3 : '';
    c.clusterKey = key ? `${c.pkg}/${c.die}/${key}` : `core${c.pkg}/${c.die}/${c.coreId}`;
    c.clusterSize = groups?.get(key)?.size ?? 1;
  }

  // Two frequency tiers means a hybrid part. One tier (or no cpufreq at
  // all, as under many hypervisors) means every core is peer.
  const freqs = [...new Set(cores.map(c => c.maxKhz).filter((f): f is number => f != null))];
  const hybrid = freqs.length > 1 && Math.max(...freqs) - Math.min(...freqs) > 200_000;
  if (hybrid) {
    // Split on the midpoint of the observed range, not on the top value —
    // a 14900K's two favored cores boost 300MHz above their eight peers and
    // must not become their own tier.
    const mid = (Math.max(...freqs) + Math.min(...freqs)) / 2;
    for (const c of cores) c.tier = c.maxKhz != null && c.maxKhz >= mid ? 'P' : 'E';
  }

  return {
    cores: cores.map(({ l2: _l2, l3: _l3, ...c }) => c),
    hybrid,
    clusterLevel,
    packages: pkgs.size,
    dies: dies.size,
  };
}

/**
 * NVML clock-throttle reasons, as a bitmask off
 * `nvidia-smi --query-gpu=clocks_throttle_reasons.active`.
 *
 * This is the only ground truth for "is this GPU throttling". A GPU running
 * below its max clock is usually just idle or power-managed — inferring
 * throttle from a clock ratio produces exactly the false alarm this decoder
 * exists to replace.
 *
 * GpuIdle and ApplicationsClocksSetting are deliberately NOT treated as
 * throttling: idle is the card resting, and an application clock target is
 * an operator's decision, not the card defending itself.
 */
const NVML_THROTTLE_BITS: Array<[number, string, boolean]> = [
  [0x001, 'idle', false],
  [0x002, 'app clock target', false],
  [0x004, 'sw power cap', true],
  [0x008, 'hw slowdown', true],
  [0x010, 'sync boost', false],
  [0x020, 'sw thermal slowdown', true],
  [0x040, 'hw thermal slowdown', true],
  [0x080, 'hw power brake', true],
  [0x100, 'display clock setting', false],
];

interface GpuThrottleReasons {
  mask: string;
  reasons: string[];
  throttling: boolean;
  thermal: boolean;
}

export function parseGpuThrottleReasons(raw: string | undefined): GpuThrottleReasons | null {
  if (!raw) return null;
  const txt = raw.trim();
  if (!txt || /not supported|n\/a/i.test(txt)) return null;
  // nvidia-smi prints a 64-bit mask, but every reason NVML defines sits in
  // the low bits. Decode the low 32 with plain Number rather than reaching
  // for BigInt, whose literals this project's build target rejects — and
  // whose extra range would buy us nothing here.
  const hex = (txt.startsWith('0x') ? txt.slice(2) : txt).slice(-8);
  if (!/^[0-9a-f]+$/i.test(hex)) return null;
  const bits = parseInt(hex, 16);
  if (!Number.isFinite(bits)) return null;

  const reasons: string[] = [];
  let throttling = false;
  let thermal = false;
  for (const [bit, label, counts] of NVML_THROTTLE_BITS) {
    if ((bits & bit) === 0) continue;
    reasons.push(label);
    if (counts) throttling = true;
    if (counts && label.includes('thermal')) thermal = true;
  }
  return { mask: txt, reasons, throttling, thermal };
}

/**
 * `index,clocks.current,clocks.max,throttle_reasons` — merged onto the main
 * GPU rows by index.
 */
export function parseNvidiaClocks(raw: string) {
  const out = new Map<number, { clockMhz: number | null; clockMaxMhz: number | null; throttle: GpuThrottleReasons | null }>();
  if (!raw || raw === 'none') return out;
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    const p = line.split(',').map(s => s.trim());
    const idx = parseInt(p[0]);
    if (!Number.isFinite(idx)) continue;
    const cur = parseFloat(p[1]);
    const max = parseFloat(p[2]);
    out.set(idx, {
      clockMhz: Number.isFinite(cur) ? cur : null,
      clockMaxMhz: Number.isFinite(max) ? max : null,
      throttle: parseGpuThrottleReasons(p[3]),
    });
  }
  return out;
}

/**
 * CPU throttle counters + current clock.
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
