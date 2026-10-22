import { parseCpuModel } from '@unturf/unfirehose/mesh-probe';
import { num, int } from '@/lib/num';
import { round } from './node-probe-sections';

/**
 * Host-level parsers for our node probe: CPU, memory, processes, GPUs,
 * disks, network and terminal multiplexer sessions.
 */

export function parseCpuInfo(raw: string) {
  // Whichever field this architecture names the CPU in — see parseCpuModel.
  const model = parseCpuModel(raw) ?? 'Unknown';
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

export interface ProcessTreeRow {
  pid: number;
  pgid: number;
  sid: number;
  tty: string;
  time: string;
  cmd: string;
  /** Nesting level: `ps -H` indents CMD by two spaces per generation. */
  depth: number;
}

/**
 * `ps -ejH` — every process with its group and session ids, ordered as a
 * tree with CMD indented two spaces per generation. The indent is the only
 * carrier of parentage (there is no PPID column), so it is measured before
 * the row is trimmed. CMD is `comm`, which can itself contain a space
 * ("tmux: server"), so the split stops after TIME.
 */
export function parseProcessTree(raw: string): ProcessTreeRow[] {
  if (!raw || raw === 'n/a') return [];
  const rows: ProcessTreeRow[] = [];
  for (const line of raw.split('\n')) {
    // One space separates TIME from the CMD field; everything after it is
    // CMD, including its hierarchy indent.
    const m = line.match(/^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\S+)\s+(\S+) (.*)$/);
    if (!m) continue;
    const field = m[6]!;
    const indent = field.length - field.trimStart().length;
    rows.push({
      pid: parseInt(m[1]!),
      pgid: parseInt(m[2]!),
      sid: parseInt(m[3]!),
      tty: m[4]!,
      time: m[5]!,
      cmd: field.trim(),
      depth: Math.floor(indent / 2),
    });
  }
  return rows;
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

/** A bare kilobyte count (from `df -k`, where GNU's -h is missing) as -h would print it. */
function humanKB(v: string): string {
  if (!/^\d+$/.test(v)) return v;
  let n = parseInt(v, 10);
  for (const u of ['K', 'M', 'G', 'T', 'P']) {
    if (n < 1024) return `${n}${u}`;
    n = Math.round(n / 1024 * 10) / 10;
  }
  return `${n}E`;
}

export function parseDisk(raw: string) {
  if (!raw || raw === 'n/a') return [];
  return raw.split('\n').filter(l => l.trim()).map(line => {
    const parts = line.trim().split(/\s+/);
    if (parts.length < 6) return null;
    return {
      device: parts[0],
      size: humanKB(parts[1]),
      used: humanKB(parts[2]),
      avail: humanKB(parts[3]),
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
