/* eslint-disable @typescript-eslint/no-explicit-any */
import { parseHarnessProcesses, countByHarness } from '@unturf/unfirehose/harness-procs';
import { parseCpuModel } from '@unturf/unfirehose/mesh-probe';
import { readWire, parseMemory, parseLoad, parseUptimeSeconds, parseSwap } from '@unturf/unfirehose/userland';
import {
  parseTemperatures, parseHwmon, mergeSensors, parseThrottle,
  parseNvidiaClocks, parseCpuTopology,
} from '@/lib/sensors';
import { num, int } from '@/lib/num';
import { parseSection, round } from './node-probe-sections';
import {
  parseCpuInfo, parseMeminfo, parseProcesses, parseProcessTree, parseNvidiaGpu, parseNvidiaProcesses,
  parseAmdGpu, parseDisk, parseNetInterfaces, parseNetDev, parseTmux, parseScreen,
} from './node-probe-host';
import {
  parseDocker, parseDockerState, parseCgroupStats, parsePsPpid, attachContainerResources,
  attachDockerState, parseDockerCgroup, mergeCgroupContainers,
} from './node-probe-containers';
import { parseHarnessSessions, attachHarnessSessions } from './node-probe-harness';
import { parseVms, linkVmContainers } from './node-probe-vms';

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

// Our public surface: every parser stays importable from `@/lib/node-probe`.
export { SECTION_MARKERS, parseSection } from './node-probe-sections';
export {
  parseCpuInfo, parseMeminfo, parseProcesses, parseProcessTree, parseNvidiaGpu, parseNvidiaProcesses,
  parseAmdGpu, parseDisk, parseNetInterfaces, parseNetDev, parseTmux, parseScreen,
} from './node-probe-host';
export type { ProcessTreeRow } from './node-probe-host';
export {
  parseDocker, parseDockerState, parseCgroupStats, parsePsPpid, containerProcessTree,
  attachContainerResources, attachDockerState, unescapeMachineName, parseDockerCgroup, mergeCgroupContainers,
} from './node-probe-containers';
export type {
  ContainerState, ContainerResources, PsPpidRow, ContainerProcess, CgroupContainer,
} from './node-probe-containers';
export { parseHarnessSessions, resolveHarnessSession, attachHarnessSessions } from './node-probe-harness';
export type { HarnessSession } from './node-probe-harness';
export {
  parseQemuMemMB, parseQemuSmp, parseQemuArgv, parseVirshList, parseXlList, parseVboxList, parseVms, linkVmContainers,
} from './node-probe-vms';
export type { VirtualMachine } from './node-probe-vms';

/**
 * One probe's output, as the object a node page renders.
 *
 * Every section above is read here exactly once, so a marker that moves
 * or a command that changed its format shows up as one field going quiet
 * rather than as a page that fails.
 */
export function parseProbeOutput(raw: string, host: string) {
  // The userland section is what every OS can say (see core/userland);
  // the Linux sections below it are richer where they exist. Each basic
  // reads Linux first and falls back to the userland's own words.
  const uf = readWire(parseSection(raw, 'UF'));
  const hostname = parseSection(raw, 'HOSTNAME') || uf.kv.hostname || host;
  let cpuInfo = parseCpuInfo(parseSection(raw, 'CPUINFO'));
  if (cpuInfo.model === 'Unknown' && uf.kv.cpu) {
    const m = uf.kv.cpu.includes(':') ? parseCpuModel(uf.kv.cpu) : uf.kv.cpu;
    cpuInfo = { ...cpuInfo, model: m || uf.kv.soc || uf.kv.model || 'Unknown' };
  }
  const arch = parseSection(raw, 'ARCH') || uf.kv.isa || uf.kv.arch || 'unknown';
  const kernel = parseSection(raw, 'KERNEL') || uf.kv.osrel || 'unknown';
  const osRaw = parseSection(raw, 'OS');
  const osName = osRaw.match(/PRETTY_NAME="?([^"\n]+)"?/)?.[1]
    ?? (uf.kv.os && uf.kv.os !== 'Linux' ? `${uf.kv.os} ${uf.kv.osrel ?? ''}`.trim() : 'Linux');
  const cpuCores = int(parseSection(raw, 'NPROC')) || parseInt(uf.kv.nproc?.match(/\d+/)?.[0] ?? '') || 0;
  let memory = parseMeminfo(parseSection(raw, 'MEMINFO'));
  if (!memory.totalGB && uf.shellRan) {
    const m = parseMemory(uf.kv); const sw = parseSwap(uf.kv);
    memory = {
      ...memory,
      totalGB: round(m.totalGB), availableGB: round(m.availableGB), usedGB: round(m.totalGB - m.availableGB),
      swapTotalGB: round(sw.totalGB), swapUsedGB: round(sw.usedGB),
    };
  }

  const loadRaw = parseSection(raw, 'LOADAVG').split(/\s+/);
  let loadAvg = [num(loadRaw[0]), num(loadRaw[1]), num(loadRaw[2])];
  if (!loadAvg.some(Boolean) && uf.shellRan) loadAvg = parseLoad(uf.kv.load, uf.kv.uptime_raw);
  const runnable = loadRaw[3] ?? '0/0';

  const uptimeRaw = parseSection(raw, 'UPTIME').split(/\s+/);
  const uptimeSeconds = num(uptimeRaw[0]) || (uf.shellRan ? Math.round(parseUptimeSeconds(uf.kv)) : 0);

  const disk = parseDisk(parseSection(raw, 'DISK'));
  const processes = parseProcesses(parseSection(raw, 'PS'));
  const processTree = parseProcessTree(parseSection(raw, 'PS_TREE'));
  // Named CLAUDE_PS for wire compatibility; it carries every harness now.
  const harnessProcesses = attachHarnessSessions(
    parseHarnessProcesses(parseSection(raw, 'CLAUDE_PS')),
    parseHarnessSessions(parseSection(raw, 'HARNESS_SESSIONS')),
  );
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
  const docker = attachContainerResources(
    attachDockerState(
      mergeCgroupContainers(
        parseDocker(parseSection(raw, 'DOCKER')),
        parseDockerCgroup(parseSection(raw, 'DOCKER_CGROUP')),
      ),
      parseDockerState(parseSection(raw, 'DOCKER_STATE')),
    ),
    parseCgroupStats(parseSection(raw, 'CGROUP_STATS')),
    parsePsPpid(parseSection(raw, 'PS_PPID')),
  );
  const vms = linkVmContainers(parseVms(parseSection(raw, 'VMS')), docker);
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
    system: { arch, kernel, os: osName, cpuModel: cpuInfo.model, cpuMhz: cpuInfo.mhz, cpuCache: cpuInfo.cacheSize, cpuCores, userland: uf.kv.userland },
    memory,
    loadAvg,
    runnable,
    uptimeSeconds,
    disk,
    processes,
    processTree,
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
    vms,
    sessions: { tmux: tmuxSessions, screen: screenSessions },
    probedAt: new Date().toISOString(),
  };
}
