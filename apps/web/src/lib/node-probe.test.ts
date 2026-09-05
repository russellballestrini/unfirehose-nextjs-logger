import { describe, it, expect } from 'vitest';
import {
  parseSection, parseCpuInfo, parseMeminfo, parseProcesses, parseNvidiaGpu,
  parseDisk, parseNetInterfaces, parseNetDev, parseDocker, parseProbeOutput,
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
