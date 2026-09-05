/* eslint-disable @typescript-eslint/no-explicit-any */
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
      tempC: parseFloat(p[2]) || 0,
      gpuUtil: parseFloat(p[3]) || 0,
      memUtil: parseFloat(p[4]) || 0,
      memTotalMB: parseFloat(p[5]) || 0,
      memUsedMB: parseFloat(p[6]) || 0,
      memFreeMB: parseFloat(p[7]) || 0,
      powerDrawW: parseFloat(p[8]) || 0,
      powerLimitW: parseFloat(p[9]) || 0,
      fanPct: parseFloat(p[10]) || 0,
      pstate: p[11],
    };
  }).filter(Boolean);
}

export function parseNvidiaProcesses(raw: string) {
  if (!raw || raw === 'none') return [];
  return raw.split('\n').filter(l => l.trim()).map(line => {
    const p = line.split(',').map(s => s.trim());
    if (p.length < 3) return null;
    return { pid: parseInt(p[0]), name: p[1], memMB: parseFloat(p[2]) || 0 };
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
      usePct: parseInt(parts[4]) || 0,
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
      rxBytes: parseInt(parts[1]) || 0,
      rxPackets: parseInt(parts[2]) || 0,
      txBytes: parseInt(parts[9]) || 0,
      txPackets: parseInt(parts[10]) || 0,
    };
  }).filter(Boolean).filter(n => n!.rxBytes > 0 || n!.txBytes > 0);
}

export function parseDocker(raw: string) {
  if (!raw || raw === 'none') return [];
  return raw.split('\n').filter(l => l.trim()).map(line => {
    const parts = line.split('\t');
    if (parts.length < 5) return null;
    return { id: parts[0], name: parts[1], image: parts[2], status: parts[3], ports: parts[4] };
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
