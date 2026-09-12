/**
 * Probe one node over ssh.
 *
 * This lived inside the /api/mesh route, and the worker reached it by
 * fetching /api/mesh?host=… from the web server every fifteen seconds per
 * node — a probe that could have run anywhere, routed through the process
 * whose job is to answer pages. It lives here now, where both the route and
 * the worker can call it, and the worker no longer needs a web server up to
 * take a sample.
 */
import { execFile } from 'child_process';
import { parseRemoteProbe, type MeshNode } from './mesh-probe';
import { harnessPsAwk } from './harness-procs';

/**
 * Probe a remote node via a single SSH call that collects all stats,
 * RAPL power readings, and nvidia-smi data in one round-trip.
 */
export function probeRemote(host: string): Promise<MeshNode> {
  // Single SSH command that gathers everything: stats, RAPL (with 100ms sleep), nvidia-smi
  // Use ; between sections so RAPL/GPU failures don't break the chain
  const remoteScript = [
    // Stats section (&&-chained — all must succeed). The CPU name is the one
    // link that legitimately varies by architecture: aarch64 has no `model
    // name`, so a plain grep there exited 1 and took the whole chain — and
    // the node — down as "Unreachable". One line always comes out; which
    // field it is, parseCpuModel sorts out (see its precedence note).
    `{ hostname -f 2>/dev/null || hostname; } && nproc && { grep -m1 "^model name" /proc/cpuinfo || grep -m1 "^cpu model" /proc/cpuinfo || grep -m1 "^Model" /proc/cpuinfo || grep -m1 "^Hardware" /proc/cpuinfo || grep -m1 -E "^cpu\s*:" /proc/cpuinfo || { grep -q "^CPU part" /proc/cpuinfo && { grep -m1 "^CPU implementer" /proc/cpuinfo; grep -m1 "^CPU part" /proc/cpuinfo; } | paste -sd " "; } || echo "model name : unknown"; } && uname -m && { lsblk -d -o NAME,TYPE,SIZE,ROTA 2>/dev/null; echo "---LSBLK_END---"; } && cat /proc/meminfo && cat /proc/loadavg && cat /proc/uptime && ps aux 2>/dev/null | awk '${harnessPsAwk()}' | sed 's/^/HPROC /' && echo "---STATS_END---"`,
    // RAPL section (best-effort, semicolon-delimited)
    'R1=$(cat /sys/class/powercap/intel-rapl/intel-rapl:0/energy_uj 2>/dev/null); R1B=$(cat /sys/class/powercap/intel-rapl/intel-rapl:1/energy_uj 2>/dev/null); sleep 0.1; R2=$(cat /sys/class/powercap/intel-rapl/intel-rapl:0/energy_uj 2>/dev/null); R2B=$(cat /sys/class/powercap/intel-rapl/intel-rapl:1/energy_uj 2>/dev/null); echo "$R1 $R1B $R2 $R2B"; echo "---RAPL_END---"',
    // GPU section (best-effort)
    'nvidia-smi --query-gpu=power.draw,name,memory.total,memory.used,utilization.gpu --format=csv,noheader,nounits 2>/dev/null; echo "---GPU_END---"',
  ].join('; ');

  return new Promise((resolve) => {
    execFile('ssh', ['-o', 'ConnectTimeout=5', '-o', 'StrictHostKeyChecking=no', host, remoteScript],
      { encoding: 'utf-8', timeout: 12000 },
      (err, stdout) => {
        if (err) {
          resolve({
            hostname: host,
            reachable: false,
            error: err.message?.includes('ETIMEDOUT') ? 'Connection timed out' : 'Unreachable',
          });
          return;
        }

        try {
          resolve(parseRemoteProbe(host, stdout));
        } catch (parseErr: any) {
          resolve({ hostname: host, reachable: false, error: parseErr.message });
        }
      },
    );
  });
}
