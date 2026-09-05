/* eslint-disable @typescript-eslint/no-explicit-any */
import { parseHarnessProcesses, countByHarness } from '@unturf/unfirehose/harness-procs';
import {
  parseTemperatures, parseHwmon, mergeSensors, parseThrottle,
  parseNvidiaClocks, parseCpuTopology,
} from '@/lib/sensors';
import { num, int } from '@/lib/num';

/**
 * Parsers for our node probe's output.
 *
 * The probe runs a dozen commands over one SSH connection and returns their
 * output as a single stream split by markers. Everything a node detail page
 * shows comes out of these functions, so they carry the format quirks:
 * nvidia-smi printing an NVML driver-mismatch error into the same stream, a
 * ps command that itself contains spaces, a container name that does too.
 *
 * They live here rather than beside the handler because Next validates the
 * export surface of a `route.ts` — a named export there is a build error,
 * which also means anything defined there is unreachable from a test.
 */

export const SECTION_MARKERS = [
  'HOSTNAME', 'CPUINFO', 'ARCH', 'KERNEL', 'OS', 'NPROC', 'MEMINFO',
  'LOADAVG', 'UPTIME', 'DISK', 'PS', 'CLAUDE_PS', 'NVIDIA', 'NVIDIA_PS',
  'AMD_GPU', 'TEMPS', 'HWMON', 'THROTTLE', 'CPUTOPO', 'NVIDIA_CLOCKS', 'NET', 'NETSTAT', 'IOSTAT', 'DOCKER', 'TMUX', 'SCREEN', 'END',
];

export function parseSection(output: string, marker: string): string {
  const tag = `===SECTION:${marker}===`;
  const start = output.indexOf(tag);
  if (start === -1) return '';
  const afterMarker = output.indexOf('\n', start);
  if (afterMarker === -1) return '';
  // Find the next known section marker
  let end = output.length;
  for (const m of SECTION_MARKERS) {
    if (m === marker) continue;
    const idx = output.indexOf(`\n===SECTION:${m}===`, afterMarker);
    if (idx !== -1 && idx < end) end = idx;
  }
  return output.slice(afterMarker + 1, end).trim();
}

function round(n: number, d = 1): number {
  const f = Math.pow(10, d);
  return Math.round(n * f) / f;
}

export function parseCpuInfo(raw: string) {
  const model = raw.match(/model name\s*:\s*(.+)/i)?.[1]?.trim() ?? 'Unknown';
  const mhz = raw.match(/cpu MHz\s*:\s*([\d.]+)/i)?.[1];
  const cacheSize = raw.match(/cache size\s*:\s*(.+)/i)?.[1]?.trim();
  return { model, mhz: mhz ? parseFloat(mhz) : undefined, cacheSize };
}

export function parseMeminfo(raw: string) {
  const get = (key: string) => parseInt(raw.match(new RegExp(`${key}:\\s+(\\d+)`))?.[1] ?? '0') / 1024 / 1024;
  return {
    totalGB: round(get('MemTotal')),
    availableGB: round(get('MemAvailable')),
    usedGB: round(get('MemTotal') - get('MemAvailable')),
    buffersGB: round(get('Buffers')),
    cachedGB: round(get('Cached')),
    swapTotalGB: round(get('SwapTotal')),
    swapUsedGB: round(get('SwapTotal') - get('SwapFree')),
    swapCachedGB: round(get('SwapCached')),
    shmemGB: round(get('Shmem')),
    sreclaimableGB: round(get('SReclaimable')),
    dirtyMB: round(parseInt(raw.match(/Dirty:\s+(\d+)/)?.[1] ?? '0') / 1024, 0),
  };
}

export function parseProcesses(raw: string) {
  if (!raw || raw === 'n/a') return [];
  const lines = raw.split('\n').filter(l => l.trim());
  if (lines.length < 2) return [];
  // Skip header line
  return lines.slice(1).map(line => {
    const parts = line.trim().split(/\s+/);
    if (parts.length < 11) return null;
    return {
      user: parts[0],
      pid: parseInt(parts[1]),
      cpu: parseFloat(parts[2]),
      mem: parseFloat(parts[3]),
      vsz: parseInt(parts[4]),
      rss: parseInt(parts[5]),
      tty: parts[6],
      stat: parts[7],
      start: parts[8],
      time: parts[9],
      command: parts.slice(10).join(' '),
    };
  }).filter(Boolean);
}


export function parseNvidiaGpu(raw: string) {
  if (!raw || raw === 'none') return [];
  return raw.split('\n').filter(l => l.trim()).map(line => {
    const p = line.split(',').map(s => s.trim());
    if (p.length < 12) return null;
    return {
      index: parseInt(p[0]),
      name: p[1],
      tempC: num(p[2]),
      gpuUtil: num(p[3]),
      memUtil: num(p[4]),
      memTotalMB: num(p[5]),
      memUsedMB: num(p[6]),
      memFreeMB: num(p[7]),
      powerDrawW: num(p[8]),
      powerLimitW: num(p[9]),
      fanPct: num(p[10]),
      pstate: p[11],
    };
  }).filter(Boolean);
}

export function parseNvidiaProcesses(raw: string) {
  if (!raw || raw === 'none') return [];
  return raw.split('\n').filter(l => l.trim()).map(line => {
    const p = line.split(',').map(s => s.trim());
    if (p.length < 3) return null;
    return { pid: parseInt(p[0]), name: p[1], memMB: num(p[2]) };
  }).filter(Boolean);
}

export function parseAmdGpu(raw: string) {
  if (!raw || raw === 'none') return [];
  const lines = raw.split('\n').filter(l => l.trim());
  if (lines.length < 2) return [];
  const headers = lines[0].split(',').map(s => s.trim().toLowerCase());
  return lines.slice(1).map(line => {
    const vals = line.split(',').map(s => s.trim());
    const obj: Record<string, string> = {};
    headers.forEach((h, i) => { obj[h] = vals[i] ?? ''; });
    return obj;
  });
}

export function parseDisk(raw: string) {
  if (!raw || raw === 'n/a') return [];
  return raw.split('\n').filter(l => l.trim()).map(line => {
    const parts = line.trim().split(/\s+/);
    if (parts.length < 6) return null;
    return {
      device: parts[0],
      size: parts[1],
      used: parts[2],
      avail: parts[3],
      usePct: int(parts[4]),
      mount: parts[5],
    };
  }).filter(Boolean);
}

export function parseNetInterfaces(raw: string) {
  if (!raw || raw === 'n/a') return [];
  return raw.split('\n').filter(l => l.trim()).map(line => {
    const parts = line.trim().split(/\s+/);
    return { name: parts[0], state: parts[1], addrs: parts.slice(2).join(' ') };
  });
}

export function parseNetDev(raw: string) {
  if (!raw || raw === 'n/a') return [];
  return raw.split('\n').filter(l => l.trim()).map(line => {
    const parts = line.trim().split(/[:\s]+/);
    if (parts.length < 17) return null;
    return {
      iface: parts[0],
      rxBytes: int(parts[1]),
      rxPackets: int(parts[2]),
      txBytes: int(parts[9]),
      txPackets: int(parts[10]),
    };
  }).filter(Boolean).filter(n => n!.rxBytes > 0 || n!.txBytes > 0);
}

export function parseDocker(raw: string) {
  if (!raw || raw === 'none') return [];
  return raw.split('\n').filter(l => l.trim()).map(line => {
    const parts = line.split('\t');
    // Ports is EMPTY for a --network host container, so its line ends
    // in a tab -- and parseSection trims the section, which eats the
    // trailing tab of the LAST line only. Requiring five fields
    // therefore dropped exactly one container, always the last one
    // listed, on any host running host-network containers. Observed
    // 2026-09-05: a fleet of eight rendered as seven.
    //
    // Ports is the only optional field, so four is the real minimum
    // and the fifth defaults to absent rather than deciding the row
    // is unreadable.
    if (parts.length < 4) return null;
    return {
      id: parts[0], name: parts[1], image: parts[2], status: parts[3],
      ports: parts[4] ?? '',
    };
  }).filter(Boolean);
}

export function parseTmux(raw: string) {
  if (!raw || raw === 'none') return [];
  return raw.split('\n').filter(l => l.trim()).map(line => {
    const m = line.match(/^(\S+):\s+(\d+)\s+window/);
    return m ? { name: m[1], windows: parseInt(m[2]) } : null;
  }).filter(Boolean);
}

export function parseScreen(raw: string) {
  if (!raw || raw === 'none') return [];
  return raw.split('\n').filter(l => l.trim()).map(line => {
    const m = line.trim().match(/^(\d+)\.(\S+)/);
    return m ? { pid: m[1], name: m[2] } : null;
  }).filter(Boolean);
}


/**
 * One probe's output, as the object a node page renders.
 *
 * Every section above is read here exactly once, so a marker that moves
 * or a command that changed its format shows up as one field going quiet
 * rather than as a page that fails.
 */
export function parseProbeOutput(raw: string, host: string) {
  const hostname = parseSection(raw, 'HOSTNAME') || host;
  const cpuInfo = parseCpuInfo(parseSection(raw, 'CPUINFO'));
  const arch = parseSection(raw, 'ARCH') || 'unknown';
  const kernel = parseSection(raw, 'KERNEL') || 'unknown';
  const osRaw = parseSection(raw, 'OS');
  const osName = osRaw.match(/PRETTY_NAME="?([^"\n]+)"?/)?.[1] ?? 'Linux';
  const cpuCores = int(parseSection(raw, 'NPROC'));
  const memory = parseMeminfo(parseSection(raw, 'MEMINFO'));

  const loadRaw = parseSection(raw, 'LOADAVG').split(/\s+/);
  const loadAvg = [num(loadRaw[0]), num(loadRaw[1]), num(loadRaw[2])];
  const runnable = loadRaw[3] ?? '0/0';

  const uptimeRaw = parseSection(raw, 'UPTIME').split(/\s+/);
  const uptimeSeconds = num(uptimeRaw[0]);

  const disk = parseDisk(parseSection(raw, 'DISK'));
  const processes = parseProcesses(parseSection(raw, 'PS'));
  // Named CLAUDE_PS for wire compatibility; it carries every harness now.
  const harnessProcesses = parseHarnessProcesses(parseSection(raw, 'CLAUDE_PS'));
  const harnessCounts = countByHarness(harnessProcesses);
  // claudeProcesses stays claude-only so existing callers keep their meaning.
  const claudeProcesses = harnessProcesses.filter((p: { harness: string }) => p.harness === 'claude');
  const nvidiaClocks = parseNvidiaClocks(parseSection(raw, 'NVIDIA_CLOCKS'));
  const nvidiaGpus = parseNvidiaGpu(parseSection(raw, 'NVIDIA')).map((g: any) => ({
    ...g,
    ...(nvidiaClocks.get(g.index) ?? { clockMhz: null, clockMaxMhz: null, throttle: null }),
  }));
  const nvidiaProcesses = parseNvidiaProcesses(parseSection(raw, 'NVIDIA_PS'));
  const amdGpus = parseAmdGpu(parseSection(raw, 'AMD_GPU'));
  const temperatures = parseTemperatures(parseSection(raw, 'TEMPS'));
  const sensors = mergeSensors(parseHwmon(parseSection(raw, 'HWMON')), temperatures);
  const throttle = parseThrottle(parseSection(raw, 'THROTTLE'));
  const cpuTopology = parseCpuTopology(parseSection(raw, 'CPUTOPO'));
  const netInterfaces = parseNetInterfaces(parseSection(raw, 'NET'));
  const netDev = parseNetDev(parseSection(raw, 'NETSTAT'));
  const docker = parseDocker(parseSection(raw, 'DOCKER'));
  const tmuxSessions = parseTmux(parseSection(raw, 'TMUX'));
  const screenSessions = parseScreen(parseSection(raw, 'SCREEN'));

  return {
    hostname,
    reachable: !!hostname,
    // Our probe prints SECTION:END last. Its absence means SSH was killed
    // mid-stream, so every section after the cut is empty for a reason that
    // has nothing to do with the hardware. Without this flag a truncated
    // probe is indistinguishable from a node that genuinely has no sensors,
    // no disks and no network — which is how a wedged mount on one box read
    // as "this machine reports no temperatures".
    truncated: !!hostname && !raw.includes('===SECTION:END==='),
    system: { arch, kernel, os: osName, cpuModel: cpuInfo.model, cpuMhz: cpuInfo.mhz, cpuCache: cpuInfo.cacheSize, cpuCores },
    memory,
    loadAvg,
    runnable,
    uptimeSeconds,
    disk,
    processes,
    claudeProcesses,
    harnessProcesses,
    harnessCounts,
    gpu: {
      nvidia: nvidiaGpus,
      nvidiaProcesses,
      amd: amdGpus,
      hasGpu: nvidiaGpus.length > 0 || amdGpus.length > 0,
    },
    // `temperatures` stays the raw ACPI zone list — the mesh overview page
    // reads that shape. `sensors` is the merged, labeled, limit-aware view.
    temperatures,
    sensors,
    throttle,
    cpuTopology,
    network: { interfaces: netInterfaces, throughput: netDev },
    containers: docker,
    sessions: { tmux: tmuxSessions, screen: screenSessions },
    probedAt: new Date().toISOString(),
  };
}
