/**
 * Our node probe's wire: section markers and how one section is cut out of
 * the single stream a probe returns. Shared by every node-probe-* parser.
 */

export const SECTION_MARKERS = [
  'HOSTNAME', 'CPUINFO', 'ARCH', 'KERNEL', 'OS', 'NPROC', 'MEMINFO',
  'LOADAVG', 'UPTIME', 'DISK', 'PS', 'PS_TREE', 'CLAUDE_PS', 'UF', 'NVIDIA', 'NVIDIA_PS',
  'AMD_GPU', 'TEMPS', 'HWMON', 'THROTTLE', 'CPUTOPO', 'NVIDIA_CLOCKS', 'NET', 'NETSTAT', 'IOSTAT', 'DOCKER', 'DOCKER_STATE', 'DOCKER_CGROUP', 'CGROUP_STATS', 'VMS', 'PS_PPID', 'HARNESS_SESSIONS', 'TMUX', 'SCREEN', 'END',
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

/** Round to d decimals. Internal to our node-probe modules. */
export function round(n: number, d = 1): number {
  const f = Math.pow(10, d);
  return Math.round(n * f) / f;
}
