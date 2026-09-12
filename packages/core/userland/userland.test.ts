import { describe, it, expect } from 'vitest';
import { spawnSync } from 'child_process';
import { buildProbeScript, USERLANDS, POWERSHELL_SCRIPT, userlandById } from './index';
import { CMD_SCRIPT } from './cmd';
import { translateRouterOS, translateCiscoIOS, translateFortiOS, routerosUptime, wordsUptime } from './network';
import { speakers, nextSpeakers } from './speakers';
import {
  readWire, parseWireProbe, sizeToGB, parseLoad, parseEtime, parseUptimeText,
  parseUptimeSeconds, parseSwap, parseMemory,
} from './parse';

/**
 * The userland probe: one Bourne-shell script for every machine an sshd
 * can put a shell on, and one reader for what they all say back.
 *
 * We cannot run FreeBSD, AIX or IRIX here. What we can pin is the two
 * halves of the contract separately: that the script is valid Bourne
 * shell and every branch runs to END on a box lacking its commands, and
 * that the reader turns each userland's own words — copied from real
 * machines and their manuals — into the same MeshNode.
 */

const script = buildProbeScript();
const sh = (name: string, args: string[], input: string) => spawnSync(name, args, { input, encoding: 'utf-8', timeout: 20000 });
const shells = ['dash', 'busybox', 'bash', 'sh'].filter(s => spawnSync('which', [s]).status === 0);

describe('buildProbeScript', () => {
  it('is Bourne shell every plugin can share: no $( ), no $(( )), no [[, no !, no local', () => {
    // Solaris 10 /bin/sh, HP-UX and AIX still run the 1979 shell.
    // The PowerShell here-doc inside windows-sh is not shell and is quoted.
    const bodies = (USERLANDS.map(u => u.body).join('\n') + script).replace(/<<'__UF_PS__'[\s\S]*?__UF_PS__/g, '');
    expect(bodies).not.toMatch(/(^|[^\\])\$\(/m);   // a \$( escaped for PowerShell is fine
    expect(bodies).not.toMatch(/\[\[/);
    expect(bodies).not.toMatch(/^\s*local\s/m);   // the builtin, not /usr/local
    expect(bodies).not.toMatch(/(^|[;\s])!\s/m);
    expect(bodies).not.toMatch(/command -v/);
  });

  it('parses under every POSIX shell on this box', () => {
    for (const s of shells) {
      const r = s === 'busybox' ? sh('busybox', ['sh', '-n'], script) : sh(s, ['-n'], script);
      expect(r.status, `${s} -n: ${r.stderr}`).toBe(0);
    }
  });

  it('runs to END on this machine and names its userland', () => {
    const r = sh('sh', [], script);
    expect(r.status).toBe(0);
    expect(r.stderr).toBe('');
    const w = readWire(r.stdout);
    expect(w.shellRan).toBe(true);
    expect(w.complete).toBe(true);
    expect(w.kv.userland).toMatch(/^linux-/);
    expect(parseInt(w.kv.nproc!)).toBeGreaterThan(0);
  });

  it('runs every plugin branch to END, silently, on a box that has none of its commands', () => {
    // A plugin that hangs or aborts on a missing tool would mark a whole
    // node unreachable — the failure this work exists to remove.
    const sysnames = USERLANDS.flatMap(u => u.sysnames).filter(s => s !== '*')
      .map(s => s.replace(/\*$/, '-10.0'));
    for (const name of [...sysnames, 'Interix', 'OS/390', 'NONSTOP_KERNEL', 'ULTRIX', 'A/UX', 'SerenityOS', 'Redox']) {
      const r = spawnSync('sh', [], { input: script, encoding: 'utf-8', timeout: 20000, env: { ...process.env, UF_SYSNAME: name } });
      expect(r.status, name).toBe(0);
      expect(r.stderr, name).toBe('');
      const w = readWire(r.stdout);
      expect(w.complete, name).toBe(true);
      expect(w.kv.os, name).toBe(name);
      expect(userlandById(w.kv.userland!), `${name} → ${w.kv.userland}`).toBeDefined();
    }
  }, 60000);

  it('routes each uname -s to the plugin that speaks its userland', () => {
    const pick = (name: string) => readWire(spawnSync('sh', [], { input: script, encoding: 'utf-8', env: { ...process.env, UF_SYSNAME: name } }).stdout).kv.userland;
    expect(pick('FreeBSD')).toBe('freebsd');
    expect(pick('GNU/kFreeBSD')).toBe('freebsd');
    expect(pick('SunOS')).toBe('sunos');
    expect(pick('OS400')).toBe('aix');
    expect(pick('MINGW64_NT-10.0')).toBe('cygwin');
    expect(pick('Windows NT')).toBe('windows-sh');
    expect(pick('Minix')).toBe('netbsd');
    expect(pick('NONSTOP_KERNEL')).toBe('generic');
  }, 30000);

  it('carries the same PowerShell for a Bourne shell on Windows as for none', () => {
    expect(userlandById('windows-sh')!.body).toContain(POWERSHELL_SCRIPT.trim().split('\n')[0]);
    expect(POWERSHELL_SCRIPT).toContain("'uf=1'");
    expect(POWERSHELL_SCRIPT.trim().endsWith("'END'")).toBe(true);
  });
});

describe('readWire', () => {
  it('separates keys, disks, harness rows, RAPL and GPU, and tolerates CRLF', () => {
    const w = readWire('uf=1\r\nos=Windows_NT\r\nDISK Samsung_SSD 0\r\nDISK disk1 ?\r\nHPROC - 4 0.0 1.2 100 50 ? R - 0:00 claude\r\nGPU 12.5, RTX, 24576, 100, 3\r\nRAPL 1 2 3 4 0.1\r\nEND\r\n');
    expect(w.shellRan).toBe(true);
    expect(w.complete).toBe(true);
    expect(w.kv.os).toBe('Windows_NT');
    expect(w.disks).toEqual([{ name: 'Samsung_SSD', rota: 0 }, { name: 'disk1', rota: null }]);
    expect(w.hprocs).toHaveLength(1);
    expect(w.gpu).toHaveLength(1);
    expect(w.rapl).toEqual([1, 2, 3, 4, 0.1]);
  });

  it('lets a later key overwrite an earlier one, and ignores lines that are not keys', () => {
    const w = readWire('uf=1\narch=x86_64\nsome noise here\narch=amd64\n');
    expect(w.kv.arch).toBe('amd64');
    expect(w.complete).toBe(false);
  });
});

describe('the interpreters', () => {
  it('reads a size in every unit a userland writes it', () => {
    expect(sizeToGB('17179869184 B')).toBeCloseTo(16, 3);
    expect(sizeToGB('32791234 kB')).toBeCloseTo(31.27, 1);
    expect(sizeToGB('16384 Megabytes')).toBe(16);
    expect(sizeToGB('8163 MB')).toBeCloseTo(7.97, 1);
    expect(sizeToGB('1024.00 M')).toBe(1);
    expect(sizeToGB('9012M')).toBeCloseTo(8.8, 1);
    expect(sizeToGB('512MB')).toBe(0.5);
    expect(sizeToGB('512 Mbytes')).toBe(0.5);
    expect(sizeToGB('2 4 6 pages', 4096)).toBeCloseTo(12 * 4096 / 1024 ** 3, 9);
    expect(sizeToGB('131072 pages', 8192)).toBe(1);
    // Unitless: bytes when huge, kilobytes otherwise.
    expect(sizeToGB('17179869184')).toBe(16);
    expect(sizeToGB('1048576')).toBe(1);
    expect(sizeToGB('')).toBe(0);
    expect(sizeToGB('n/a')).toBe(0);
  });

  it('reads a load average in every notation', () => {
    expect(parseLoad('0.52 0.41 0.38 1/900 12345')).toEqual([0.52, 0.41, 0.38]);
    expect(parseLoad('{ 0.48 0.41 0.37 }')).toEqual([0.48, 0.41, 0.37]);
    expect(parseLoad(undefined, ' 18:47:36 up  9:59,  1 user,  load average: 19.01, 15.17, 11.46')).toEqual([19.01, 15.17, 11.46]);
    expect(parseLoad(undefined, '10:00AM  up 12 days, 3:04, 2 users, load averages: 0.12 0.10 0.08')).toEqual([0.12, 0.1, 0.08]);
    // A German locale writes decimals with a comma.
    expect(parseLoad(undefined, 'load average: 0,52, 0,41, 0,38')).toEqual([0.52, 0.41, 0.38]);
    expect(parseLoad(undefined, undefined)).toEqual([0, 0, 0]);
  });

  it('reads init\'s elapsed time and the uptime sentence', () => {
    expect(parseEtime('   09:59:16')).toBe(9 * 3600 + 59 * 60 + 16);
    expect(parseEtime('123-04:05:06')).toBe(123 * 86400 + 4 * 3600 + 5 * 60 + 6);
    expect(parseEtime('05:06')).toBe(306);
    expect(parseEtime('')).toBeNull();
    expect(parseUptimeText(' 10:00  up 12 days,  3:04,  2 users')).toBe(12 * 86400 + 3 * 3600 + 4 * 60);
    expect(parseUptimeText(' 10:00  up 5 mins, 1 user')).toBe(300);
    expect(parseUptimeText(' 10:00  up 1 day, 2 hrs, 3 mins')).toBe(86400 + 7200 + 180);
    expect(parseUptimeText(' 10:00  up 3:04, 1 user')).toBe(3 * 3600 + 4 * 60);
    expect(parseUptimeText('no uptime here')).toBeNull();
  });

  it('derives uptime from whichever the userland could say, using the remote clock', () => {
    const now = '1789253256';
    expect(parseUptimeSeconds({ uptime_s: '35957.30' })).toBe(35957.3);
    expect(parseUptimeSeconds({ now, boottime: '{ sec = 1789217299, usec = 123 } Sat Sep 12' })).toBe(35957);
    expect(parseUptimeSeconds({ now, boottime: '1789217299' })).toBe(35957);
    expect(parseUptimeSeconds({ now, boottime: '20260912084819.500000+000' })).toBe(1789253256 - Date.UTC(2026, 8, 12, 8, 48, 19) / 1000);
    expect(parseUptimeSeconds({ now, boottime: 'Sep 12 08:48:19 UTC 2026' })).toBe(1789253256 - Date.parse('Sep 12 08:48:19 UTC 2026') / 1000);
    expect(parseUptimeSeconds({ etime1: '2-01:00:00' })).toBe(2 * 86400 + 3600);
    expect(parseUptimeSeconds({ uptime_raw: ' 10:00 up 2 days, 1:00, 3 users' })).toBe(2 * 86400 + 3600);
    expect(parseUptimeSeconds({})).toBe(0);
  });

  it('reads swap in every form', () => {
    expect(parseSwap({ swap_total: '8000000 kB', swap_free: '7000000 kB' }).usedGB).toBeCloseTo(0.95, 1);
    expect(parseSwap({ swap_total: '2048 MB', swap_used: '512 MB' })).toEqual({ totalGB: 2, usedGB: 0.5 });
    expect(parseSwap({ swap_raw: 'total = 2048.00M  used = 1077.31M  free = 970.69M' }).usedGB).toBeCloseTo(1.05, 1);
    expect(parseSwap({ swap_raw: 'total: 1048576 1K-blocks allocated, 262144 used, 786432 available' })).toEqual({ totalGB: 1, usedGB: 0.25 });
    const sol = parseSwap({ swap_raw: 'total: 1234k bytes allocated + 456k reserved = 1690k used, 1048576k available' });
    expect(sol.totalGB).toBeCloseTo(1.0016, 2);
    expect(parseSwap({ swap_raw: 'total    2048    1024    1024   50%    -    0    -' })).toEqual({ totalGB: 2, usedGB: 1 });
    expect(parseSwap({ swap_raw: '      512MB               1%' })).toEqual({ totalGB: 0.5, usedGB: 0.005 });
    const tru = parseSwap({ swap_raw: 'Allocated space: 262144 pages (2048MB) Available space: 131072 pages (1024MB)' });
    expect(tru).toEqual({ totalGB: 2, usedGB: 1 });
    expect(parseSwap({})).toEqual({ totalGB: 0, usedGB: 0 });
  });

  it('reads memory from a pre-3.14 Linux, a Haiku and a QNX', () => {
    const old = parseMemory({ mem_total: '1048576 kB', mem_free: '100000 kB', mem_buffers: '50000 kB', mem_cached: '150000 kB' });
    expect(old.availableGB).toBeCloseTo(300000 / 1024 ** 2, 6);
    const haiku = parseMemory({ mem_raw: '4177920 bytes free (used/max 4211789824 / 8389709824)' });
    expect(haiku.totalGB).toBeCloseTo(7.81, 1);
    expect(haiku.availableGB).toBeCloseTo(3.89, 1);
    const qnx = parseMemory({ mem_raw: '2.5GB/8GB' });
    expect(qnx).toEqual({ totalGB: 8, availableGB: 2.5 });
  });
});

/**
 * One fixture per userland: what its plugin writes, copied from the
 * commands' documented output. Each must come out as a node with cores,
 * memory, load and uptime — the four numbers a card cannot do without.
 */
const wire = (lines: string[]) => ['uf=1', ...lines, 'END'].join('\n');
const FIXTURES: Record<string, string[]> = {
  freebsd: [
    'os=FreeBSD', 'userland=freebsd', 'hostname=bsd.example.net', 'now=1789253256', 'arch=amd64',
    'nproc=8', 'cpu=Intel(R) Xeon(R) CPU E5-2650 v2 @ 2.60GHz', 'pagesize=4096',
    'mem_total=34359738368 B', 'mem_avail=1000000 2000000 0 pages',
    'swap_total=8388608 kB', 'swap_used=0 kB',
    'load={ 0.48 0.41 0.37 }', 'boottime={ sec = 1789217299, usec = 1 } Sat Sep 12 08:48:19 2026',
    'DISK ada0 1', 'DISK nvd0 0',
    'HPROC fox 1234 2.0 1.0 123456 65432 -  S    09:00   0:12 /usr/local/bin/claude',
  ],
  openbsd: [
    'os=OpenBSD', 'userland=openbsd', 'hostname=puffy', 'now=1789253256', 'arch=amd64',
    'nproc=4', 'cpu=Intel(R) Core(TM) i5-3320M CPU @ 2.60GHz', 'pagesize=4096',
    'mem_total=16777216000 B', 'mem_avail=9012M',
    'swap_raw=total: 1048576 1K-blocks allocated, 0 used, 1048576 available',
    'load=0.20 0.19 0.18', 'boottime=1789217299', 'DISK sd0 ?',
  ],
  netbsd: [
    'os=NetBSD', 'userland=netbsd', 'hostname=daemon', 'now=1789253256', 'arch=amd64',
    'nproc=2', 'cpu=AMD Ryzen 5 5600G with Radeon Graphics', 'pagesize=4096',
    'mem_total=8589934592 B', 'mem_avail=500M',
    'swap_raw=total: 524288 1K-blocks allocated, 1024 used, 523264 available',
    'load=0.10 0.05 0.01', 'boottime=1789217299', 'DISK wd0 ?',
  ],
  darwin: [
    'os=Darwin', 'userland=darwin', 'hostname=mbp.local', 'now=1789253256', 'arch=arm64', 'osrel=23.4.0',
    'nproc=10', 'cpu=Apple M2 Pro', 'pagesize=16384', 'model=Mac14,9',
    'mem_total=17179869184 B', 'mem_avail=200000 pages',
    'swap_raw=total = 2048.00M  used = 1077.31M  free = 970.69M',
    'load={ 1.53 1.62 1.64 }', 'boottime={ sec = 1789217299, usec = 0 } Sat Sep 12 08:48:19 2026',
    'DISK disk0 0',
  ],
  sunos: [
    'os=SunOS', 'userland=sunos', 'hostname=sol.example.net', 'now=1789253256', 'arch=i86pc', 'isa=amd64',
    'nproc=16', 'cpu=Intel(r) Xeon(r) CPU E5-2650 v2 @ 2.60GHz', 'pagesize=4096',
    'mem_total=16384 Megabytes', 'mem_avail=1000000 pages',
    'swap_raw=total: 1234k bytes allocated + 456k reserved = 1690k used, 7890000k available',
    'uptime_raw=  6:47pm  up 37 days, 9:21,  2 users,  load average: 0.12, 0.10, 0.08',
    'boottime=1786026000', 'DISK c0t0d0 0', 'DISK c0t1d0 1',
  ],
  aix: [
    'os=AIX', 'userland=aix', 'hostname=lpar1', 'osrel=3', 'arch=00F6E6E64C00', 'isa=powerpc',
    'nproc=8', 'cpu=PowerPC_POWER8 @ 3425 MHz', 'pagesize=4096',
    'mem_total=16384 MB', 'mem_avail=500000 pages',
    'swap_raw=      512MB               1%',
    'etime1=  37-09:21:00',
    'uptime_raw=  06:47PM   up 37 days,   9:21,  1 user,  load average: 1.20, 1.10, 1.00',
    'DISK hdisk0 ?', 'DISK hdisk1 ?',
  ],
  'hp-ux': [
    'os=HP-UX', 'userland=hp-ux', 'hostname=rx2660', 'arch=ia64',
    'nproc=4', 'cpu=Intel(R) Itanium 2 9000 series processor', 'pagesize=4096',
    'mem_total=8163 MB', 'mem_avail=200000 pages',
    'swap_raw=total       4096    1024    3072   25%       -       0    -',
    'etime1=12-00:30:00', 'uptime_raw=  6:47pm  up 12 days, 30 mins,  1 user,  load average: 0.50, 0.40, 0.30',
    'DISK disk3 ?',
  ],
  irix: [
    'os=IRIX64', 'userland=irix', 'hostname=octane', 'arch=IP30',
    'nproc=2', 'cpu=MIPS R12000 Processor Chip Revision: 3.5', 'pagesize=16384',
    'mem_total=1024 Mbytes', 'mem_avail=10000 pages',
    'swap_raw=total: 0 allocated + 0 reserved = 0 used, 524288 available',
    'uptime_raw=  6:47pm  up 100 days, 1:00,  1 user,  load average: 0.05, 0.03, 0.01',
    'DISK dks1 1',
  ],
  osf1: [
    'os=OSF1', 'userland=osf1', 'hostname=alpha', 'arch=alpha',
    'nproc=2', 'cpu=The alpha EV6.7 (21264A) processor operates at 667 MHz,', 'pagesize=8192',
    'mem_total=1024.00 M', 'mem_avail=20000 pages',
    'swap_raw=Allocated space: 262144 pages (2048MB) Available space: 131072 pages (1024MB)',
    'etime1=5-00:00:00', 'uptime_raw= 6:47pm  up 5 days,  0 mins,  1 user,  load average: 0.20, 0.10, 0.00',
  ],
  sco: [
    'os=UnixWare', 'userland=sco', 'hostname=uw7', 'arch=i386',
    'nproc=1', 'cpu=Pentium III', 'mem_total=536870912 B', 'mem_avail=20000 pages', 'pagesize=4096',
    'swap_raw=total: 0 allocated + 0 reserved = 0 used, 262144 available',
    'uptime_raw=  6:47pm  up 400 days, 3:00,  1 user,  load average: 0.01, 0.01, 0.00',
    'DISK c0b0t0d0 1',
  ],
  haiku: [
    'os=Haiku', 'userland=haiku', 'hostname=haiku', 'arch=x86_64',
    'nproc=4', 'cpu=Intel(R) Core(TM) i7-4790K CPU @ 4.00GHz',
    'mem_raw=4177920 bytes free (used/max 4211789824 / 8389709824)',
    'uptime_raw=up 1 day, 2:03',
  ],
  qnx: [
    'os=QNX', 'userland=qnx', 'hostname=qnxbox', 'arch=x86pc', 'now=1789253256',
    'nproc=2', 'cpu=Intel Core i5 @ 2.6GHz', 'mem_raw=2.5GB/8GB',
    'boottime=Sep 12 08:48:19 UTC 2026', 'DISK hd0 ?',
  ],
  cygwin: [
    'os=CYGWIN_NT-10.0', 'userland=cygwin', 'hostname=winbox', 'arch=x86_64',
    'nproc=8', 'cpu=model name\t: Intel(R) Core(TM) i7-8650U CPU @ 1.90GHz',
    'mem_total=16000000 kB', 'mem_avail=8000000 kB', 'swap_total=2000000 kB', 'swap_free=2000000 kB',
    'load=0.10 0.20 0.30 1/200 100', 'uptime_s=12345.67', 'DISK Samsung_SSD_970 0',
  ],
  'windows-powershell': [
    'os=Windows_NT', 'userland=windows-powershell', 'hostname=WINBOX', 'now=1789253256',
    'osrel=Microsoft Windows 11 Pro 10.0.22631', 'cpu=Intel(R) Core(TM) i9-14900K', 'nproc=32', 'arch=AMD64',
    'mem_total=65000000 kB', 'mem_avail=30000000 kB', 'swap_total=8192 MB', 'swap_used=512 MB',
    'uptime_s=703781', 'load=1.6 1.6 1.6', 'DISK Samsung_SSD_990 0', 'DISK WDC_WD40EFRX 1',
    'HPROC - 4242 0.0 1.5 500000 250000 ? R - 0:00 C:\\Users\\fox\\AppData\\Local\\Programs\\claude\\claude.exe',
  ],
  'windows-sh': [
    'os=Windows_NT', 'userland=windows-sh', 'hostname=OLDBOX', 'arch=x86',
    'nproc=2', 'cpu=Intel(R) Pentium(R) 4 CPU 3.00GHz', 'mem_total=1048000 kB', 'mem_avail=400000 kB',
    'swap_total=1536 MB', 'swap_used=100 MB', 'boottime=20260912084819.500000+000', 'now=1789253256', 'DISK disk0 ?',
  ],
  'linux-busybox': [
    'os=Linux', 'userland=linux-busybox', 'hostname=router', 'arch=mips', 'osrel=5.15.0',
    'nproc=2', 'cpu=system type\t\t: MediaTek MT7621 ver:1 eco:3', 'mem_total=253000 kB', 'mem_avail=180000 kB',
    'swap_total=0 kB', 'swap_free=0 kB', 'load=0.15 0.10 0.05 1/80 900', 'uptime_s=86400.00',
    'HPROC root 900 0.0 0.0 0 0 ? S - 0:00 /usr/bin/python3 /usr/bin/unclose',
  ],
  'linux-android': [
    'os=Linux', 'userland=linux-android', 'hostname=localhost', 'arch=aarch64', 'osrel=Android 14 (5.15.94)',
    'nproc=8', 'cpu=Hardware\t: Qualcomm Technologies, Inc SM8550', 'model=Pixel 8', 'soc=SM8550',
    'mem_total=7800000 kB', 'mem_avail=3000000 kB', 'swap_total=4000000 kB', 'swap_free=3500000 kB',
    'load=5.1 4.8 4.2 3/1400 20000', 'uptime_s=200000.0', 'DISK sda 0',
  ],
  'gnu-hurd': [
    'os=GNU', 'userland=gnu-hurd', 'hostname=hurd', 'arch=i686-AT386', 'nproc=1',
    'cpu=model name\t: Intel(R) Core(TM)2 Duo CPU     E8400  @ 3.00GHz',
    'mem_total=2000000 kB', 'mem_avail=1500000 kB', 'load=0.00 0.01 0.05 1/40 200', 'uptime_s=3600.00', 'DISK hd0 ?',
  ],
  generic: [
    'os=OS/390', 'userland=generic', 'hostname=zos', 'arch=2097', 'nproc=4', 'cpu=2097',
    'uptime_raw= 06:47PM  up 300 days, 12:00,  5 users,  load average: 2.00, 2.00, 2.00',
  ],
  esxi: [
    'os=VMkernel', 'userland=esxi', 'kind=hypervisor', 'hostname=esx1.lab', 'arch=x86_64', 'osrel=VMware ESXi 8.0.2 build-22380479',
    'uptime_raw= 18:47:36 up 45 days, 03:12:01, load average: 0.12, 0.10, 0.08',
    'nproc=16', 'cpu=Intel(R) Xeon(R) CPU E5-2650 v2 @ 2.60GHz', 'model=ProLiant DL380p Gen8',
    'mem_total=68719476736 Bytes', 'mem_avail=12345678 KB', 'vms=7',
    'DISK naa.600508b1001c 1', 'DISK t10.NVMe____Samsung 0',
  ],
  'windows-cmd': [
    'os=Windows_NT', 'userland=windows-cmd', 'hostname=XPBOX', 'nproc=2', 'arch=x86',
    'cpu=Intel(R) Pentium(R) 4 CPU 3.00GHz\r', 'osrel=Microsoft Windows XP Professional\r',
    'mem_total=1047276\r kB', 'mem_avail=412300\r kB', 'boottime=20260901084819.500000-240\r',
    'swap_total=1536\r MB', 'swap_used=100\r MB', 'cpu_pct=12\r', 'DISK disk0\r ?',
  ],
  routeros: [
    'os=RouterOS', 'userland=routeros', 'kind=network', 'hostname=core-router', 'osrel=7.15.3 (stable)',
    'model=hAP ac2', 'arch=arm', 'cpu=ARMv7 @ 896MHz', 'nproc=4', 'mem_total=256.0MiB', 'mem_avail=200.0MiB',
    'cpu_pct=5', 'uptime_s=788645',
  ],
  'cisco-ios': [
    'os=IOS', 'userland=cisco-ios', 'kind=network', 'hostname=sw-core', 'osrel=IOS 15.2(4)E10', 'model=WS-C3750X-48P-S',
    'cpu=PowerPC405', 'nproc=1', 'mem_total=268435456 B', 'mem_avail=58024000 B', 'cpu_pct=4', 'uptime_s=33091500',
  ],
  fortios: [
    'os=FortiOS', 'userland=fortios', 'kind=network', 'hostname=fw1', 'model=FortiGate-60F', 'osrel=FortiOS 7.0.12',
    'nproc=2', 'mem_total=1998772 kB', 'mem_avail=791208 kB', 'cpu_pct=5', 'uptime_s=1047840',
  ],
};

describe('every userland comes out as a node', () => {
  for (const [id, lines] of Object.entries(FIXTURES)) {
    it(`${id}: ${userlandById(id)?.label ?? id}`, () => {
      expect(userlandById(id), `plugin ${id} exists`).toBeDefined();
      const n = parseWireProbe('probe-host', wire(lines));
      expect(n.reachable).toBe(true);
      expect(n.userland).toBe(id);
      expect(n.os).toBe(lines.find(l => l.startsWith('os='))!.slice(3));
      expect(n.cpuCores, 'cores').toBeGreaterThan(0);
      if (id !== 'generic') expect(n.memTotalGB, 'memory').toBeGreaterThan(0);
      expect(n.kind).toBe(lines.find(l => l.startsWith('kind='))?.slice(5) ?? 'compute');
      expect(n.uptimeSeconds, 'uptime').toBeGreaterThan(0);
      // Haiku has no load average; QNX and wmic-era Windows do not report one.
      expect(n.loadAvg!.some(x => x > 0) || ['haiku', 'qnx', 'windows-sh'].includes(id), 'load').toBe(true);
      expect(n.truncated).toBeUndefined();
    });
  }

  it('reads the details that only some userlands carry', () => {
    const bsd = parseWireProbe('h', wire(FIXTURES.freebsd!));
    expect(bsd.memTotalGB).toBe(32);
    expect(bsd.memAvailableGB).toBeCloseTo(3000000 * 4096 / 1024 ** 3, 1);
    expect(bsd.uptimeSeconds).toBe(35957);
    expect(bsd.spinningDisks).toBe(1);
    expect(bsd.ssdCount).toBe(1);
    expect(bsd.claudeProcesses).toBe(1);
    expect(bsd.cpuTdpWatts).toBe(95);
    expect(bsd.powerSource).toBe('tdp');

    const sol = parseWireProbe('h', wire(FIXTURES.sunos!));
    expect(sol.arch).toBe('amd64');            // isainfo -k over uname -m
    expect(sol.memTotalGB).toBe(16);
    expect(sol.loadAvg).toEqual([0.12, 0.1, 0.08]);  // from the uptime sentence
    expect(sol.swapTotalGB).toBeCloseTo(7.53, 1);

    const aix = parseWireProbe('h', wire(FIXTURES.aix!));
    expect(aix.uptimeSeconds).toBe(37 * 86400 + 9 * 3600 + 21 * 60); // init's etime
    expect(aix.cpuTdpWatts).toBe(190);         // POWER8
    expect(aix.spinningDisks).toBe(2);         // unknown rotation counts as spinning

    const mac = parseWireProbe('h', wire(FIXTURES.darwin!));
    expect(mac.memAvailableGB).toBeCloseTo(200000 * 16384 / 1024 ** 3, 1);
    expect(mac.cpuTdpWatts).toBe(30);
    expect(mac.swapUsedGB).toBeCloseTo(1.1, 1);

    const win = parseWireProbe('h', wire(FIXTURES['windows-powershell']!));
    expect(win.claudeProcesses).toBe(1);       // claude.exe by its path
    expect(win.spinningDisks).toBe(1);
    expect(win.osRelease).toContain('Windows 11');

    const hurd = parseWireProbe('h', wire(FIXTURES['gnu-hurd']!));
    expect(hurd.cpuModel).toContain('E8400');  // the cpuinfo line was unwrapped
    expect(hurd.cpuYear).toBe(2008);

    const esx = parseWireProbe('h', wire(FIXTURES.esxi!));
    expect(esx.kind).toBe('hypervisor');
    expect(esx.vms).toBe(7);
    expect(esx.memTotalGB).toBe(64);
    expect(esx.spinningDisks).toBe(1);
    expect(esx.loadAvg).toEqual([0.12, 0.1, 0.08]);   // busybox uptime's own line

    const xp = parseWireProbe('h', wire(FIXTURES['windows-cmd']!));
    expect(xp.cpuModel).toContain('Pentium');       // the stray CRs from wmic are whitespace
    expect(xp.memTotalGB).toBeCloseTo(1.0, 1);
    expect(xp.loadAvg).toEqual([0.24, 0.24, 0.24]);  // 12% of 2 cores
    expect(xp.uptimeSeconds).toBeGreaterThan(0);

    const rb = parseWireProbe('h', wire(FIXTURES.routeros!));
    expect(rb.kind).toBe('network');
    expect(rb.powerWatts).toBe(20);                  // not a desktop's 65W
    expect(rb.memTotalGB).toBe(0.3);                 // 256MiB, at the one decimal a node carries
    expect(rb.loadAvg).toEqual([0.2, 0.2, 0.2]);     // 5% of 4
    expect(rb.uptime).toBe('9d 3h');

    const zos = parseWireProbe('h', wire(FIXTURES.generic!));
    expect(zos.cpuModel).toBeUndefined();      // uname -p echoing -m is not a model
    expect(zos.uptimeSeconds).toBe(300 * 86400 + 12 * 3600);
  });

  it('refuses output no shell produced, and flags a cut script', () => {
    expect(() => parseWireProbe('h', "'sh' is not recognized as an internal or external command")).toThrow(/no POSIX shell/);
    const cut = parseWireProbe('h', 'uf=1\nos=Linux\nuserland=linux-gnu\nnproc=4\n');
    expect(cut.truncated).toBe(true);
    expect(cut.cpuCores).toBe(4);
  });
});

describe('the speakers that are not shells', () => {
  it('cmd: prints the wire from stdin with no batch-file syntax', () => {
    expect(CMD_SCRIPT.startsWith('@echo off\r\n')).toBe(true);
    expect(CMD_SCRIPT).toContain('echo uf=1');
    expect(CMD_SCRIPT).toContain('userland=windows-cmd');
    expect(CMD_SCRIPT).not.toMatch(/%%[a-z]/);       // %%a is for .bat files; stdin wants %a
    expect(CMD_SCRIPT.trim().endsWith('exit')).toBe(true);
  });

  it('routeros: /system resource print becomes the wire', () => {
    const out = [
      '                   uptime: 1w2d3h4m5s', '                  version: 7.15.3 (stable)',
      '              free-memory: 200.0MiB', '             total-memory: 256.0MiB', '                      cpu: ARMv7',
      '                cpu-count: 4', '            cpu-frequency: 896MHz', '                 cpu-load: 5%',
      '          free-hdd-space: 10.0MiB', '         total-hdd-space: 16.0MiB', '        architecture-name: arm',
      '               board-name: hAP ac^2', '                 platform: MikroTik', '  name: core-router',
    ].join('\n');
    const w = translateRouterOS(out);
    expect(w).toContain('uf=1');
    expect(w).toContain('kind=network');
    expect(w).toContain('hostname=core-router');
    expect(w).toContain('cpu=ARMv7 @ 896MHz');
    expect(w).toContain('mem_total=256.0MiB');
    expect(w).toContain(`uptime_s=${604800 + 2 * 86400 + 3 * 3600 + 4 * 60 + 5}`);
    expect(translateRouterOS('bad command name sh')).toBe('');
    expect(routerosUptime('3d4h')).toBe(3 * 86400 + 4 * 3600);
  });

  it('cisco-ios: a show session becomes the wire', () => {
    const out = [
      'sw-core#terminal length 0', 'sw-core#show version',
      'Cisco IOS Software, C3750E Software (C3750E-UNIVERSALK9-M), Version 15.2(4)E10, RELEASE SOFTWARE (fc2)',
      'sw-core uptime is 1 year, 2 weeks, 3 days, 4 hours, 5 minutes',
      'cisco WS-C3750X-48P (PowerPC405) processor (revision W0) with 262144K bytes of memory.',
      'sw-core#show processes cpu | include CPU utilization',
      'CPU utilization for five seconds: 5%/0%; one minute: 4%; five minutes: 3%',
      'sw-core#show memory statistics',
      '                Head    Total(b)     Used(b)     Free(b)   Lowest(b)  Largest(b)',
      'Processor    3A5F1C0   123456000    65432000    58024000    50000000    40000000',
      'sw-core#show inventory', 'NAME: "1", DESCR: "WS-C3750X-48P"', 'PID: WS-C3750X-48P-S     , VID: V05  , SN: FDO1',
      'sw-core#exit',
    ].join('\r\n');
    const w = translateCiscoIOS(out);
    expect(w).toContain('userland=cisco-ios');
    expect(w).toContain('hostname=sw-core');
    expect(w).toContain('osrel=IOS 15.2(4)E10');
    expect(w).toContain('model=WS-C3750X-48P-S');
    expect(w).toContain('cpu=PowerPC405');
    expect(w).toContain('mem_total=123456000 B');
    expect(w).toContain('mem_avail=58024000 B');
    expect(w).toContain('cpu_pct=4');
    expect(w).toContain(`uptime_s=${wordsUptime('1 year, 2 weeks, 3 days, 4 hours, 5 minutes')}`);
    expect(translateCiscoIOS('% Invalid input detected')).toBe('');
  });

  it('fortios: get system status becomes the wire', () => {
    const out = ['Version: FortiGate-60F v7.0.12,build0523,230425 (GA)', 'Hostname: fw1',
      'CPU states: 3% user 2% system 0% nice 95% idle 0% iowait 0% irq 0% softirq',
      'Memory: 1998772k total, 1207564k used (60%), 791208k free (40%)', 'Uptime: 12 days,  3 hours,  4 minutes'].join('\n');
    const w = translateFortiOS(out);
    expect(w).toContain('userland=fortios');
    expect(w).toContain('model=FortiGate-60F');
    expect(w).toContain('osrel=FortiOS 7.0.12');
    expect(w).toContain('cpu_pct=5');
    expect(w).toContain('nproc=1');
    expect(w).toContain('mem_avail=791208 kB');
    expect(w).toContain(`uptime_s=${12 * 86400 + 3 * 3600 + 4 * 60}`);
  });

  it('names the next speaker from what the last one was told', () => {
    const all = speakers();
    const sh = all[0]!;
    expect(nextSpeakers(all, sh, "'sh' is not recognized as an internal or external command").map(s => s.id)).toEqual(['powershell', 'pwsh', 'cmd']);
    expect(nextSpeakers(all, sh, 'sh: not found').map(s => s.id)).toEqual(['busybox-sh', 'bash', 'ksh']);
    expect(nextSpeakers(all, sh, 'bad command name sh').map(s => s.id)).toEqual(['junos', 'eos', 'nxos', 'routeros', 'cisco-ios', 'fortios']);
    expect(nextSpeakers(all, sh, 'Connection refused')).toEqual([]);
    // Every speaker that has not met a real device says so.
    for (const s of all.filter(s => !s.verified)) expect(['junos', 'eos', 'nxos', 'routeros', 'cisco-ios', 'fortios']).toContain(s.id);
  });
});
