import { describe, it, expect } from 'vitest';
import {
  parseSection, parseCpuInfo, parseMeminfo, parseProcesses, parseProcessTree, parseNvidiaGpu,
  parseDisk, parseNetInterfaces, parseNetDev, parseDocker, parseDockerState, attachDockerState, parseProbeOutput,
  parseCgroupStats, parsePsPpid, containerProcessTree, attachContainerResources,
} from './node-probe';

/**
 * Reading a node from the text one SSH call brought back.
 *
 * The probe runs a dozen commands and returns their output in one stream,
 * separated by markers. Everything the node detail page shows comes out of
 * these parsers, and none of them had a test — because reaching them meant
 * an SSH connection to a machine in the right state.
 *
 * The fixtures are real output, trimmed.
 */

describe('parseSection', () => {
  const output = [
    '===SECTION:CPUINFO===', 'model name : Xeon',
    '===SECTION:MEMINFO===', 'MemTotal: 100 kB',
    '===SECTION:DISK===', '/dev/sda1 1.8T 1.6T 200G 89% /',
  ].join('\n');

  it('returns just the section asked for', () => {
    expect(parseSection(output, 'MEMINFO')).toBe('MemTotal: 100 kB');
  });

  it('returns the last section without running past the end', () => {
    expect(parseSection(output, 'DISK')).toBe('/dev/sda1 1.8T 1.6T 200G 89% /');
  });

  it('returns nothing for a section the probe did not produce', () => {
    // A machine without nvidia-smi emits no GPU section at all, and the
    // page has to read that as "no GPU" rather than crash.
    expect(parseSection(output, 'NVIDIA')).toBe('');
    expect(parseSection('', 'MEMINFO')).toBe('');
  });
});

describe('parseCpuInfo', () => {
  it('reads the model, clock and cache', () => {
    const cpu = parseCpuInfo([
      'processor : 0',
      'model name : Intel(R) Xeon(R) CPU E5-2670 0 @ 2.60GHz',
      'cpu MHz : 1200.000',
      'cache size : 20480 KB',
    ].join('\n'));
    expect(cpu.model).toBe('Intel(R) Xeon(R) CPU E5-2670 0 @ 2.60GHz');
    expect(cpu.mhz).toBe(1200);
    expect(cpu.cacheSize).toBe('20480 KB');
  });

  it('says Unknown rather than nothing when there is no model line', () => {
    expect(parseCpuInfo('').model).toBe('Unknown');
  });
});

describe('parseMeminfo', () => {
  it('reads kilobytes as gigabytes', () => {
    const mem = parseMeminfo([
      'MemTotal:       32791234 kB', 'MemAvailable:   20000000 kB',
      'SwapTotal:       8000000 kB', 'SwapFree:        7000000 kB',
    ].join('\n'));
    expect(mem.totalGB).toBeCloseTo(31.3, 1);
  });

  it('reads a missing field as zero, not NaN', () => {
    // A container without swap has no SwapTotal line at all.
    const mem = parseMeminfo('MemTotal: 1048576 kB');
    for (const v of Object.values(mem)) expect(Number.isFinite(v)).toBe(true);
  });
});

describe('parseProcesses', () => {
  const ps = [
    'USER PID %CPU %MEM VSZ RSS TTY STAT START TIME COMMAND',
    'fox 1234 2.1 1.4 123456 65432 ? Sl 09:00 0:12 /home/fox/.local/bin/claude --resume abc',
    'root 5678 0.0 0.1 9999 888 ? S 08:00 0:00 /usr/sbin/sshd',
  ].join('\n');

  it('reads each row, keeping the whole command', () => {
    const procs = parseProcesses(ps);
    expect(procs).toHaveLength(2);
    // The command has spaces in it and is the last field, so it must be
    // rejoined rather than truncated at the first one.
    expect(procs[0]!.command).toBe('/home/fox/.local/bin/claude --resume abc');
    expect(procs[0]!.pid).toBe(1234);
    expect(procs[0]!.cpu).toBe(2.1);
  });

  it('reads no processes from nothing, and from a header alone', () => {
    expect(parseProcesses('')).toEqual([]);
    expect(parseProcesses('n/a')).toEqual([]);
    expect(parseProcesses('USER PID %CPU')).toEqual([]);
  });
});

describe('parseProcessTree', () => {
  const ps = [
    '    PID    PGID     SID TTY          TIME CMD',
    '      1       1       1 ?        00:00:09 systemd',
    '   2010    2010    2010 ?        00:00:01   tmux: server',
    '   2011    2011    2011 pts/3    00:00:00     bash',
    '   2099    2099    2011 pts/3    00:12:34       claude',
    '      2       0       0 ?        00:00:00 kthreadd',
  ].join('\n');

  it('reads each row with its depth from the CMD indent', () => {
    const rows = parseProcessTree(ps);
    expect(rows.map(r => [r.pid, r.depth])).toEqual([[1, 0], [2010, 1], [2011, 2], [2099, 3], [2, 0]]);
    expect(rows[3]).toMatchObject({ pgid: 2099, sid: 2011, tty: 'pts/3', time: '00:12:34', cmd: 'claude' });
  });

  it('keeps a comm that contains a space', () => {
    // "tmux: server" is one CMD, not a CMD and a stray column.
    expect(parseProcessTree(ps)[1]!.cmd).toBe('tmux: server');
  });

  it('reads no rows from nothing, a header alone, or a missing ps', () => {
    expect(parseProcessTree('')).toEqual([]);
    expect(parseProcessTree('n/a')).toEqual([]);
    expect(parseProcessTree('    PID    PGID     SID TTY          TIME CMD')).toEqual([]);
  });
});

describe('parseNvidiaGpu', () => {
  it('reads a card', () => {
    const [gpu] = parseNvidiaGpu(
      '0, NVIDIA GeForce RTX 3090, 62, 100, 45, 24576, 22200, 2376, 347.5, 350, 62, P2',
    );
    expect(gpu).toMatchObject({
      index: 0, name: 'NVIDIA GeForce RTX 3090', tempC: 62,
      gpuUtil: 100, memTotalMB: 24576, powerDrawW: 347.5, pstate: 'P2',
    });
  });

  it('reads every card, not just the first', () => {
    expect(parseNvidiaGpu([
      '0, RTX 3090, 62, 100, 45, 24576, 22200, 2376, 347.5, 350, 62, P2',
      '1, RTX 4090, 55, 80, 30, 24564, 12000, 12564, 405, 450, 50, P2',
    ].join('\n'))).toHaveLength(2);
  });

  it('reads no cards on a machine without nvidia-smi', () => {
    expect(parseNvidiaGpu('none')).toEqual([]);
    expect(parseNvidiaGpu('')).toEqual([]);
  });

  it('drops a row that is not the shape it expects', () => {
    // nvidia-smi prints errors to the same stream on a driver mismatch.
    expect(parseNvidiaGpu('Failed to initialize NVML: Driver/library version mismatch')).toEqual([]);
  });
});

describe('parseDisk', () => {
  it('reads a filesystem row from df', () => {
    const [disk] = parseDisk('/dev/sda1 1.8T 1.6T 200G 89% /');
    expect(disk).toMatchObject({ device: '/dev/sda1', usePct: 89, mount: '/' });
  });

  it('reads nothing when df said nothing', () => {
    expect(parseDisk('n/a')).toEqual([]);
  });
});

describe('parseNetInterfaces and parseNetDev', () => {
  it('reads an interface and its addresses', () => {
    const [iface] = parseNetInterfaces('eno1 UP 192.168.1.18/24 fe80::1/64');
    expect(iface).toMatchObject({ name: 'eno1', state: 'UP' });
    expect(iface.addrs).toContain('192.168.1.18/24');
  });

  it('reads byte counters and drops interfaces that moved nothing', () => {
    // /proc/net/dev lists lo and every down interface; a fleet chart of
    // interfaces that never carried a packet is noise.
    const rows = parseNetDev([
      'eno1: 12345678 1000 0 0 0 0 0 0 87654321 2000 0 0 0 0 0 0',
      'dummy0: 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0',
    ].join('\n'));
    expect(rows).toHaveLength(1);
    expect(rows[0]!.iface).toBe('eno1');
    expect(rows[0]!.rxBytes).toBe(12345678);
  });
});

describe('parseDocker', () => {
  it('reads a container', () => {
    const [c] = parseDocker(
      'abc123\topen-webui\tghcr.io/open-webui:0.6.34\tUp 4 weeks (healthy)\t8080/tcp',
    );
    expect(c).toMatchObject({ name: 'open-webui', status: 'Up 4 weeks (healthy)' });
  });

  it('reads nothing on a machine without docker', () => {
    expect(parseDocker('none')).toEqual([]);
  });

  it('is tab-delimited, so a container name with spaces survives', () => {
    const [c] = parseDocker('id\tmy container\timage\tUp 2 days\t');
    expect(c!.name).toBe('my container');
  });

  /**
   * Through parseSection, not around it.
   *
   * The test above hands parseDocker one line and passes, because a
   * trailing tab still splits into five fields. The page does not call
   * parseDocker that way: it calls parseSection first, and that trims
   * the section -- which eats the trailing tab of the last line only.
   *
   * So the last host-network container silently vanished while the
   * unit test stayed green. A fleet of eight rendered as seven, and
   * the missing peer was alive, listening and in the roster.
   */
  it('keeps every host-network container, including the last one', () => {
    const probe = [
      '===SECTION:DOCKER===',
      'aaa\tpeer-000\tarborist-peer\tUp 20 minutes\t',
      'bbb\tpeer-001\tarborist-peer\tUp 20 minutes\t',
      'ccc\tpeer-002\tarborist-peer\tUp 20 minutes\t',
      '===SECTION:TMUX===',
      'none',
    ].join('\n');
    const containers = parseDocker(parseSection(probe, 'DOCKER'));
    expect(containers.map(c => c!.name))
      .toEqual(['peer-000', 'peer-001', 'peer-002']);
    expect(containers[2]!.ports).toBe('');
  });
});

/**
 * The instants behind "Up 4 weeks".
 *
 * docker ps rounds to one unit and never says since when; docker inspect
 * has StartedAt and FinishedAt to the nanosecond. The two are joined on
 * the id -- ps prints twelve characters of it, inspect all sixty-four.
 */
describe('parseDockerState', () => {
  const FULL = 'abc123def4567890abc123def4567890abc123def4567890abc123def4567890';

  it('reads a running container and a stopped one', () => {
    const states = parseDockerState([
      `${FULL}\trunning\t2026-08-20T18:03:22.123456789Z\t0001-01-01T00:00:00Z\t0`,
      `${'f'.repeat(64)}\texited\t2026-09-01T10:00:00Z\t2026-09-11T09:30:00.5Z\t137`,
    ].join('\n'));
    expect(states.get(FULL)).toMatchObject({
      state: 'running', startedAt: '2026-08-20T18:03:22.123456789Z', finishedAt: null, exitCode: 0,
    });
    expect(states.get('f'.repeat(64))).toMatchObject({ state: 'exited', finishedAt: '2026-09-11T09:30:00.5Z', exitCode: 137 });
  });

  it('treats docker\'s year-one zero time as no instant at all', () => {
    // A container created but never started carries it as StartedAt.
    const [s] = parseDockerState(`${FULL}\tcreated\t0001-01-01T00:00:00Z\t0001-01-01T00:00:00Z\t0`).values();
    expect(s.startedAt).toBeNull();
    expect(s.finishedAt).toBeNull();
  });

  /**
   * The line grew eight fields on 2026-09-14 for the Containers tab: root
   * host pid, HostConfig limits, restarts, OOM, health. A probe from before
   * then stops at exit code and every new field reads null.
   */
  it('reads the root pid, limits and health that follow the exit code', () => {
    const [s] = parseDockerState(
      `${FULL}\trunning\t2026-08-06T13:36:57Z\t0001-01-01T00:00:00Z\t0\t8354\t2000000000\t4294967296\t<no value>\t\t3\tfalse\thealthy`,
    ).values();
    expect(s).toMatchObject({
      pid: 8354, cpuLimit: 2, memLimit: 4294967296, pidsLimit: null, cpuset: null,
      restartCount: 3, oomKilled: false, health: 'healthy',
    });
  });

  it('reads no limit as null, not zero, so a bar has nothing to divide by', () => {
    const [s] = parseDockerState(`${FULL}\trunning\t2026-08-06T13:36:57Z\t0001-01-01T00:00:00Z\t0\t42\t0\t0\t0\t\t0\tfalse\t`).values();
    expect(s).toMatchObject({ pid: 42, cpuLimit: null, memLimit: null, pidsLimit: null, health: null, oomKilled: false });
  });

  it('reads nothing without docker', () => {
    expect(parseDockerState('none').size).toBe(0);
    expect(parseDockerState('').size).toBe(0);
  });

  it('marries ps rows to inspect state by id prefix, leaving strangers alone', () => {
    const rows = [{ id: 'abc123def456', name: 'a' }, { id: 'ffffffffffff', name: 'b' }, { id: '000000000000', name: 'c' }];
    const states = parseDockerState([
      `${FULL}\trunning\t2026-08-20T18:03:22Z\t0001-01-01T00:00:00Z\t0`,
      `${'f'.repeat(64)}\texited\t2026-09-01T10:00:00Z\t2026-09-11T09:30:00Z\t1`,
    ].join('\n'));
    const out = attachDockerState(rows, states);
    expect(out[0]).toMatchObject({ name: 'a', state: 'running', startedAt: '2026-08-20T18:03:22Z' });
    expect(out[1]).toMatchObject({ name: 'b', state: 'exited', exitCode: 1 });
    expect(out[2]).toEqual({ id: '000000000000', name: 'c' });
  });

  it('flows through a whole probe', () => {
    const probe = [
      '===SECTION:HOSTNAME===', 'box',
      '===SECTION:DOCKER===',
      'abc123def456\topen-webui\tghcr.io/open-webui:0.6\tUp 4 weeks (healthy)\t8080/tcp',
      '===SECTION:DOCKER_STATE===',
      `${FULL}\trunning\t2026-08-20T18:03:22Z\t0001-01-01T00:00:00Z\t0`,
      '===SECTION:TMUX===', 'none',
      '===SECTION:END===',
    ].join('\n');
    const out = parseProbeOutput(probe);
    expect(out.containers[0]).toMatchObject({ name: 'open-webui', status: 'Up 4 weeks (healthy)', state: 'running', startedAt: '2026-08-20T18:03:22Z' });
  });
});

/**
 * A whole probe, read at once.
 *
 * Every section is read here exactly once, so a marker that moves or a
 * command whose format changed shows up as one field going quiet rather
 * than a page that fails — which is why the assertion that matters is the
 * one about a machine that answered only half the probe.
 */
describe('parseProbeOutput', () => {
  const section = (name: string, body: string) => `===SECTION:${name}===\n${body}\n`;

  const probe = [
    section('HOSTNAME', 'cammy'),
    section('CPUINFO', 'model name : Intel(R) Xeon(R) CPU E5-2670 v3\ncpu MHz : 1200.000\ncache size : 30720 KB'),
    section('ARCH', 'x86_64'),
    section('KERNEL', '6.6.44-1-lts'),
    section('OS', 'PRETTY_NAME="Debian GNU/Linux 12 (bookworm)"'),
    section('NPROC', '48'),
    section('MEMINFO', 'MemTotal: 395264000 kB\nMemAvailable: 296448000 kB\nMemFree: 100000000 kB'),
    section('LOADAVG', '9.30 8.01 7.44 3/1892 44011'),
    section('UPTIME', '2540000.12 100000000.00'),
    section('DISK', 'Filesystem 1G-blocks Used Avail Use% Mounted on\n/dev/sda1 1800 1600 200 89% /'),
    section('PS', 'fox 1234 2.1 1.4 node /home/fox/.local/bin/claude'),
    section('CLAUDE_PS', 'fox 1234 2.1 1.4 900000 240000 ? Sl 12:00 0:31 node /home/fox/.local/bin/claude'),
    section('NVIDIA', '0, NVIDIA GeForce RTX 3090, 62, 12, 30, 24576, 14000, 10576, 320.50, 350.00, 60, P2'),
    section('END', ''),
  ].join('');

  it('reads a machine out of one blob of text', () => {
    const node = parseProbeOutput(probe, 'cammy.foxhop.net');
    expect(node).toMatchObject({ hostname: 'cammy', reachable: true, truncated: false });
    expect(node.system).toMatchObject({ arch: 'x86_64', cpuCores: 48, kernel: '6.6.44-1-lts' });
    expect(node.system.os).toContain('Debian');
  });

  it('reads the load average and how many tasks are runnable', () => {
    // A load of 9 on 48 cores is idle; on 4 cores it is a queue. The
    // runnable count is the part that says which.
    const node = parseProbeOutput(probe, 'cammy');
    expect(node.loadAvg).toEqual([9.3, 8.01, 7.44]);
    expect(node.runnable).toBe('3/1892');
  });

  it('falls back to the host it was asked about when the probe did not say', () => {
    // An ssh command can come back truncated. A node with no name is a
    // card the page cannot key or link.
    expect(parseProbeOutput('', 'cammy.foxhop.net').hostname).toBe('cammy.foxhop.net');
  });

  it('reads a machine that answered only half the probe', () => {
    // One wedged command truncates every section after it. That has to
    // cost us those sections, not the node.
    const node = parseProbeOutput(
      section('HOSTNAME', 'cammy') + section('NPROC', '48'), 'cammy',
    );
    expect(node.hostname).toBe('cammy');
    expect(node.system.cpuCores).toBe(48);
    // The flag is the point: an empty sensor list from a probe that was
    // cut short is not a machine without sensors, and one wedged mount on
    // one box read as 'this machine reports no temperatures'.
    expect(node.truncated).toBe(true);
    expect(node.disk).toEqual([]);
    expect(node.gpu.hasGpu).toBe(false);
    expect(node.loadAvg).toEqual([0, 0, 0]);
  });

  it('counts harnesses separately from claude', () => {
    // claudeProcesses keeps its old meaning for callers that predate the
    // other fifteen harnesses.
    const node = parseProbeOutput(probe, 'cammy');
    expect(node.claudeProcesses).toHaveLength(1);
    expect(node.harnessCounts).toMatchObject({ claude: 1 });
  });

  it('carries a GPU through with its power draw', () => {
    const node = parseProbeOutput(probe, 'cammy');
    expect(node.gpu.nvidia[0]).toMatchObject({ name: 'NVIDIA GeForce RTX 3090', tempC: 62, powerDrawW: 320.5 });
    expect(node.gpu.hasGpu).toBe(true);
  });

  it('says Linux when the release file did not name itself', () => {
    expect(parseProbeOutput(section('OS', 'ID=debian'), 'x').system.os).toBe('Linux');
  });
});

describe('parseProbeOutput on a machine that is not Linux', () => {
  // Every Linux section comes back n/a on a BSD or a Solaris; the userland
  // section (core/userland) is what the page must then read its basics from.
  const raw = [
    '===SECTION:UF===',
    'uf=1', 'os=FreeBSD', 'userland=freebsd', 'hostname=bsd.example.net', 'now=1789253256', 'osrel=14.1-RELEASE',
    'arch=amd64', 'nproc=8', 'cpu=Intel(R) Xeon(R) CPU E5-2650 v2 @ 2.60GHz', 'pagesize=4096',
    'mem_total=34359738368 B', 'mem_avail=1000000 2000000 0 pages', 'swap_total=8388608 kB', 'swap_used=1024 kB',
    'load={ 0.48 0.41 0.37 }', 'boottime={ sec = 1789217299, usec = 1 } Sat Sep 12 08:48:19 2026',
    'DISK ada0 1', 'END',
    '===SECTION:HOSTNAME===', 'bsd.example.net',
    '===SECTION:CPUINFO===', 'n/a',
    '===SECTION:ARCH===', 'amd64',
    '===SECTION:KERNEL===', '14.1-RELEASE',
    '===SECTION:OS===', 'n/a',
    '===SECTION:NPROC===', '8',
    '===SECTION:MEMINFO===', 'n/a',
    '===SECTION:LOADAVG===', '0 0 0 0/0 0',
    '===SECTION:UPTIME===', '0 0',
    '===SECTION:DISK===', '/dev/ada0p2  937000000  120000000  742000000  14%  /',
    '===SECTION:PS===', 'USER PID %CPU %MEM VSZ RSS TT STAT STARTED TIME COMMAND', 'root 1 0.0 0.0 11000 1000 - ILs 08:48 0:00.01 /sbin/init',
    '===SECTION:END===',
  ].join('\n');

  it('fills system, memory, load and uptime from the userland section', () => {
    const p = parseProbeOutput(raw, 'bsd.example.net');
    expect(p.reachable).toBe(true);
    expect(p.truncated).toBe(false);
    expect(p.system.userland).toBe('freebsd');
    expect(p.system.os).toBe('FreeBSD 14.1-RELEASE');
    expect(p.system.cpuModel).toContain('E5-2650');
    expect(p.system.cpuCores).toBe(8);
    expect(p.memory.totalGB).toBe(32);
    expect(p.memory.availableGB).toBeCloseTo(11.4, 0);
    expect(p.memory.swapTotalGB).toBe(8);
    expect(p.loadAvg).toEqual([0.48, 0.41, 0.37]);
    expect(p.uptimeSeconds).toBe(35957);
  });

  it('renders df -k kilobyte columns the way df -h would', () => {
    const p = parseProbeOutput(raw, 'h');
    expect(p.disk[0]).toMatchObject({ device: '/dev/ada0p2', size: '893.6G', usePct: 14, mount: '/' });
    expect(p.processes).toHaveLength(1);
  });
});

/**
 * A container's resources, read from our host kernel's cgroup rather than
 * asked of the runtime. Two cpu readings a second apart make the percent;
 * everything else is the file's own number, null when the file was absent.
 */
describe('parseCgroupStats', () => {
  const ID = '5c6c59cd20db2eb81c1ddc49146135256d14485870daedccab49dfed36a5a386';
  const RAW = [
    `${ID}|a|10554376412|3|4780942`,
    'elapsed_ms|1035',
    `${ID}|b|10556446412|3|4780942`,
    `${ID}|mem|778031104|4294967296|792817664|611782656|136884224|114835456|0|2`,
    `${ID}|pids|72|max`,
    `${ID}|cpumax|200000 100000|0-31`,
    `${ID}|io|288591872|4096|14069|1`,
    `${ID}|psi|avg10=1.50|avg10=0.00|avg10=0.25`,
    `${ID}|procs|8354 9133 9407 `,
  ].join('\n');

  it('turns the usage delta over the interval into a percent of one core', () => {
    const r = parseCgroupStats(RAW).get(ID)!;
    // 2,070,000 usec of cpu across 1,035 ms of wall clock: two cores flat out.
    expect(r.cpuPct).toBe(200);
    expect(r.cpuQuota).toBe(2);
    expect(r.cpuset).toBe('0-31');
    expect(r.cpuThrottled).toBe(3);
  });

  it('reads memory as docker stats does: current less inactive file cache', () => {
    const r = parseCgroupStats(RAW).get(ID)!;
    expect(r.memUsed).toBe(778031104 - 114835456);
    expect(r.memTotal).toBe(778031104);
    expect(r.memLimit).toBe(4294967296);
    expect(r.memPeak).toBe(792817664);
    expect(r.memAnon).toBe(611782656);
    expect(r.oomKills).toBe(2);
  });

  it('reads tasks, io, pressure and the pids it owns', () => {
    const r = parseCgroupStats(RAW).get(ID)!;
    expect(r.tasks).toBe(72);
    expect(r.tasksMax).toBeNull();
    expect(r.ioRead).toBe(288591872);
    expect(r.ioWriteOps).toBe(1);
    expect(r.psi).toEqual({ cpu: 1.5, memory: 0, io: 0.25 });
    expect(r.pids).toEqual([8354, 9133, 9407]);
  });

  it('has no percent without both readings, and "max" reads as no limit', () => {
    const r = parseCgroupStats([`${ID}|b|100||`, `${ID}|mem|10|max|||||`, `${ID}|cpumax|max 100000|`].join('\n')).get(ID)!;
    expect(r.cpuPct).toBeNull();
    expect(r.memLimit).toBeNull();
    expect(r.cpuQuota).toBeNull();
  });

  it('reads nothing when the section is empty or the host has no containers', () => {
    expect(parseCgroupStats('').size).toBe(0);
    expect(parseCgroupStats('elapsed_ms|1').size).toBe(0);
  });
});

describe('parsePsPpid', () => {
  const RAW = [
    '    PID    PPID USER     %CPU %MEM   RSS ELAPSED COMMAND',
    '      1       0 root      0.0  0.0 15316   15428 /sbin/init splash',
    '   8354    8330 fox       4.9  0.2 68328 3372014 python3 -m open_webui serve --host 0.0.0.0',
  ].join('\n');

  it('reads pid, parent, usage and the whole command line', () => {
    const rows = parsePsPpid(RAW);
    expect(rows).toHaveLength(2);
    expect(rows[1]).toEqual({
      pid: 8354, ppid: 8330, user: 'fox', cpu: 4.9, mem: 0.2, rss: 68328, elapsed: 3372014,
      cmd: 'python3 -m open_webui serve --host 0.0.0.0',
    });
  });

  it('keeps a BSD etime clock as no seconds rather than a wrong number', () => {
    const [r] = parsePsPpid('  7 1 root 0.0 0.0 100 01-02:03:04 sleep');
    expect(r.elapsed).toBeNull();
    expect(r.cmd).toBe('sleep');
  });
});

/**
 * The tree is cut from the host's process table by cgroup membership, so
 * it carries host pids -- pid 1 inside the container is 8354 outside.
 */
describe('containerProcessTree', () => {
  const ALL = parsePsPpid([
    '1 0 root 0.0 0.0 1 1 init',
    '8354 8330 fox 1.0 0.1 10 1 docker-init',
    '8400 8354 fox 2.0 0.2 20 1 python3 worker',
    '8500 8400 fox 0.5 0.1 5 1 sh -c hook',
    '8401 8354 fox 0.1 0.1 5 1 redis-server',
    '9999 1 root 0.0 0.0 1 1 unrelated',
  ].join('\n'));

  it('nests children under parents, in pid order, with depth', () => {
    const tree = containerProcessTree([8354, 8400, 8401, 8500], ALL);
    expect(tree.map((p) => [p.pid, p.depth])).toEqual([[8354, 0], [8400, 1], [8500, 2], [8401, 1]]);
  });

  it('leaves out pids the cgroup owns but ps no longer lists, and never pulls in outsiders', () => {
    const tree = containerProcessTree([8354, 4242], ALL);
    expect(tree.map((p) => p.pid)).toEqual([8354]);
  });

  it('starts a new branch for a process whose parent lives outside the cgroup', () => {
    // A runtime that reparents an orphan to the host's init keeps it in the cgroup.
    const tree = containerProcessTree([8400, 8500, 9999], ALL);
    expect(tree.map((p) => [p.pid, p.depth])).toEqual([[8400, 0], [8500, 1], [9999, 0]]);
  });
});

describe('attachContainerResources', () => {
  const ID = 'a'.repeat(64);
  it('marries stats and a tree onto the ps row by id prefix, and a stopped one gets neither', () => {
    const stats = parseCgroupStats([`${ID}|a|0|0|0`, 'elapsed_ms|1000', `${ID}|b|500000|0|0`, `${ID}|procs|8354`].join('\n'));
    const procs = parsePsPpid('8354 1 fox 3.0 0.1 10 5 python3');
    const out = attachContainerResources(
      [{ id: 'aaaaaaaaaaaa', name: 'web' }, { id: 'bbbbbbbbbbbb', name: 'old' }], stats, procs,
    );
    expect(out[0].resources?.cpuPct).toBe(50);
    expect(out[0].processes?.map((p) => p.pid)).toEqual([8354]);
    expect(out[1].resources).toBeNull();
    expect(out[1].processes).toEqual([]);
  });

  it('leaves rows untouched when the probe carried no such sections', () => {
    const rows = [{ id: 'aaaaaaaaaaaa' }];
    expect(attachContainerResources(rows, new Map(), [])).toBe(rows);
  });
});
