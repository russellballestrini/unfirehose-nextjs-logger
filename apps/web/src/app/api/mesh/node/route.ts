import { NextRequest, NextResponse } from 'next/server';
import { execSync } from 'child_process';

/* eslint-disable @typescript-eslint/no-explicit-any */

/**
 * Deep probe a single mesh node — returns ps aux, GPU info, CPU details,
 * disk usage, network interfaces, temperatures, and per-process resource usage.
 *
 * GET /api/mesh/node?host=localhost
 * GET /api/mesh/node?host=cammy.foxhop.net
 */

const PROBE_SCRIPT = `
# --- hostname ---
echo '===SECTION:HOSTNAME==='
hostname

# --- cpu info ---
echo '===SECTION:CPUINFO==='
head -30 /proc/cpuinfo 2>/dev/null || echo 'n/a'

# --- cpu arch ---
echo '===SECTION:ARCH==='
uname -m 2>/dev/null || echo 'n/a'

# --- kernel ---
echo '===SECTION:KERNEL==='
uname -r 2>/dev/null || echo 'n/a'

# --- os ---
echo '===SECTION:OS==='
cat /etc/os-release 2>/dev/null | head -5 || echo 'n/a'

# --- nproc ---
echo '===SECTION:NPROC==='
nproc 2>/dev/null || echo '0'

# --- meminfo ---
echo '===SECTION:MEMINFO==='
cat /proc/meminfo 2>/dev/null || echo 'n/a'

# --- loadavg ---
echo '===SECTION:LOADAVG==='
cat /proc/loadavg 2>/dev/null || echo '0 0 0 0/0 0'

# --- uptime ---
echo '===SECTION:UPTIME==='
cat /proc/uptime 2>/dev/null || echo '0 0'

# --- disk ---
echo '===SECTION:DISK==='
df -h --output=source,size,used,avail,pcent,target 2>/dev/null | grep -E '^(/dev|tmpfs)' || echo 'n/a'

# --- processes (top CPU consumers) ---
echo '===SECTION:PS==='
ps aux --sort=-%cpu 2>/dev/null | grep -v '===SECTION:' | head -50 || echo 'n/a'

# --- claude processes specifically ---
echo '===SECTION:CLAUDE_PS==='
ps aux 2>/dev/null | grep -i '[c]laude' | grep -v '===SECTION:' || echo 'none'

# --- GPU nvidia ---
echo '===SECTION:NVIDIA==='
nvidia-smi --query-gpu=index,name,temperature.gpu,utilization.gpu,utilization.memory,memory.total,memory.used,memory.free,power.draw,power.limit,fan.speed,pstate --format=csv,noheader,nounits 2>/dev/null || echo 'none'

# --- GPU nvidia processes ---
echo '===SECTION:NVIDIA_PS==='
nvidia-smi --query-compute-apps=pid,process_name,used_memory --format=csv,noheader,nounits 2>/dev/null || echo 'none'

# --- GPU AMD ---
echo '===SECTION:AMD_GPU==='
rocm-smi --showtemp --showuse --showmemuse --showpower --showfan --csv 2>/dev/null || echo 'none'

# --- temperatures ---
echo '===SECTION:TEMPS==='
cat /sys/class/thermal/thermal_zone*/temp 2>/dev/null | head -10 || echo 'none'
cat /sys/class/thermal/thermal_zone*/type 2>/dev/null | head -10 || echo ''

# --- network interfaces ---
echo '===SECTION:NET==='
ip -brief addr 2>/dev/null | head -20 || ifconfig 2>/dev/null | head -40 || echo 'n/a'

# --- network throughput snapshot ---
echo '===SECTION:NETSTAT==='
cat /proc/net/dev 2>/dev/null | tail -n +3 || echo 'n/a'

# --- io stats ---
echo '===SECTION:IOSTAT==='
cat /proc/diskstats 2>/dev/null | head -20 || echo 'n/a'

# --- docker/containers ---
echo '===SECTION:DOCKER==='
docker ps --format '{{.ID}}\t{{.Names}}\t{{.Image}}\t{{.Status}}\t{{.Ports}}' 2>/dev/null | head -20 || echo 'none'

# --- tmux sessions ---
echo '===SECTION:TMUX==='
tmux list-sessions 2>/dev/null || echo 'none'

# --- screen sessions ---
echo '===SECTION:SCREEN==='
screen -ls 2>/dev/null | grep -E '^\s+\d+' || echo 'none'

echo '===SECTION:END==='
`.trim();

const SECTION_MARKERS = [
  'HOSTNAME', 'CPUINFO', 'ARCH', 'KERNEL', 'OS', 'NPROC', 'MEMINFO',
  'LOADAVG', 'UPTIME', 'DISK', 'PS', 'CLAUDE_PS', 'NVIDIA', 'NVIDIA_PS',
  'AMD_GPU', 'TEMPS', 'NET', 'NETSTAT', 'IOSTAT', 'DOCKER', 'TMUX', 'SCREEN', 'END',
];

function parseSection(output: string, marker: string): string {
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

function parseCpuInfo(raw: string) {
  const model = raw.match(/model name\s*:\s*(.+)/i)?.[1]?.trim() ?? 'Unknown';
  const mhz = raw.match(/cpu MHz\s*:\s*([\d.]+)/i)?.[1];
  const cacheSize = raw.match(/cache size\s*:\s*(.+)/i)?.[1]?.trim();
  return { model, mhz: mhz ? parseFloat(mhz) : undefined, cacheSize };
}

function parseMeminfo(raw: string) {
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

function parseProcesses(raw: string) {
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

function parseClaudeProcesses(raw: string) {
  if (!raw || raw === 'none') return [];
  return raw.split('\n').filter(l => l.trim()).map(line => {
    const parts = line.trim().split(/\s+/);
    if (parts.length < 11) return null;
    return {
      user: parts[0],
      pid: parseInt(parts[1]),
      cpu: parseFloat(parts[2]),
      mem: parseFloat(parts[3]),
      rss: parseInt(parts[5]),
      start: parts[8],
      time: parts[9],
      command: parts.slice(10).join(' '),
    };
  }).filter(Boolean);
}

function parseNvidiaGpu(raw: string) {
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

function parseNvidiaProcesses(raw: string) {
  if (!raw || raw === 'none') return [];
  return raw.split('\n').filter(l => l.trim()).map(line => {
    const p = line.split(',').map(s => s.trim());
    if (p.length < 3) return null;
    return { pid: parseInt(p[0]), name: p[1], memMB: parseFloat(p[2]) || 0 };
  }).filter(Boolean);
}

function parseAmdGpu(raw: string) {
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

function parseDisk(raw: string) {
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

function parseTemperatures(raw: string) {
  if (!raw || raw === 'none') return [];
  const lines = raw.split('\n').filter(l => l.trim());
  // First half is temps (millidegrees), second half is zone types
  const mid = Math.ceil(lines.length / 2);
  const temps = lines.slice(0, mid).map(l => parseFloat(l) / 1000);
  const types = lines.slice(mid);
  return temps.map((t, i) => ({
    zone: types[i] ?? `zone${i}`,
    tempC: round(t),
  }));
}

function parseNetInterfaces(raw: string) {
  if (!raw || raw === 'n/a') return [];
  return raw.split('\n').filter(l => l.trim()).map(line => {
    const parts = line.trim().split(/\s+/);
    return { name: parts[0], state: parts[1], addrs: parts.slice(2).join(' ') };
  });
}

function parseNetDev(raw: string) {
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

function parseDocker(raw: string) {
  if (!raw || raw === 'none') return [];
  return raw.split('\n').filter(l => l.trim()).map(line => {
    const parts = line.split('\t');
    if (parts.length < 5) return null;
    return { id: parts[0], name: parts[1], image: parts[2], status: parts[3], ports: parts[4] };
  }).filter(Boolean);
}

function parseTmux(raw: string) {
  if (!raw || raw === 'none') return [];
  return raw.split('\n').filter(l => l.trim()).map(line => {
    const m = line.match(/^(\S+):\s+(\d+)\s+window/);
    return m ? { name: m[1], windows: parseInt(m[2]) } : null;
  }).filter(Boolean);
}

function parseScreen(raw: string) {
  if (!raw || raw === 'none') return [];
  return raw.split('\n').filter(l => l.trim()).map(line => {
    const m = line.trim().match(/^(\d+)\.(\S+)/);
    return m ? { pid: m[1], name: m[2] } : null;
  }).filter(Boolean);
}

function probeLocal(): string {
  try {
    return execSync(`bash -c '${PROBE_SCRIPT.replace(/'/g, "'\\''")}'`, {
      encoding: 'utf-8',
      timeout: 15000,
    });
  } catch (e: any) {
    return e.stdout ?? '';
  }
}

function probeRemote(host: string): string {
  try {
    return execSync(
      `ssh -o ConnectTimeout=5 -o StrictHostKeyChecking=no ${host} 'bash -s' << 'PROBE_EOF'\n${PROBE_SCRIPT}\nPROBE_EOF`,
      { encoding: 'utf-8', timeout: 20000, shell: '/bin/bash' }
    );
  } catch (e: any) {
    return e.stdout ?? '';
  }
}

function parseProbeOutput(raw: string, host: string) {
  const hostname = parseSection(raw, 'HOSTNAME') || host;
  const cpuInfo = parseCpuInfo(parseSection(raw, 'CPUINFO'));
  const arch = parseSection(raw, 'ARCH') || 'unknown';
  const kernel = parseSection(raw, 'KERNEL') || 'unknown';
  const osRaw = parseSection(raw, 'OS');
  const osName = osRaw.match(/PRETTY_NAME="?([^"\n]+)"?/)?.[1] ?? 'Linux';
  const cpuCores = parseInt(parseSection(raw, 'NPROC')) || 0;
  const memory = parseMeminfo(parseSection(raw, 'MEMINFO'));

  const loadRaw = parseSection(raw, 'LOADAVG').split(/\s+/);
  const loadAvg = [parseFloat(loadRaw[0]) || 0, parseFloat(loadRaw[1]) || 0, parseFloat(loadRaw[2]) || 0];
  const runnable = loadRaw[3] ?? '0/0';

  const uptimeRaw = parseSection(raw, 'UPTIME').split(/\s+/);
  const uptimeSeconds = parseFloat(uptimeRaw[0]) || 0;

  const disk = parseDisk(parseSection(raw, 'DISK'));
  const processes = parseProcesses(parseSection(raw, 'PS'));
  const claudeProcesses = parseClaudeProcesses(parseSection(raw, 'CLAUDE_PS'));
  const nvidiaGpus = parseNvidiaGpu(parseSection(raw, 'NVIDIA'));
  const nvidiaProcesses = parseNvidiaProcesses(parseSection(raw, 'NVIDIA_PS'));
  const amdGpus = parseAmdGpu(parseSection(raw, 'AMD_GPU'));
  const temperatures = parseTemperatures(parseSection(raw, 'TEMPS'));
  const netInterfaces = parseNetInterfaces(parseSection(raw, 'NET'));
  const netDev = parseNetDev(parseSection(raw, 'NETSTAT'));
  const docker = parseDocker(parseSection(raw, 'DOCKER'));
  const tmuxSessions = parseTmux(parseSection(raw, 'TMUX'));
  const screenSessions = parseScreen(parseSection(raw, 'SCREEN'));

  return {
    hostname,
    reachable: !!hostname,
    system: { arch, kernel, os: osName, cpuModel: cpuInfo.model, cpuMhz: cpuInfo.mhz, cpuCache: cpuInfo.cacheSize, cpuCores },
    memory,
    loadAvg,
    runnable,
    uptimeSeconds,
    disk,
    processes,
    claudeProcesses,
    gpu: {
      nvidia: nvidiaGpus,
      nvidiaProcesses,
      amd: amdGpus,
      hasGpu: nvidiaGpus.length > 0 || amdGpus.length > 0,
    },
    temperatures,
    network: { interfaces: netInterfaces, throughput: netDev },
    containers: docker,
    sessions: { tmux: tmuxSessions, screen: screenSessions },
    probedAt: new Date().toISOString(),
  };
}

export async function GET(req: NextRequest) {
  const host = req.nextUrl.searchParams.get('host');
  if (!host) {
    return NextResponse.json({ error: 'Missing host parameter' }, { status: 400 });
  }

  // Sanitize host to prevent command injection
  if (!/^[a-zA-Z0-9._-]+$/.test(host)) {
    return NextResponse.json({ error: 'Invalid host' }, { status: 400 });
  }

  // Detect if the requested host is actually localhost
  let isLocal = host === 'localhost';
  if (!isLocal) {
    try {
      const localHostname = execSync('hostname', { encoding: 'utf-8' }).trim();
      const localFqdn = execSync('hostname -f 2>/dev/null || echo ""', { encoding: 'utf-8' }).trim();
      isLocal = host === localHostname || host === localFqdn;
    } catch { /* ignore */ }
  }

  const raw = isLocal ? probeLocal() : probeRemote(host);

  if (!raw.includes('===SECTION:HOSTNAME===')) {
    return NextResponse.json({
      hostname: host,
      reachable: false,
      error: 'Probe failed — host unreachable or timed out',
      probedAt: new Date().toISOString(),
    });
  }

  return NextResponse.json(parseProbeOutput(raw, host));
}
