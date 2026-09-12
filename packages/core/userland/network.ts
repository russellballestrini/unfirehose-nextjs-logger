/**
 * Network operating systems that have no Unix to drop into speak their
 * own report; these turn it into our wire so the one parser reads it.
 * Each is written from the vendor's documented output and marked
 * unverified in speakers.ts until someone with the device confirms.
 *
 * A device is `kind=network`: it belongs on the mesh as the thing that
 * carries the edges, not as a place to run an agent.
 */

const line = (k: string, v: string | number | undefined | null) => (v === undefined || v === null || v === '' ? [] : [`${k}=${v}`]);

/** "1w2d3h4m5s" → seconds. */
export function routerosUptime(s: string): number | null {
  const m = s.match(/(?:(\d+)w)?(?:(\d+)d)?(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s)?/);
  if (!m || !m[0]) return null;
  return (+(m[1] ?? 0)) * 604800 + (+(m[2] ?? 0)) * 86400 + (+(m[3] ?? 0)) * 3600 + (+(m[4] ?? 0)) * 60 + (+(m[5] ?? 0));
}

/** "1 year, 2 weeks, 3 days, 4 hours, 5 minutes" → seconds. */
export function wordsUptime(s: string): number | null {
  const u: Record<string, number> = { year: 31536000, week: 604800, day: 86400, hour: 3600, minute: 60, second: 1 };
  let secs = 0; let seen = false;
  for (const m of s.matchAll(/(\d+)\s*(year|week|day|hour|minute|second)s?/gi)) { secs += +m[1]! * u[m[2]!.toLowerCase()]!; seen = true; }
  return seen ? secs : null;
}

/**
 * MikroTik RouterOS — `/system resource print` and `/system identity print`
 * over one ssh command. Fields are `   name: value`, one per line.
 */
export function translateRouterOS(stdout: string): string {
  const kv: Record<string, string> = {};
  for (const l of stdout.split('\n')) {
    const m = l.match(/^\s*([a-z-]+):\s*(.*?)\s*$/);
    if (m) kv[m[1]!] = m[2]!;
  }
  if (!kv['total-memory'] && !kv['cpu-load']) return '';
  const cpu = [kv.cpu, kv['cpu-frequency'] ? `@ ${kv['cpu-frequency']}` : ''].filter(Boolean).join(' ');
  return [
    'uf=1', 'os=RouterOS', 'userland=routeros', 'kind=network',
    ...line('hostname', kv.name),
    ...line('osrel', kv.version),
    ...line('model', kv['board-name']),
    ...line('arch', kv['architecture-name']),
    ...line('cpu', cpu),
    ...line('nproc', kv['cpu-count']),
    ...line('mem_total', kv['total-memory']),
    ...line('mem_avail', kv['free-memory']),
    ...line('cpu_pct', kv['cpu-load']?.replace('%', '')),
    ...line('uptime_s', kv.uptime ? routerosUptime(kv.uptime) : null),
    ...line('disk_total', kv['total-hdd-space']),
    'END',
  ].join('\n');
}

/**
 * Cisco IOS / IOS-XE — a pty session fed `show version`, `show processes
 * cpu`, `show memory statistics`, `show inventory`. Prompts and echoed
 * commands are in the text; every match below is anchored on words the
 * device prints, not on line positions.
 */
export function translateCiscoIOS(stdout: string): string {
  const t = stdout.replace(/\r/g, '');
  const ver = t.match(/Cisco IOS(?:-XE)? Software.*?Version\s+([^\s,]+)/i);
  const up = t.match(/^\s*(\S+)\s+uptime is\s+(.+)$/im);
  const proc = t.match(/^(?:cisco\s+)?(\S+)\s+\(([^)]+)\)\s+processor.*?with\s+(\d+)K(?:\/(\d+)K)?\s+bytes of memory/im);
  const cpu = t.match(/CPU utilization for five seconds:\s*(\d+)%(?:\/\d+%)?;\s*one minute:\s*(\d+)%;\s*five minutes:\s*(\d+)%/i);
  const mem = t.match(/^Processor\s+(?:Pool Total:\s*)?(\d+)\s+(?:Used:\s*)?(\d+)\s+(?:Free:\s*)?(\d+)/im)
    ?? t.match(/^Processor\s+[0-9A-Fx]+\s+(\d+)\s+(\d+)\s+(\d+)/im);
  const pid = t.match(/PID:\s*([^\s,]+)/i);
  if (!ver && !up && !proc) return '';
  const memTotal = mem ? +mem[1]! : proc ? (+proc[3]! + (+(proc[4] ?? 0))) * 1024 : undefined;
  return [
    'uf=1', 'os=IOS', 'userland=cisco-ios', 'kind=network',
    ...line('hostname', up?.[1]),
    ...line('osrel', ver ? `IOS ${ver[1]}` : undefined),
    ...line('model', pid?.[1] ?? proc?.[1]),
    ...line('cpu', proc?.[2]),
    'nproc=1',
    ...line('mem_total', memTotal !== undefined ? `${memTotal} B` : undefined),
    ...line('mem_avail', mem ? `${mem[3]} B` : undefined),
    ...line('cpu_pct', cpu?.[2]),
    ...line('uptime_s', up ? wordsUptime(up[2]!) : null),
    'END',
  ].join('\n');
}

/** Fortinet FortiOS — `get system status` and `get system performance status`. */
export function translateFortiOS(stdout: string): string {
  const t = stdout.replace(/\r/g, '');
  const ver = t.match(/^Version:\s*(\S+)\s+v?([^\s,]+)/im);
  const host = t.match(/^Hostname:\s*(\S+)/im);
  const cpu = t.match(/CPU states:\s*(\d+)% user\s+(\d+)% system.*?(\d+)% idle/i);
  const mem = t.match(/Memory:\s*(\d+)k total,\s*(\d+)k used.*?(\d+)k free/i);
  const up = t.match(/^Uptime:\s*(.+)$/im);
  // Per-core lines ("CPU0 states: …") follow the summary on a multi-core unit.
  const cores = t.match(/^CPU\d+ states:/gim)?.length ?? 1;
  if (!ver && !mem) return '';
  return [
    'uf=1', 'os=FortiOS', 'userland=fortios', 'kind=network',
    ...line('hostname', host?.[1]),
    ...line('model', ver?.[1]),
    ...line('osrel', ver ? `FortiOS ${ver[2]}` : undefined),
    `nproc=${cores}`,
    ...line('mem_total', mem ? `${mem[1]} kB` : undefined),
    ...line('mem_avail', mem ? `${mem[3]} kB` : undefined),
    ...line('cpu_pct', cpu ? 100 - +cpu[3]! : undefined),
    ...line('uptime_s', up ? wordsUptime(up[1]!) : null),
    'END',
  ].join('\n');
}
